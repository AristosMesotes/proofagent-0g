/**
 * Tests for the gas floor -- the pre-broadcast "can't deplete gas" kill-switch (design SS3a). Node's
 * built-in test runner, fully OFFLINE (a recorded balance-source double; no network).
 *
 * They pin the design-SS3a invariants the gas floor must hold:
 *  - the reserve inequality `balance - actionNativeCost - estGasFee >= minGasReserve` decides ALLOW;
 *  - it is fail-CLOSED on EVERY non-OK path (disabled / not-wired / unread / would-deplete) -- an
 *    unread/failed floor is `verified: false, allowed: false`, NEVER an allow (design SS3 principle 3);
 *  - a reserve that WOULD be breached is a read refusal (`verified: true, allowed: false`), distinct
 *    from an unread floor -- the agent can never deplete the wallet by making the check fail to answer;
 *  - exact-integer money: amounts beyond Number.MAX_SAFE_INTEGER are handled as bigint (no float);
 *  - a malformed request/config (bad address, negative amount/reserve) is a loud throw, pre-read.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  checkGasFloor,
  fetchNativeBalanceSource,
  GasFloorError,
  GAS_FLOOR_REASON,
  type GasFloorRequest,
  type GasFloorConfig,
  type NativeBalanceSource,
} from "./gasfloor.js";

const AGENT = "0xc7af61a1399aca0bee648d7853ae93f96b86866a";

/** A balance-source double that returns a fixed balance (or throws to model an unreadable RPC). */
function balanceSource(opts: { balance?: bigint; throws?: boolean } = {}): NativeBalanceSource {
  return {
    nativeBalance(_agent: string): Promise<bigint> {
      if (opts.throws === true) {
        return Promise.reject(new Error("rpc down"));
      }
      return Promise.resolve(opts.balance ?? 0n);
    },
  };
}

function req(overrides: Partial<GasFloorRequest> = {}): GasFloorRequest {
  return { agent: AGENT, actionNativeCost: 0n, estGasFee: 0n, ...overrides };
}

function cfg(overrides: Partial<GasFloorConfig> = {}): GasFloorConfig {
  return { minGasReserve: 1_000_000n, enabled: true, ...overrides };
}

// --- the reserve inequality: ALLOW only when the floor provably holds --------------------------------

test("gas floor ALLOWS when the reserve provably holds after the action + fee", async () => {
  // balance 5_000_000; action 1_000_000 native + 500_000 fee => remaining 3_500_000 >= reserve 1_000_000.
  const v = await checkGasFloor(
    req({ actionNativeCost: 1_000_000n, estGasFee: 500_000n }),
    cfg({ minGasReserve: 1_000_000n }),
    balanceSource({ balance: 5_000_000n }),
  );
  assert.equal(v.allowed, true);
  assert.equal(v.verified, true);
  assert.equal(v.reason, GAS_FLOOR_REASON.OK);
  assert.equal(v.remaining, 3_500_000n);
});

test("gas floor ALLOWS exactly at the floor boundary (remaining == reserve)", async () => {
  // remaining == reserve is allowed (the floor is a >= bound, not >).
  const v = await checkGasFloor(
    req({ actionNativeCost: 0n, estGasFee: 4_000_000n }),
    cfg({ minGasReserve: 1_000_000n }),
    balanceSource({ balance: 5_000_000n }),
  );
  assert.equal(v.remaining, 1_000_000n);
  assert.equal(v.allowed, true, "remaining exactly at the reserve still passes");
});

test("gas floor REFUSES (kill-switch) when the action would deplete the reserve", async () => {
  // balance 1_200_000; action 0 + fee 300_000 => remaining 900_000 < reserve 1_000_000 -> refuse.
  const v = await checkGasFloor(
    req({ actionNativeCost: 0n, estGasFee: 300_000n }),
    cfg({ minGasReserve: 1_000_000n }),
    balanceSource({ balance: 1_200_000n }),
  );
  assert.equal(v.allowed, false, "the depletion kill-switch fires");
  assert.equal(v.verified, true, "the balance WAS read -- this is a real refusal, not an unread floor");
  assert.equal(v.reason, GAS_FLOOR_REASON.WOULD_DEPLETE_RESERVE);
  assert.equal(v.remaining, 900_000n);
});

test("gas floor REFUSES a swap-away that drains native to ~0 (the headline depletion risk)", async () => {
  // The agent tries to swap/bridge nearly its whole native balance away: action 4_900_000 of a 5_000_000
  // balance -> remaining 100_000 - fee. Even before the fee that is below the 1_000_000 reserve -> REFUSE.
  const v = await checkGasFloor(
    req({ actionNativeCost: 4_900_000n, estGasFee: 50_000n }),
    cfg({ minGasReserve: 1_000_000n }),
    balanceSource({ balance: 5_000_000n }),
  );
  assert.equal(v.allowed, false, "spending the gas token away to ~0 is refused PRE-broadcast");
  assert.equal(v.reason, GAS_FLOOR_REASON.WOULD_DEPLETE_RESERVE);
});

test("gas floor counts the action + the fee even when the action moves 0 native (pure ERC-20)", async () => {
  // A pure ERC-20 action attaches 0 native, but its gas fee still burns native -- the floor must account
  // for the fee, so an ERC-20 action that cannot even afford its own gas above the reserve is refused.
  const v = await checkGasFloor(
    req({ actionNativeCost: 0n, estGasFee: 200_000n }),
    cfg({ minGasReserve: 1_000_000n }),
    balanceSource({ balance: 1_100_000n }),
  );
  assert.equal(v.remaining, 900_000n);
  assert.equal(v.allowed, false, "even a 0-native action must leave the reserve intact after its gas");
});

