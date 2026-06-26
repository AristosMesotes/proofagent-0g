/**
 * Tests for the loop (design SS4 `agent/loop.ts` + SS5 the full loop) -- Node's built-in test runner,
 * fully OFFLINE (recorded transport/broadcaster/verifier doubles; zero network, zero child processes,
 * zero deps).
 *
 * They pin the design invariants the loop must hold:
 *  - SS5 ordering + the kill-switch: `plan -> mandate-gate -> execute -> verify`; a non-allowed gate
 *    STOPS the loop BEFORE execute (the executor is never called -- no broadcast can occur).
 *  - SS8 (claim only what's live): an end-to-end DRY-RUN completes with NO live settlement -- it
 *    broadcasts NOTHING and the verify leg is honestly skipped (`settlement: undefined`).
 *  - SS3 principle 3 (never fabricate): a blocked gate / a dry-run / an unverifiable broadcast NEVER
 *    yields a fabricated `settled`; the verify shim throws loudly on a missing verdict line.
 *  - SS3 principle 2 (verdict monopoly): the loop carries the verifier's verdict; it never mints one.
 *  - SS3 principle 1 (two-source truth): the verify leg goes through one `SettlementVerifier` seam; a
 *    recorded verdict and the real binary are interchangeable.
 *  - SS2 (the verify leg shells to the independent verifier): `binaryVerifier` reads the verdict from
 *    the last stdout line, honoring the binary's exit/stdout contract; the NEG case is `unverified`.
 *  - SS3 principle 4 (deterministic): the same query + config -> the same loop result.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  runLoop,
  binaryVerifier,
  binaryFillProof,
  nodeSpawn,
  isSettled,
  dominantAllocation,
  LoopError,
  LOOP_STAGE,
  SETTLEMENT_VERDICT,
  FILL_DECISION,
  type LoopConfig,
  type LoopResult,
  type SettlementVerifier,
  type FillProofOracle,
} from "./loop.js";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { ExecuteMode, type SwapBroadcaster, type PlannedCall } from "./execute.js";
import { type EthCallTransport } from "./mandate.js";
import { plan as planFor } from "./plan.js";

// --- Fixtures (well-formed 20-byte addresses; arbitrary public test values) -----------------------
const AGENT = "0x1111111111111111111111111111111111111111";
const TOKEN_IN = "0x2222222222222222222222222222222222222222";
const TOKEN_OUT = "0x3333333333333333333333333333333333333333";
const RECIPIENT = "0x4444444444444444444444444444444444444444";
const REGISTRY = "0x5555555555555555555555555555555555555555";
const TX_HASH = "0xabc0000000000000000000000000000000000000000000000000000000000001";

/** A loop config with a concrete in-band spend/swap and a pinned registry. */
function cfg(overrides: Partial<LoopConfig> = {}): LoopConfig {
  return {
    spend: {
      agent: AGENT,
      tokenIn: TOKEN_IN,
      tokenOut: TOKEN_OUT,
      recipient: RECIPIENT,
      amountIn: 1_000_000n,
      expectedOut: 2_000_000n,
      slippageBps: 50,
    },
    mandate: { registry: REGISTRY },
    ...overrides,
  };
}

/** Build a 32-byte (64-hex) ABI bool word: true => `...01`, false => all zeros. */
function boolWord(v: boolean): string {
  return (v ? "1" : "0").padStart(64, "0");
}

/** A mock `eth_call` transport that replays a fixed `(ok, reason=OK/zero)` reply. */
function tapeTransport(ok: boolean): EthCallTransport {
  return {
    ethCall(_to: string, _data: string): Promise<string> {
      // (bool ok, bytes32 reason): for ok=true reason is the zero word (=> OK).
      return Promise.resolve("0x" + boolWord(ok) + "0".repeat(64));
    },
  };
}

/** A broadcaster that records the calls it was handed and returns fixed hashes (LIVE double). */
function recordingBroadcaster(hashes: readonly string[] | undefined): {
  readonly broadcaster: SwapBroadcaster;
  readonly seen: PlannedCall[][];
} {
  const seen: PlannedCall[][] = [];
  const broadcaster: SwapBroadcaster = {
    broadcast(calls: readonly PlannedCall[]): Promise<readonly string[] | undefined> {
      seen.push([...calls]);
      return Promise.resolve(hashes);
    },
  };
  return { broadcaster, seen };
}

