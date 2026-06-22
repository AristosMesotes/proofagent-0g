/**
 * mandateCard.test.ts -- the honesty + correctness invariants of the EXPANDED RAILS card (the read-only
 * mandate-registry mirror, design §2 Rails, §3 #2/#3/#5, §8, §10.4b).
 *
 * These lock the design's doctrine on the mandate card's PURE logic (the formatting + classification the
 * DOM renders) so a future edit cannot:
 *   - drift the exact-integer unit math (a float on the money path -- design §3 #5),
 *   - silently truncate money (more fractional digits than the asset's decimals),
 *   - classify an on-chain BLOCK as ALLOWED, or coerce an unreachable read into a verdict,
 *   - fabricate a verdict the chain's `(ok, reason)` did not return.
 *
 * Pure logic only (no DOM, no network) -- runs under `node --test` against the compiled `dist/` ESM,
 * fully offline. The DOM assembly is exercised by the build (`tsc`) + the offline-transport doubles below
 * driving the SAME `runMandateCheck` codec the card reads through.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  formatUnits,
  parseUnits,
  formatDuration,
  classifySim,
  SIM_VERDICT,
  DEPLOY_RECONCILE,
} from "./mandateCard.js";
import { runMandateCheck, OnChainReadError, type RpcTransport, type RpcReceipt, type RpcTx } from "./onchain.js";
import { MANDATE_CARD } from "./spine.js";

/* ------------------------------------------------------------------------------------------------ *
 * Offline transport double -- a recorded checkTransfer reply, exactly as the chain would answer.
 * ------------------------------------------------------------------------------------------------ */

/** A bytes32 ABI word of left-aligned ASCII for a reason tag (e.g. "OVER_TX_CAP" / "TOKEN_NOT_ALLOWED"). */
function reasonWord(tag: string): string {
  let hex = "";
  for (let i = 0; i < tag.length; i++) {
    hex += tag.charCodeAt(i).toString(16).padStart(2, "0");
  }
  return hex.padEnd(64, "0");
}

/** The `(ok=false, reason)` reply the deployed registry returns for a blocked probe. */
function blockedReply(reason: string): string {
  return "0x" + "0".repeat(64) + reasonWord(reason);
}

/** The `(ok=true, reason=OK)` reply — the allowed answer (the zero reason word). */
const OK_REPLY = "0x" + "0".repeat(63) + "1" + "0".repeat(64);

/** Build a read-only transport double from a fixed eth_call reply (or a forced failure). */
function ethCallDouble(reply: string | { fail: true }): RpcTransport {
  return {
    async ethCall(): Promise<string> {
      if (typeof reply === "object") throw new OnChainReadError("recorded RPC failure (eth_call)");
      return reply;
    },
    async getTransactionReceipt(): Promise<RpcReceipt | null> {
      throw new OnChainReadError("not used");
    },
    async getTransactionByHash(): Promise<RpcTx | null> {
      throw new OnChainReadError("not used");
    },
  };
}

/* ------------------------------------------------------------------------------------------------ *
 * formatUnits / parseUnits -- exact-integer money, no float, no silent truncation (design §3 #5).
 * ------------------------------------------------------------------------------------------------ */

test("formatUnits is exact-integer: raw wei -> whole units, trailing zeros trimmed, never a float", () => {
  assert.equal(formatUnits(2_000_000n, 18), "0.000000000002");
  assert.equal(formatUnits(1_000_000n, 6), "1");
  assert.equal(formatUnits(1_500_000n, 6), "1.5");
  assert.equal(formatUnits(0n, 6), "0");
  assert.equal(formatUnits(0n, 18), "0");
  // decimals 0 -> the raw integer verbatim.
  assert.equal(formatUnits(42n, 0), "42");
});

test("parseUnits is the exact inverse and REFUSES to silently truncate money", () => {
  assert.equal(parseUnits("1", 6), 1_000_000n);
  assert.equal(parseUnits("1.5", 6), 1_500_000n);
  assert.equal(parseUnits("0", 18), 0n);
  // A round-trip is exact.
  assert.equal(formatUnits(parseUnits("2.25", 6), 6), "2.25");
  // MORE fractional digits than the asset's decimals would TRUNCATE money -> a loud usage error, not a silent floor.
  assert.throws(() => parseUnits("1.1234567", 6), RangeError);
  // A non-numeric / negative amount is a usage error (mints no verdict).
  assert.throws(() => parseUnits("abc", 6), RangeError);
  assert.throws(() => parseUnits("-1", 6), RangeError);
  assert.throws(() => parseUnits("", 18), RangeError);
});

test("formatDuration renders a compact reset countdown (the period-cap window)", () => {
  assert.equal(formatDuration(3600), "1h 0m");
  assert.equal(formatDuration(90), "1m 30s");
  assert.equal(formatDuration(0), "0s");
  assert.equal(formatDuration(-1), "—");
});

/* ------------------------------------------------------------------------------------------------ *
 * classifySim -- the on-chain (ok, reason) becomes the tri-state verdict; a BLOCK is never an ALLOW.
 * ------------------------------------------------------------------------------------------------ */

test("classifySim: ok=true -> ALLOWED; ok=false -> BLOCKED with the binding reason NAMED (never softened)", () => {
  const allowed = classifySim(true, "OK");
  assert.equal(allowed.verdict, SIM_VERDICT.ALLOWED);

  const overCap = classifySim(false, "OVER_TX_CAP");
  assert.equal(overCap.verdict, SIM_VERDICT.BLOCKED);
  assert.match(overCap.binding, /per-transaction cap/i);

  const notAllowed = classifySim(false, "TOKEN_NOT_ALLOWED");
  assert.equal(notAllowed.verdict, SIM_VERDICT.BLOCKED);
  assert.match(notAllowed.binding, /allowlist/i);

  // An unknown reason still BLOCKS (fail-closed: never coerce an unrecognized reason into an allow).
  const unknown = classifySim(false, "SOME_NEW_REASON");
  assert.equal(unknown.verdict, SIM_VERDICT.BLOCKED);
});