// --- fail-CLOSED: unread / not-wired / disabled never allow (design SS3 principle 3) ------------------

test("gas floor fails CLOSED when no balance source is wired (offline default)", async () => {
  const v = await checkGasFloor(req(), cfg(), undefined);
  assert.equal(v.allowed, false);
  assert.equal(v.verified, false, "an unread floor is unverified");
  assert.equal(v.reason, GAS_FLOOR_REASON.NOT_WIRED);
  assert.equal(v.remaining, undefined);
});

test("gas floor fails CLOSED when the balance read throws (unreachable RPC)", async () => {
  const v = await checkGasFloor(req(), cfg(), balanceSource({ throws: true }));
  assert.equal(v.allowed, false);
  assert.equal(v.verified, false, "a failed read is unverified -- NEVER coerced to an allow");
  assert.equal(v.reason, GAS_FLOOR_REASON.BALANCE_UNREAD);
});

test("gas floor fails CLOSED when the source returns a malformed (negative) balance", async () => {
  const bad: NativeBalanceSource = { nativeBalance: () => Promise.resolve(-1n) };
  const v = await checkGasFloor(req(), cfg(), bad);
  assert.equal(v.allowed, false);
  assert.equal(v.reason, GAS_FLOOR_REASON.BALANCE_UNREAD, "a negative balance is treated as unread");
});

test("a DISABLED floor is an honest visible off-state, never a silent pass", async () => {
  // enabled: false turns the floor OFF -- but the verdict says so LOUDLY (disabled, allowed:false) so the
  // gateway treats it as an explicit non-enforcement decision, not an allow. (The gateway maps DISABLED
  // to "skip the gas-floor gate" -- see gateway.test.ts -- but the verdict itself is never `allowed:true`.)
  const v = await checkGasFloor(req(), cfg({ enabled: false }), balanceSource({ balance: 5_000_000n }));
  assert.equal(v.allowed, false);
  assert.equal(v.verified, false);
  assert.equal(v.reason, GAS_FLOOR_REASON.DISABLED);
});

// --- exact-integer money (design SS3 principle 5) ----------------------------------------------------

test("gas floor is exact-integer over balances beyond Number.MAX_SAFE_INTEGER (bigint, no float)", async () => {
  // An 18-decimal native balance (e.g. 10 0G = 10e18 wei) exceeds Number.MAX_SAFE_INTEGER; the inequality
  // must be exact. reserve 1e18, balance 10e18, action 8.5e18, fee 0.4e18 => remaining 1.1e18 >= 1e18 -> ok.
  const wei = (n: bigint) => n * 1_000_000_000_000_000_000n;
  const v = await checkGasFloor(
    req({ actionNativeCost: 8_500_000_000_000_000_000n, estGasFee: 400_000_000_000_000_000n }),
    cfg({ minGasReserve: wei(1n) }),
    balanceSource({ balance: wei(10n) }),
  );
  assert.equal(v.remaining, 1_100_000_000_000_000_000n);
  assert.equal(v.allowed, true);
  assert.ok(v.remaining! > BigInt(Number.MAX_SAFE_INTEGER), "the figures exceed JS safe-integer range");
});

test("gas floor reports a true (possibly negative) remaining when fully depleted -- never clamped", async () => {
  // action + fee exceed the whole balance: remaining goes negative. The journal shows the true figure.
  const v = await checkGasFloor(
    req({ actionNativeCost: 2_000_000n, estGasFee: 500_000n }),
    cfg({ minGasReserve: 1_000_000n }),
    balanceSource({ balance: 1_000_000n }),
  );
  assert.equal(v.remaining, -1_500_000n, "remaining is the true (negative) figure, not clamped to 0");
  assert.equal(v.allowed, false);
});

// --- malformed request/config => loud throw, pre-read (design SS3 principle 3) -----------------------

test("gas floor throws loudly on a malformed agent address (before any read)", async () => {
  await assert.rejects(
    () => checkGasFloor(req({ agent: "0xnotanaddress" }), cfg(), balanceSource({ balance: 9n })),
    GasFloorError,
  );
});

test("gas floor throws loudly on a negative action cost / fee / reserve", async () => {
  await assert.rejects(() => checkGasFloor(req({ actionNativeCost: -1n }), cfg(), balanceSource()), GasFloorError);
  await assert.rejects(() => checkGasFloor(req({ estGasFee: -1n }), cfg(), balanceSource()), GasFloorError);
  await assert.rejects(() => checkGasFloor(req(), cfg({ minGasReserve: -1n }), balanceSource()), GasFloorError);
});

test("gas floor is deterministic: same inputs -> identical verdict every call (design SS3 #4)", async () => {
  const run = () =>
    checkGasFloor(
      req({ actionNativeCost: 1_000_000n, estGasFee: 500_000n }),
      cfg({ minGasReserve: 1_000_000n }),
      balanceSource({ balance: 5_000_000n }),
    );
  const first = await run();
  for (let i = 0; i < 8; i++) {
    assert.deepEqual(await run(), first, "same inputs -> identical verdict");
  }
});

// --- the live source constructor (no network in CI; just the loud guard) -----------------------------

test("fetchNativeBalanceSource requires a non-empty endpoint (loud, no baked-in target)", () => {
  assert.throws(() => fetchNativeBalanceSource(""), GasFloorError);
  assert.throws(() => fetchNativeBalanceSource("   "), GasFloorError);
  // A well-formed endpoint constructs a source object (it is not called here -- no network in CI).
  const src = fetchNativeBalanceSource("https://evmrpc-testnet.0g.ai");
  assert.equal(typeof src.nativeBalance, "function");
});