/** A broadcaster that MUST NOT be called (asserts the kill-switch -- gate blocks before execute). */
function neverBroadcaster(): { readonly broadcaster: SwapBroadcaster; called: () => boolean } {
  let wasCalled = false;
  const broadcaster: SwapBroadcaster = {
    broadcast(_calls: readonly PlannedCall[]): Promise<readonly string[] | undefined> {
      wasCalled = true;
      return Promise.resolve(["0xSHOULD_NOT_HAPPEN"]);
    },
  };
  return { broadcaster, called: () => wasCalled };
}

/** A settlement verifier double that replays a fixed verdict (the two-source-truth seam). */
function tapeVerifier(verdict: "settled" | "hollow" | "mismatch" | "unverified"): {
  readonly verifier: SettlementVerifier;
  readonly seen: string[];
} {
  const seen: string[] = [];
  const verifier: SettlementVerifier = {
    verify(txHash: string): Promise<typeof verdict> {
      seen.push(txHash);
      return Promise.resolve(verdict);
    },
  };
  return { verifier, seen };
}

// --- The kill-switch: a non-allowed gate STOPS the loop BEFORE execute (design SS5) ---------------

test("kill-switch: NO transport => gate fails closed => loop stops at BLOCKED_BY_MANDATE, no execute", async () => {
  // No transport wired => checkMandate fails closed (allowed:false). The loop must NOT execute.
  const { broadcaster, called } = neverBroadcaster();
  const r = await runLoop("aggressive growth", cfg({ mode: ExecuteMode.LIVE }), undefined, broadcaster);
  assert.equal(r.stage, LOOP_STAGE.BLOCKED_BY_MANDATE);
  assert.equal(r.mandate.allowed, false);
  assert.equal(r.executed, undefined, "the executor was never reached (kill-switch pre-broadcast)");
  assert.equal(r.settlement, undefined, "nothing to verify -- never a fabricated settled");
  assert.equal(called(), false, "the broadcaster was NEVER called (gate blocked before execute)");
  assert.match(r.note, /BLOCKED/);
});

test("kill-switch: on-chain ok==false => loop stops at the gate, carries the on-chain reason", async () => {
  const { broadcaster, called } = neverBroadcaster();
  const r = await runLoop("stable", cfg({ mode: ExecuteMode.LIVE }), tapeTransport(false), broadcaster);
  assert.equal(r.stage, LOOP_STAGE.BLOCKED_BY_MANDATE);
  assert.equal(r.mandate.allowed, false);
  assert.equal(r.mandate.verified, true, "the chain answered (a real read), it just said no");
  assert.equal(r.executed, undefined);
  assert.equal(called(), false, "an over-cap/blocked spend never reaches the broadcaster");
});

test("kill-switch: unset registry => fail-closed => blocked, never allow (design SS5/SS6)", async () => {
  const r = await runLoop("stable", cfg({ mandate: { registry: "" } }), tapeTransport(true));
  assert.equal(r.stage, LOOP_STAGE.BLOCKED_BY_MANDATE);
  assert.equal(r.mandate.allowed, false);
  assert.equal(r.executed, undefined);
});

// --- The dry-run: gate allows, swap PLANNED, broadcast NOTHING, NO settlement (design SS8) ---------

test("dry-run: gate allows => execute(DRY_RUN) plans the swap and broadcasts NOTHING (SS8)", async () => {
  const r = await runLoop("balanced 50/50 hedge", cfg(), tapeTransport(true));
  assert.equal(r.stage, LOOP_STAGE.EXECUTED_DRY_RUN);
  assert.equal(r.mandate.allowed, true, "the gate ALLOWED the spend");
  assert.ok(r.executed, "the executor ran");
  assert.equal(r.executed?.mode, ExecuteMode.DRY_RUN);
  assert.equal(r.executed?.broadcast, false, "a dry-run sends NOTHING on-chain");
  assert.equal(r.executed?.txHashes, undefined, "a dry-run NEVER carries a tx hash");
  assert.equal(r.executed?.plan.calls.length, 2, "the inspectable [approve, exactInputSingle] plan");
  // THE load-bearing invariant for this step: an end-to-end dry-run completes with NO live settlement.
  assert.equal(r.settlement, undefined, "no broadcast => NO settlement to verify => never fabricated");
  assert.equal(isSettled(r), false, "a dry-run is never a settled");
  assert.match(r.note, /NO live settlement/);
});