/* ------------------------------------------------------------------------------------------------ *
 * The simulator reads through the SAME codec -- the verdict is the decoded on-chain reason, re-derivable.
 * ------------------------------------------------------------------------------------------------ */

test("simulate (allowlisted asset, under cap): the chain's (true, OK) decodes to an ALLOWED verdict", async () => {
  const native = MANDATE_CARD.assets.find((a) => a.allowed);
  assert.ok(native, "the spine pins an allowlisted asset");
  const result = await runMandateCheck(
    ethCallDouble(OK_REPLY),
    { agent: MANDATE_CARD.agent, token: native.address, amount: 1_000_000n },
    MANDATE_CARD.registryAddress,
  );
  assert.equal(result.blocked, false);
  const { verdict } = classifySim(!result.blocked, result.verdict);
  assert.equal(verdict, SIM_VERDICT.ALLOWED);
});

test("simulate (non-allowlisted asset): the chain's (false, TOKEN_NOT_ALLOWED) decodes to a BLOCKED verdict", async () => {
  const usdce = MANDATE_CARD.assets.find((a) => !a.allowed);
  assert.ok(usdce, "the spine pins a non-allowlisted asset (the default-deny row)");
  const result = await runMandateCheck(
    ethCallDouble(blockedReply("TOKEN_NOT_ALLOWED")),
    { agent: MANDATE_CARD.agent, token: usdce.address, amount: 1_000_000n },
    MANDATE_CARD.registryAddress,
  );
  assert.equal(result.blocked, true);
  assert.equal(result.verdict, "TOKEN_NOT_ALLOWED");
  const { verdict, binding } = classifySim(!result.blocked, result.verdict);
  assert.equal(verdict, SIM_VERDICT.BLOCKED);
  assert.match(binding, /allowlist/i);
});

test("simulate degrades LOUDLY on an unreachable RPC -> never a faked allow (fail-closed)", async () => {
  await assert.rejects(
    runMandateCheck(
      ethCallDouble({ fail: true }),
      { agent: MANDATE_CARD.agent, token: MANDATE_CARD.assets[0]!.address, amount: 1n },
      MANDATE_CARD.registryAddress,
    ),
    OnChainReadError,
  );
  // The card's UNVERIFIED face is the honest mapping of that throw (the simulator never coerces it to ALLOWED).
  assert.equal(SIM_VERDICT.UNVERIFIED, "UNVERIFIED");
});

/* ------------------------------------------------------------------------------------------------ *
 * The spine CONTEXT is the single threaded {chainId, registryAddress} (multi-chain = a data change).
 * ------------------------------------------------------------------------------------------------ */

test("the mandate context is 0G-only (one enforcement chain, chain id 16602) -- no chain selector", () => {
  assert.equal(MANDATE_CARD.chainId, 16602);
  assert.match(MANDATE_CARD.registryAddress, /^0x[0-9a-fA-F]{40}$/);
  // The deployed-registry address the card reads is the LIVE consolidated MandateRegistryV4 (the pinned
  // mandate, `[mandate_v4].address`) -- the same live surface the RAILS on-chain leg reads.
  assert.equal(MANDATE_CARD.registryAddress, "0x8e561a5cc096af6e570220a5228b33c7d889f774");
});

test("the V4 period tier reads LIVE now V4 is deployed + tier-configured on-chain (claim only what's live -- design §8)", () => {
  // V4's operator-gated deploy has landed: setPeriodConfig(3600, 1_500_000) is confirmed on-chain, so the
  // period bar reads a LIVE-enforced figure (deployed === true) -- never faked while it was built-not-deployed.
  assert.equal(MANDATE_CARD.v4Spec.deployed, true);
  assert.ok(MANDATE_CARD.v4Spec.periodCap > 0n);
  assert.equal(MANDATE_CARD.v4Spec.periodSeconds, 3600);
  // The USD cap stays opt-in (off by default) -- never charted as a live number it does not read.
  assert.equal(MANDATE_CARD.v4Spec.usdCapMicros, 0n);
});

test("the per-asset table mirrors the deployed allowlist: exactly one allowed + one default-deny row", () => {
  const allowed = MANDATE_CARD.assets.filter((a) => a.allowed);
  const blocked = MANDATE_CARD.assets.filter((a) => !a.allowed);
  assert.equal(allowed.length, 1, "the native sentinel is allowlisted on-chain");
  assert.equal(blocked.length, 1, "the public USDC.E is NOT allowlisted (the default-deny row)");
  // A blocked row carries a zero cap (the `—` the table renders), never a stale positive cap.
  assert.equal(blocked[0]!.perTxCap, 0n);
  // The allowed row's per-tx cap is the on-chain per-tx cap.
  assert.equal(allowed[0]!.perTxCap, MANDATE_CARD.perTxCap);
});

/* ------------------------------------------------------------------------------------------------ *
 * The tri-state pill alphabet is exactly {Reconciled, Drifted, Unverified} -- two-source, never faked green.
 * ------------------------------------------------------------------------------------------------ */

test("the deploy-reconcile pill is a 3-state honesty face (Reconciled / Drifted / Unverified)", () => {
  assert.equal(DEPLOY_RECONCILE.RECONCILED, "reconciled");
  assert.equal(DEPLOY_RECONCILE.DRIFTED, "drifted");
  assert.equal(DEPLOY_RECONCILE.UNVERIFIED, "unverified");
});