test("dry-run ignores a supplied verifier -- there is no broadcast to verify (never fabricate)", async () => {
  // Even with a verifier wired, a DRY_RUN has no tx, so the verify leg must NOT run.
  const { verifier, seen } = tapeVerifier("settled");
  const r = await runLoop("stable", cfg(), tapeTransport(true), undefined, verifier);
  assert.equal(r.stage, LOOP_STAGE.EXECUTED_DRY_RUN);
  assert.equal(r.settlement, undefined, "a dry-run never invokes the verifier => never a settled");
  assert.equal(seen.length, 0, "the verifier was NEVER called in a dry-run");
});

test("dry-run is the DEFAULT mode (no mode in config) -- offline, no settlement", async () => {
  const r = await runLoop("preserve capital", cfg()); // no transport at all
  // No transport => gate fails closed => blocked. Add the transport to reach the dry-run default.
  assert.equal(r.stage, LOOP_STAGE.BLOCKED_BY_MANDATE);
  const r2 = await runLoop("preserve capital", cfg(), tapeTransport(true));
  assert.equal(r2.executed?.mode, ExecuteMode.DRY_RUN, "mode defaults to DRY_RUN (design SS8)");
  assert.equal(r2.settlement, undefined);
});

// --- The full LIVE loop: gate allows, broadcast sends, verifier stamps the verdict (design SS5) ----

test("LIVE end-to-end: gate allows, broadcast sends, verifier stamps SETTLED -> stage VERIFIED", async () => {
  const { broadcaster, seen } = recordingBroadcaster([TX_HASH]);
  const { verifier, seen: vSeen } = tapeVerifier("settled");
  const r = await runLoop(
    "aggressive",
    cfg({ mode: ExecuteMode.LIVE }),
    tapeTransport(true),
    broadcaster,
    verifier,
  );
  assert.equal(r.stage, LOOP_STAGE.VERIFIED);
  assert.equal(r.executed?.broadcast, true);
  assert.deepEqual(r.executed?.txHashes, [TX_HASH]);
  assert.equal(r.settlement, SETTLEMENT_VERDICT.SETTLED, "the verifier's verdict is carried");
  assert.equal(isSettled(r), true);
  // The executor handed the broadcaster the [approve, exactInputSingle] calls.
  assert.equal(seen[0]?.[0]?.label, "approve");
  assert.equal(seen[0]?.[1]?.label, "exactInputSingle");
  // The verifier was asked about the real broadcast hash (two-source truth -- the verifier's read).
  assert.deepEqual(vSeen, [TX_HASH]);
});

test("LIVE end-to-end: a verifier UNVERIFIED stamp is carried, NOT softened to settled (NEG case)", async () => {
  const { broadcaster } = recordingBroadcaster([TX_HASH]);
  const { verifier } = tapeVerifier("unverified");
  const r = await runLoop("stable", cfg({ mode: ExecuteMode.LIVE }), tapeTransport(true), broadcaster, verifier);
  assert.equal(r.stage, LOOP_STAGE.VERIFIED);
  assert.equal(r.settlement, SETTLEMENT_VERDICT.UNVERIFIED, "the NEG case is carried verbatim");
  assert.equal(isSettled(r), false, "unverified is NEVER a success (design SS3 principle 3)");
});

test("LIVE broadcast WITHOUT a wired verifier => UNCONFIRMED, never a fabricated settled (SS3 #3)", async () => {
  const { broadcaster } = recordingBroadcaster([TX_HASH]);
  const r = await runLoop("stable", cfg({ mode: ExecuteMode.LIVE }), tapeTransport(true), broadcaster);
  // A broadcast happened but no verifier -> we cannot confirm; the loop must NOT claim settled.
  assert.equal(r.settlement, undefined, "no verifier => settlement unconfirmed => never settled");
  assert.equal(isSettled(r), false);
  assert.match(r.note, /UNCONFIRMED|NEVER fabricates/);
});

test("LIVE with a broadcaster that returns no hash => honest dry-run-like, no settlement", async () => {
  const { broadcaster } = recordingBroadcaster(undefined); // sent nothing
  const { verifier, seen } = tapeVerifier("settled");
  const r = await runLoop("stable", cfg({ mode: ExecuteMode.LIVE }), tapeTransport(true), broadcaster, verifier);
  assert.equal(r.stage, LOOP_STAGE.EXECUTED_DRY_RUN, "no hash => nothing to verify");
  assert.equal(r.settlement, undefined);
  assert.equal(seen.length, 0, "the verifier was never called (no real tx)");
});

// --- Never fabricate: an unverifiable broadcast is a loud failure, never a settled (SS3 #3) --------

test("a verifier that throws makes the loop fail LOUDLY -- never treats a broadcast as settled", async () => {
  const { broadcaster } = recordingBroadcaster([TX_HASH]);
  const throwingVerifier: SettlementVerifier = {
    verify: () => Promise.reject(new Error("verifier binary not found")),
  };
  await assert.rejects(
    () =>
      runLoop("stable", cfg({ mode: ExecuteMode.LIVE }), tapeTransport(true), broadcaster, throwingVerifier),
    (err: unknown) => {
      assert.ok(err instanceof LoopError);
      assert.match(err.message, /could not adjudicate/);
      return true;
    },
  );
});

// --- plan leg: an unplannable query is a loud LoopError, before any gate/broadcast (SS3 #3) --------

test("plan leg: an empty query throws LoopError -- nothing downstream runs (never fabricate)", async () => {
  await assert.rejects(() => runLoop("", cfg(), tapeTransport(true)), (err: unknown) => {
    assert.ok(err instanceof LoopError);
    assert.match(err.message, /plan leg failed/);
    return true;
  });
});

test("a malformed spend (bad address) throws LoopError at the gate, before any broadcast", async () => {
  await assert.rejects(
    () => runLoop("stable", cfg({ spend: { ...cfg().spend, agent: "0xbad" } }), tapeTransport(true)),
    LoopError,
  );
});

// --- Determinism: same query + config -> same loop result (design SS3 principle 4) ----------------

test("the loop is deterministic: same query + config -> structurally identical result (SS3 #4)", async () => {
  const a = await runLoop("balanced hedge", cfg(), tapeTransport(true));
  const b = await runLoop("balanced hedge", cfg(), tapeTransport(true));
  const norm = (r: LoopResult): string =>
    JSON.stringify(r, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
  assert.equal(norm(a), norm(b));
});

// --- binaryVerifier shim: reads the verdict from the last stdout line (the binary's contract, SS2) -

/** A fake spawner that returns canned stdout/stderr/code -- the process seam (no real child process). */
function fakeSpawn(stdout: string, stderr: string, code: number | null): BinarySpawn {
  const calls: { command: string; args: readonly string[] }[] = [];
  const spawn = (command: string, args: readonly string[]): Promise<SpawnOut> => {
    calls.push({ command, args });
    return Promise.resolve({ stdout, stderr, code });
  };
  return { spawn, calls };
}
type SpawnOut = { readonly stdout: string; readonly stderr: string; readonly code: number | null };
type BinarySpawn = {
  spawn: (command: string, args: readonly string[]) => Promise<SpawnOut>;
  calls: { command: string; args: readonly string[] }[];
};

test("binaryVerifier reads the verdict from the LAST stdout line (settled, exit 0)", async () => {
  // The binary prints the verdict on stdout and a journal row on stderr (design main.rs contract).
  const { spawn, calls } = fakeSpawn("settled\n", "verifier: BUY ... -> settled\n", 0);
  const v = binaryVerifier({ spawn, binary: "verifier", spinePath: "proofagent.toml" });
  const verdict = await v.verify(TX_HASH);
  assert.equal(verdict, "settled");
  // It invoked `verifier verify-tx <hash> --spine proofagent.toml`.
  assert.equal(calls[0]?.command, "verifier");
  assert.deepEqual(calls[0]?.args, ["verify-tx", TX_HASH, "--spine", "proofagent.toml"]);
});

test("binaryVerifier carries the NEG-case `unverified` stamp (off-record hash, exit non-zero) (SS2)", async () => {
  // The NEG case: the verifier prints `unverified` to stdout and exits non-zero. The shim must NOT
  // treat a non-zero exit as a failure -- the stdout verdict string is the source of truth.
  const { spawn } = fakeSpawn(
    "unverified\n",
    "verifier: unknown 0x... -> unverified\nverifier: (NEG case ...)\n",
    1,
  );
  const v = binaryVerifier({ spawn });
  assert.equal(await v.verify(TX_HASH), "unverified");
});

test("binaryVerifier carries hollow/mismatch verdicts verbatim (non-zero exit, valid verdict line)", async () => {
  const hollow = binaryVerifier({ spawn: fakeSpawn("hollow\n", "", 1).spawn });
  assert.equal(await hollow.verify(TX_HASH), "hollow");
  const mismatch = binaryVerifier({ spawn: fakeSpawn("mismatch\n", "", 1).spawn });
  assert.equal(await mismatch.verify(TX_HASH), "mismatch");
});

test("binaryVerifier ignores trailing blank lines and journal noise, takes the verdict line", async () => {
  // Extra blank lines / trailing whitespace must not break verdict extraction (last non-empty line).
  const { spawn } = fakeSpawn("settled\n\n  \n", "", 0);
  const v = binaryVerifier({ spawn });
  assert.equal(await v.verify(TX_HASH), "settled");
});

test("binaryVerifier throws LOUDLY when stdout has NO valid verdict line (usage failure, SS3 #3)", async () => {
  // A usage failure (bad hash, unreadable spine, missing binary) prints NO verdict line on stdout.
  // The shim must throw -- NEVER coerce a missing verdict into a settled.
  const { spawn } = fakeSpawn("", "verifier: not a 32-byte transaction hash: \"nope\"\n", 1);
  const v = binaryVerifier({ spawn });
  await assert.rejects(() => v.verify(TX_HASH), (err: unknown) => {
    assert.ok(err instanceof LoopError);
    assert.match(err.message, /no valid verdict line/);
    return true;
  });
});

test("binaryVerifier throws when stdout has an UNRECOGNIZED token (never coerce to settled)", async () => {
  const { spawn } = fakeSpawn("definitely-not-a-verdict\n", "", 0);
  const v = binaryVerifier({ spawn });
  await assert.rejects(() => v.verify(TX_HASH), LoopError);
});

test("binaryVerifier rejects an empty tx hash up front (loud, no spawn)", async () => {
  let spawned = false;
  const v = binaryVerifier({
    spawn: () => {
      spawned = true;
      return Promise.resolve({ stdout: "settled\n", stderr: "", code: 0 });
    },
  });
  await assert.rejects(() => v.verify("   "), LoopError);
  assert.equal(spawned, false, "an empty hash never spawns the verifier");
});

test("binaryVerifier omits --spine when no spinePath is supplied (verifier walks up to find it)", async () => {
  const { spawn, calls } = fakeSpawn("settled\n", "", 0);
  const v = binaryVerifier({ spawn });
  await v.verify(TX_HASH);
  assert.deepEqual(calls[0]?.args, ["verify-tx", TX_HASH], "no --spine arg when path omitted");
});

test("binaryVerifier defaults the binary name to `verifier` (no baked-in private path, SS6)", async () => {
  const { spawn, calls } = fakeSpawn("settled\n", "", 0);
  const v = binaryVerifier({ spawn });
  await v.verify(TX_HASH);
  assert.equal(calls[0]?.command, "verifier", "default binary is `verifier` on PATH, not a private path");
});

test("binaryVerifier requires a spawn function (loud constructor guard)", () => {
  assert.throws(
    () => binaryVerifier({ spawn: undefined as unknown as BinarySpawn["spawn"] }),
    LoopError,
  );
});

// --- dominantAllocation: a pure deterministic journal helper (design SS3 principle 4) --------------

test("dominantAllocation returns the largest-bps leg; stable on the planner's order", () => {
  // An aggressive plan is all-W0G (one leg). A balanced plan is a 50/50 tie -> first in order wins.
  const aggressive = dominantAllocation(planFor("aggressive"));
  assert.equal(aggressive?.token, "W0G");
  const balanced = planFor("balanced 50/50 hedge");
  const dom = dominantAllocation(balanced);
  assert.ok(dom, "a valid plan has a dominant allocation");
  // 50/50: the first allocation in the planner's deterministic order is USDC.e.
  assert.equal(dom?.token, "USDC.e");
});

// --- Integration: the verify leg shelling to the REAL Rust verifier binary (design SS2/SS9) --------
//
// This proves the end-to-end shell-out, not just the parsing: nodeSpawn() runs the actual built
// `verifier` binary on a FABRICATED (off-record) hash -> the NEG case -> `unverified` (the hero
// invariant, design SS2). It is OPT-IN and SKIPS when the binary / spine is not present, so it never
// fails the gate on a machine without the Rust build; the offline fake-spawn tests above are the
// always-on coverage.

/** Locate the workspace root (the dir holding proofagent.toml), walking up from this test file. */
function findRepoRoot(): string | undefined {
  let dir = dirname(fileURLToPath(import.meta.url)); // .../agent/dist (compiled) or .../agent/src
  for (let i = 0; i < 8; i += 1) {
    if (existsSync(join(dir, "proofagent.toml"))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  return undefined;
}

test("INTEGRATION: nodeSpawn drives the real verifier binary -> NEG case stamps `unverified` (SS2)", async (t) => {
  const root = findRepoRoot();
  if (root === undefined) {
    t.skip("proofagent.toml not found (cannot locate the workspace) -- offline fakes cover parsing");
    return;
  }
  const spine = join(root, "proofagent.toml");
  // Prefer a built binary; skip if neither debug nor release exists (no Rust build on this machine).
  const candidates = [
    join(root, "target", "debug", "verifier.exe"),
    join(root, "target", "release", "verifier.exe"),
    join(root, "target", "debug", "verifier"),
    join(root, "target", "release", "verifier"),
  ];
  const binary = candidates.find((p) => existsSync(p));
  if (binary === undefined) {
    t.skip("verifier binary not built (run `cargo build -p verifier`) -- offline fakes cover parsing");
    return;
  }
  const v = binaryVerifier({ spawn: nodeSpawn(), binary, spinePath: spine });
  // A well-formed but off-record (fabricated) hash -> the verifier degrades LOUDLY to `unverified`,
  // NEVER a fabricated `settled` (design SS2 NEG case, design SS3 principle 3). Read through the REAL
  // binary + the REAL child-process seam.
  const verdict = await v.verify(
    "0xdead00000000000000000000000000000000000000000000000000000000beef",
  );
  assert.equal(verdict, SETTLEMENT_VERDICT.UNVERIFIED, "the real binary stamps the NEG case unverified");
});

// --- The FILL-PROOF ORACLE leg: a live BLOCKED_BY_FILL_PROOF stage (the LI.FI-Intents frontier) ----

/** A fill-proof oracle double that replays a fixed decision + records what it was asked (the seam). */
function tapeFillProof(decision: "RELEASE" | "BLOCK"): {
  readonly fillProof: FillProofOracle;
  readonly seen: { txHash: string; claimed: bigint }[];
} {
  const seen: { txHash: string; claimed: bigint }[] = [];
  const fillProof: FillProofOracle = {
    proveFill(txHash: string, claimed: bigint): Promise<typeof decision> {
      seen.push({ txHash, claimed });
      return Promise.resolve(decision);
    },
  };
  return { fillProof, seen };
}

test("fill-proof: a settled swap with a HOLLOW fill => BLOCKED_BY_FILL_PROOF (never release an unproven fill)", async () => {
  const { broadcaster } = recordingBroadcaster([TX_HASH]);
  const { verifier } = tapeVerifier("settled");
  const { fillProof, seen } = tapeFillProof("BLOCK");
  const r = await runLoop("aggressive", cfg({ mode: ExecuteMode.LIVE }), tapeTransport(true), broadcaster, verifier, fillProof);
  assert.equal(r.stage, LOOP_STAGE.BLOCKED_BY_FILL_PROOF, "a BLOCK decision stops the release");
  assert.equal(r.settlement, SETTLEMENT_VERDICT.SETTLED, "the swap still settled -- the carry is honest");
  assert.match(r.note, /fill-proof oracle BLOCKED release/);
  // The oracle was asked about the real broadcast tx + the claimed delivery (expectedOut = 2_000_000n).
  assert.deepEqual(seen, [{ txHash: TX_HASH, claimed: 2_000_000n }]);
});

test("fill-proof: a settled swap with a RELEASE fill => VERIFIED (the oracle independently released)", async () => {
  const { broadcaster } = recordingBroadcaster([TX_HASH]);
  const { verifier } = tapeVerifier("settled");
  const { fillProof, seen } = tapeFillProof("RELEASE");
  const r = await runLoop("aggressive", cfg({ mode: ExecuteMode.LIVE }), tapeTransport(true), broadcaster, verifier, fillProof);
  assert.equal(r.stage, LOOP_STAGE.VERIFIED);
  assert.equal(r.settlement, SETTLEMENT_VERDICT.SETTLED);
  assert.equal(isSettled(r), true);
  assert.match(r.note, /fill-proof oracle independently RELEASED/);
  assert.deepEqual(seen, [{ txHash: TX_HASH, claimed: 2_000_000n }]);
});

test("fill-proof: a NON-settled swap verdict never consults the oracle (the gate runs only on settled)", async () => {
  const { broadcaster } = recordingBroadcaster([TX_HASH]);
  const { verifier } = tapeVerifier("mismatch");
  const { fillProof, seen } = tapeFillProof("RELEASE");
  const r = await runLoop("aggressive", cfg({ mode: ExecuteMode.LIVE }), tapeTransport(true), broadcaster, verifier, fillProof);
  assert.equal(r.stage, LOOP_STAGE.VERIFIED, "the verify leg carried the mismatch verdict");
  assert.equal(r.settlement, SETTLEMENT_VERDICT.MISMATCH);
  assert.equal(seen.length, 0, "the fill-proof oracle is NOT consulted unless the swap settled");
});

test("fill-proof: a dry-run never consults the oracle (no broadcast => no fill to prove)", async () => {
  const { fillProof, seen } = tapeFillProof("BLOCK");
  const r = await runLoop("stable", cfg(), tapeTransport(true), undefined, undefined, fillProof);
  assert.equal(r.stage, LOOP_STAGE.EXECUTED_DRY_RUN);
  assert.equal(seen.length, 0, "a dry-run has nothing to prove -- the oracle is never called");
});

test("binaryFillProof: reads `<verdict> <decision>` -- RELEASE / BLOCK / loud usage failure", async () => {
  const spawnOf =
    (stdout: string, stderr = "", code: number | null = 0) =>
    (_command: string, _args: readonly string[]) =>
      Promise.resolve({ stdout, stderr, code });
  // `settled RELEASE` -> RELEASE.
  const release = binaryFillProof({ spawn: spawnOf("settled RELEASE\n") });
  assert.equal(await release.proveFill(TX_HASH, 1_000_000n), FILL_DECISION.RELEASE);
  // `hollow BLOCK` -> BLOCK (the binary exits non-zero; the decision is read from stdout, not the code).
  const block = binaryFillProof({ spawn: spawnOf("hollow BLOCK\n", "verifier: ...hollow fill...", 1) });
  assert.equal(await block.proveFill(TX_HASH, 1_000_000n), FILL_DECISION.BLOCK);
  // A usage failure (no valid `<verdict> <decision>` line) => a loud throw, NEVER a fabricated RELEASE.
  const broken = binaryFillProof({ spawn: spawnOf("", "verifier: not a tx hash", 1) });
  await assert.rejects(() => broken.proveFill(TX_HASH, 1_000_000n), LoopError);
});
