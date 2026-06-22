/**
 * The gateway -- protocol-AGNOSTIC dispatch over the [`ExecutionConnector`] contract (design WOW Feature 5).
 *
 * Design WOW Feature 5 (the Engine): "the agent calls `gateway.execute(intent)`, NEVER a specific protocol.
 * **Priced fallback** (try adapters by priority/quote, fall back on a PRE-broadcast failure) + the
 * **fund-loss-safe `value_moved` short-circuit**: once value has moved on-chain, NEVER retry/fallback
 * (prevents double-spend) -- a hard invariant with a dedicated test. The mandate `checkTransfer` runs
 * PRE-submit in the gateway for every adapter."
 *
 * This module is that gateway. The agent expresses ONE [`ExecutionIntent`]; the gateway:
 *   1. **quotes** every registered adapter (PRE-build, read-only -- moves nothing), discarding the
 *      not-quotable ones (`quotable: false`);
 *   2. **orders** the quotable candidates by the priced-fallback policy (best `expectedOut` first, ties
 *      broken by the adapter's registration priority) -- design WOW Feature 5 "priced fallback";
 *   3. for each candidate, in order: **builds** the un-signed tx (moves nothing), runs the **mandate
 *      `checkTransfer` gate PRE-submit** (the kill-switch -- design WOW Feature 5 "the mandate `checkTransfer`
 *      runs PRE-submit in the gateway for every adapter"), runs the **GAS-FLOOR gate PRE-submit** (design
 *      SS3a -- the "can't deplete gas" kill-switch: it asserts, on the agent's own native balance, that the
 *      action + its gas keeps the native reserve above `minGasReserve`, else REFUSES; the action's native
 *      cost is summed from the BUILT tx's call `value`s, so it reflects exactly what would be broadcast),
 *      then **submits** (the ONLY value-moving step);
 *   4. applies the **fund-loss-safe `value_moved` short-circuit**: the instant `submit` has put value in
 *      flight (it returned a real [`OrderId`]), the gateway STOPS -- it NEVER retries or falls back, because
 *      a re-broadcast could double-spend. A PRE-submit failure (a bad quote, a failed build, a blocked gate,
 *      a not-wired signer) moved NOTHING, so the gateway falls back freely to the next candidate.
 *
 * ## The fund-loss-safe boundary is structural (design WOW Feature 5 -- the hard invariant)
 *
 * The split between `buildUnsigned` (pure -- no value) and `submit` (the only value-mover) is what makes the
 * short-circuit safe. The gateway tracks ONE boolean -- `valueInFlight` -- that flips `true` the instant it
 * begins a `submit` it cannot prove was a pre-broadcast no-op. Concretely:
 *   - everything strictly BEFORE the first `submit` call (quote, build, the mandate gate) is fallback-safe:
 *     a failure there moved nothing, so the gateway tries the next candidate;
 *   - a `submit` that RETURNS an [`OrderId`] => value moved => STOP (short-circuit; return the order);
 *   - a `submit` that THROWS is the dangerous middle case: a not-wired signer is a guaranteed pre-broadcast
 *     refusal (the adapter contract: `submit` fails CLOSED with a loud not-wired error BEFORE touching the
 *     signer), so the gateway may safely fall back; but ANY OTHER `submit` throw (a live-signer failure that
 *     could have broadcast) is treated as **possibly value-moving** -- the gateway STOPS and refuses to fall
 *     back (fund-loss-safe: never risk a double-spend on an ambiguous broadcast). This is the conservative
 *     default -- it errs toward STOP, never toward retry.
 *
 * The gateway NEVER mints a settlement verdict -- "did it settle?" is the independent verifier's monopoly
 * (design SS3 principle 2). It reports only "which adapter dispatched, with what order id" or "every
 * candidate was refused pre-submit, here is each reason" -- honestly, never a fabricated success
 * (design SS3 principle 3).
 *
 * ## Offline-by-default (design SS6)
 *
 * The gateway touches the chain ONLY through the seams the adapters use -- `ctx.transport` (the `eth_call`
 * reader for the quote + the gate) and `ctx.signer` (the operator-wired live signer for `submit`). With no
 * signer wired, `submit` fails CLOSED for every adapter, so a default-build `execute` plans + gates every
 * candidate and dispatches NOTHING -- the honest dry-run (`GatewayOutcome.NO_DISPATCH`). `tsc` and the
 * default path are fully offline.
 *
 * ## Exact-integer money (design SS3 principle 5)
 *
 * Every amount the gateway compares (the quotes' `expectedOut`, the gate amount) is a `bigint` in MINOR
 * units. The candidate ordering compares `bigint`s directly -- no float, ever.
 *
 * ## Clean-room (design SS6)
 *
 * No proprietary identifier, private path, or secret. The gateway is generic over any [`ExecutionConnector`];
 * the protocol-specific public facts live in the adapters + config, never here.
 */

import { checkMandate, MandateError, type MandateConfig, type MandateVerdict } from "./mandate.js";
import {
  checkGasFloor,
  GasFloorError,
  type GasFloorConfig,
  type GasFloorVerdict,
} from "./gasfloor.js";
import {
  ConnectorError,
  type ExecutionConnector,
  type ExecutionIntent,
  type ConnectorContext,
  type Quote,
  type UnsignedTx,
  type OrderId,
  type OrderStatus,
  type ProtocolKind,
} from "./connector.js";

/** A loud failure on the gateway dispatch path (design SS3 principle 3 -- degrade loudly, never fabricate). */
export class GatewayError extends Error {
  public override readonly name = "GatewayError";
  public constructor(message: string) {
    super(message);
    Object.setPrototypeOf(this, GatewayError.prototype);
  }
}

/**
 * Where a `gateway.execute` run ended -- the honest, structured outcome (design SS3 principle 3).
 *
 *  - `DISPATCHED`   -- a candidate's `submit` put value in flight (returned an [`OrderId`]); the gateway
 *                      STOPPED (the `value_moved` short-circuit). The verifier mints the settlement verdict.
 *  - `NO_DISPATCH`  -- every candidate was refused PRE-submit (not quotable / build failed / gate blocked /
 *                      signer not wired). NOTHING moved value -- the honest dry-run / all-blocked result.
 *  - `NO_CANDIDATE` -- no registered adapter could even quote the intent (every adapter `quotable: false`).
 */
export const GatewayOutcome = {
  /** A candidate submitted and value moved on-chain -- the gateway STOPPED (short-circuit). */
  DISPATCHED: "dispatched",
  /** Every candidate was refused PRE-submit -- nothing moved value (dry-run / all-blocked). */
  NO_DISPATCH: "no_dispatch",
  /** No registered adapter could quote the intent at all. */
  NO_CANDIDATE: "no_candidate",
} as const;

/** The furthest a `gateway.execute` run reached. */
export type GatewayOutcome = (typeof GatewayOutcome)[keyof typeof GatewayOutcome];

/** Why a single candidate adapter was refused PRE-submit (each is fallback-safe -- nothing moved). */
export const AttemptStage = {
  /** The adapter could not quote the intent (`quotable: false`) -- skipped before any build. */
  NOT_QUOTABLE: "not_quotable",
  /** `buildUnsigned` failed (a malformed intent / unconfigured venue) -- nothing moved. */
  BUILD_FAILED: "build_failed",
  /** The mandate `checkTransfer` gate did NOT clear (over-cap / unread / not-wired) -- the kill-switch. */
  BLOCKED_BY_MANDATE: "blocked_by_mandate",
  /**
   * The GAS-FLOOR gate did NOT clear (the action would deplete the native reserve / the balance was
   * unread / not-wired) -- the "can't deplete gas" kill-switch (design SS3a). Fallback-safe (PRE-submit).
   */
  BLOCKED_BY_GAS_FLOOR: "blocked_by_gas_floor",
  /** `submit` failed CLOSED pre-broadcast (a not-wired live signer) -- nothing moved; fallback-safe. */
  SUBMIT_NOT_WIRED: "submit_not_wired",
} as const;

/** The stage at which a candidate was refused PRE-submit (one of [`AttemptStage`]). */
export type AttemptStage = (typeof AttemptStage)[keyof typeof AttemptStage];

/**
 * The record of ONE candidate adapter's attempt -- the honest per-candidate account the gateway keeps so the
 * caller sees exactly why each adapter was tried + skipped (priced fallback transparency). NEVER a fabricated
 * success: a dispatched candidate has `dispatched: true` + an [`OrderId`]; every other is a refusal `reason`.
 */
export interface CandidateAttempt {
  /** Which protocol family this candidate served (the honesty label). */
  readonly protocol: ProtocolKind;
  /** The adapter's quote for the intent (present once quoted; carries `expectedOut` for the ordering). */
  readonly quote: Quote | undefined;
  /** The mandate gate's verdict for this candidate (present once the gate ran PRE-submit). */
  readonly mandate: MandateVerdict | undefined;
  /**
   * The GAS-FLOOR gate's verdict for this candidate (present once the gas floor ran PRE-submit, i.e. once
   * the mandate gate cleared). `undefined` if the candidate never reached the gas floor (mandate blocked
   * it first), or if the gas floor is disabled in config (the gateway then records the disabled note).
   */
  readonly gasFloor: GasFloorVerdict | undefined;
  /** `true` iff this candidate's `submit` put value in flight (returned a real [`OrderId`]). */
  readonly dispatched: boolean;
  /** The real on-chain/rail order id iff `dispatched`; `undefined` otherwise. NEVER fabricated. */
  readonly order: OrderId | undefined;
  /** If NOT dispatched, the stage it was refused at; `undefined` for the dispatched candidate. */
  readonly refusedAt: AttemptStage | undefined;
  /** A human-readable, journal-only note explaining this candidate's outcome. Never the source of truth. */
  readonly note: string;
}

/**
 * The honest, structured account of one `gateway.execute` run (design SS3 principle 3). It states exactly how
 * the run ended ([`outcome`]), which candidate (if any) dispatched, and the full per-candidate trail. Nothing
 * here is ever a fabricated settlement -- the gateway reports dispatch, never settlement (the verifier's job).
 */
export interface GatewayResult {
  /** How the run ended (one of [`GatewayOutcome`]). */
  readonly outcome: GatewayOutcome;
  /** The protocol that dispatched, iff `outcome === DISPATCHED`; `undefined` otherwise. */
  readonly dispatchedProtocol: ProtocolKind | undefined;
  /** The dispatched order id, iff `outcome === DISPATCHED`; `undefined` otherwise. NEVER fabricated. */
  readonly order: OrderId | undefined;
  /** The per-candidate trail, in the order the gateway tried them (best-quote-first). */
  readonly attempts: readonly CandidateAttempt[];
  /** A human-readable, journal-only summary. Never the source of truth, never a settlement claim. */
  readonly note: string;
}

/**
 * A registered adapter + its tie-break priority. The gateway orders quotable candidates by best `expectedOut`
 * first (priced fallback); when two adapters quote an identical `expectedOut`, the LOWER `priority` wins
 * (a deterministic tie-break -- design SS3 principle 4). Priority is the operator's stated preference, not a
 * trust signal.
 */
export interface RegisteredAdapter {
  /** The adapter (an [`ExecutionConnector`]). */
  readonly adapter: ExecutionConnector;
  /** The tie-break priority (lower = preferred on an equal quote). Defaults to registration order. */
  readonly priority: number;
}

/** The gateway's config -- the mandate registry to gate against + the registered adapters + the gas floor. */
export interface GatewayConfig {
  /** The mandate registry the PRE-submit `checkTransfer` gate runs against (from operator config). */
  readonly mandate: MandateConfig;
  /** The registered adapters (at least one). The agent never names one; the gateway dispatches over quotes. */
  readonly adapters: readonly RegisteredAdapter[];
  /**
   * The PRE-submit GAS-FLOOR config (design SS3a -- the "can't deplete gas" kill-switch). The native
   * reserve to protect (`minGasReserve`) + the on/off knob, from operator config (`proofagent.toml
   * [gas_floor]`). OPTIONAL for backward-compatibility: when omitted the gateway treats the floor as
   * DISABLED (it does not gate on it) -- but a present config with `enabled: true` makes the floor a hard
   * PRE-submit precondition for every value-moving candidate, exactly like the mandate gate.
   */
  readonly gasFloor?: GasFloorConfig;
  /**
   * The conservatively-estimated gas fee (native wei, `bigint`) a broadcast will burn, fed to the
   * gas-floor gate alongside the action's native cost. From operator config (`proofagent.toml
   * [gas_floor].est_gas_fee`). Defaults to `0n` when omitted -- so the floor still bounds the action's own
   * native cost even before a fee estimate is wired (the fee only TIGHTENS the floor, never loosens it).
   */
  readonly estGasFee?: bigint;
}

/**
 * The protocol-agnostic gateway -- `execute(intent)` is the ONLY entrypoint the agent calls (design WOW
 * Feature 5). It never exposes a per-protocol method; the agent expresses an [`ExecutionIntent`] and the
 * gateway dispatches over the registered adapters' quotes.
 */
export interface Gateway {
  /**
   * Dispatch one [`ExecutionIntent`] over the registered adapters -- quote, order (priced fallback), then for
   * each candidate build -> mandate-gate (PRE-submit) -> submit, stopping the instant value moves (the
   * fund-loss-safe short-circuit). Returns a [`GatewayResult`] (the honest per-candidate trail).
   * @throws {GatewayError} on a programmer error (a malformed intent surfaced by an adapter's `quote`), or
   *   on the fund-loss-safe STOP after an ambiguous `submit` throw (a possibly-broadcast live-signer failure).
   */
  execute(intent: ExecutionIntent, ctx: ConnectorContext): Promise<GatewayResult>;
}

/**
 * Order the quotable candidates by the priced-fallback policy: best `expectedOut` DESC, ties broken by the
 * LOWER registration `priority` (deterministic -- design SS3 principle 4). A candidate without an
 * `expectedOut` (defensive: a `quotable: true` quote should always carry one) sorts last. Pure; no I/O.
 */
function orderCandidates(
  candidates: readonly { reg: RegisteredAdapter; quote: Quote }[],
): readonly { reg: RegisteredAdapter; quote: Quote }[] {
  return [...candidates].sort((a, b) => {
    const ax = a.quote.expectedOut;
    const bx = b.quote.expectedOut;
    if (ax !== bx) {
      if (ax === undefined) return 1; // a sorts after b
      if (bx === undefined) return -1; // b sorts after a
      return bx > ax ? 1 : -1; // larger expectedOut first
    }
    // Equal quote -> lower priority wins (deterministic tie-break).
    return a.reg.priority - b.reg.priority;
  });
}

/**
 * Build the protocol-agnostic gateway over `config` (design WOW Feature 5). The gateway dispatches `execute`
 * over the registered adapters; it never exposes a per-protocol method, so the agent CANNOT call a specific
 * protocol -- it can only express an intent.
 *
 * @throws {GatewayError} if no adapters are registered (a gateway with nothing to dispatch over is a
 *   programmer error, surfaced loudly at construction).
 */
export function makeGateway(config: GatewayConfig): Gateway {
  if (!Array.isArray(config.adapters) || config.adapters.length === 0) {
    throw new GatewayError("makeGateway: at least one adapter must be registered (nothing to dispatch over).");
  }
  const registered = config.adapters;
  const mandate = config.mandate;
  // The gas-floor config + the estimated gas fee. An absent config means the floor is DISABLED (the
  // gateway does not gate on it -- backward-compatible); a present `enabled: true` makes it a hard
  // PRE-submit precondition. `estGasFee` only ever tightens the floor (it is added to the action cost).
  const gasFloorConfig: GasFloorConfig = config.gasFloor ?? { minGasReserve: 0n, enabled: false };
  const estGasFee: bigint = config.estGasFee ?? 0n;

  return {
    async execute(intent: ExecutionIntent, ctx: ConnectorContext): Promise<GatewayResult> {
      const attempts: CandidateAttempt[] = [];

      // --- (1) quote every registered adapter (PRE-build, read-only -- moves NOTHING) ---------------
      // A quote() throw is a programmer error in the intent (a malformed address/amount) -- loud, surfaced
      // before any dispatch (it is identical across adapters, so the first surfaces it). A quotable:false is
      // the honest "this adapter can't serve this intent" -> recorded + skipped (never a value-moving failure).
      const quotable: { reg: RegisteredAdapter; quote: Quote }[] = [];
      for (const reg of registered) {
        let quote: Quote;
        try {
          quote = await reg.adapter.quote(intent, ctx);
        } catch (err) {
          if (err instanceof ConnectorError) {
            // A malformed intent -- loud programmer error, before ANY value could move.
            throw new GatewayError(`gateway.execute: ${reg.adapter.protocol} adapter rejected the intent: ${err.message}`);
          }
          throw err;
        }
        if (!quote.quotable) {
          attempts.push({
            protocol: reg.adapter.protocol,
            quote,
            mandate: undefined,
            gasFloor: undefined,
            dispatched: false,
            order: undefined,
            refusedAt: AttemptStage.NOT_QUOTABLE,
            note: `not quotable: ${quote.reason}`,
          });
          continue;
        }
        quotable.push({ reg, quote });
      }

      if (quotable.length === 0) {
        return {
          outcome: GatewayOutcome.NO_CANDIDATE,
          dispatchedProtocol: undefined,
          order: undefined,
          attempts,
          note:
            "gateway.execute: no registered adapter could quote the intent (every adapter quotable:false). " +
            "Nothing was built, gated, or dispatched -- no value moved.",
        };
      }

      // --- (2) order by priced fallback: best expectedOut first, ties by lower registration priority ----
      const ordered = orderCandidates(quotable);

      // --- (3) for each candidate, in order: build -> mandate-gate (PRE-submit) -> submit ---------------
      for (const { reg, quote } of ordered) {
        const adapter = reg.adapter;

        // (3a) build the un-signed tx (PURE -- moves NOTHING). A build failure is fallback-safe.
        let tx: UnsignedTx;
        try {
          tx = await adapter.buildUnsigned(intent, ctx);
        } catch (err) {
          if (err instanceof ConnectorError) {
            attempts.push({
              protocol: adapter.protocol,
              quote,
              mandate: undefined,
              gasFloor: undefined,
              dispatched: false,
              order: undefined,
              refusedAt: AttemptStage.BUILD_FAILED,
              note: `build failed (pre-submit, nothing moved): ${err.message}`,
            });
            continue; // fallback-safe: the build moved nothing.
          }
          throw err;
        }

        // (3b) the mandate checkTransfer gate, PRE-SUBMIT, for EVERY adapter (design WOW Feature 5). It gates
        // the SAME (agent, tokenIn, amountIn) the intent proposes -- the kill-switch, enforced before submit.
        let verdict: MandateVerdict;
        try {
          verdict = await checkMandate(
            { agent: intent.agent, token: intent.tokenIn, amount: intent.amountIn },
            mandate,
            ctx.transport,
          );
        } catch (err) {
          if (err instanceof MandateError) {
            // A malformed spend request -- loud programmer error, before any submit (nothing moved).
            throw new GatewayError(`gateway.execute: mandate gate rejected the spend request: ${err.message}`);
          }
          throw err;
        }
        if (!verdict.allowed) {
          // THE KILL-SWITCH (design SS5 / WOW Feature 5): a non-allowed gate STOPS this candidate PRE-submit.
          // It moved NOTHING, so the gateway falls back to the next candidate.
          attempts.push({
            protocol: adapter.protocol,
            quote,
            mandate: verdict,
            gasFloor: undefined,
            dispatched: false,
            order: undefined,
            refusedAt: AttemptStage.BLOCKED_BY_MANDATE,
            note:
              `mandate gate BLOCKED (reason: ${String(verdict.reason)}; verified=${String(verdict.verified)}) ` +
              "-- this candidate did NOT submit (the cap is a kill-switch, enforced PRE-submit). Falling back.",
          });
          continue; // fallback-safe: the gate is pre-submit; nothing moved.
        }

        // (3c) the GAS-FLOOR gate, PRE-SUBMIT, for EVERY adapter (design SS3a -- the "can't deplete gas"
        // kill-switch). The action's native cost is the SUM of the BUILT tx's call `value`s (the native
        // `msg.value`s it would attach -- a native CCIP fee, a native-token egress), so it reflects exactly
        // what would be broadcast; the estimated gas fee is added on top. It asserts, on the agent's OWN
        // on-chain balance, that the native reserve stays above `minGasReserve`. When the floor is DISABLED
        // (no config / enabled:false) the gateway SKIPS the gate (it records the disabled verdict, never an
        // allow). A breached/unread/not-wired floor STOPS this candidate PRE-submit (it moved NOTHING), so
        // the gateway falls back -- the safest depletion failure is the one that never broadcasts.
        let gasVerdict: GasFloorVerdict | undefined;
        if (gasFloorConfig.enabled === true) {
          const actionNativeCost = tx.calls.reduce((sum, c) => sum + c.value, 0n);
          try {
            gasVerdict = await checkGasFloor(
              { agent: intent.agent, actionNativeCost, estGasFee },
              gasFloorConfig,
              ctx.balanceSource,
            );
          } catch (err) {
            if (err instanceof GasFloorError) {
              // A malformed spend request -- loud programmer error, before any submit (nothing moved).
              throw new GatewayError(`gateway.execute: gas-floor gate rejected the spend request: ${err.message}`);
            }
            throw err;
          }
          if (!gasVerdict.allowed) {
            // THE GAS-FLOOR KILL-SWITCH (design SS3a): a non-allowed floor STOPS this candidate PRE-submit.
            // It moved NOTHING, so the gateway falls back to the next candidate.
            attempts.push({
              protocol: adapter.protocol,
              quote,
              mandate: verdict,
              gasFloor: gasVerdict,
              dispatched: false,
              order: undefined,
              refusedAt: AttemptStage.BLOCKED_BY_GAS_FLOOR,
              note:
                `gas-floor gate BLOCKED (reason: ${String(gasVerdict.reason)}; verified=` +
                `${String(gasVerdict.verified)}; remaining=${gasVerdict.remaining === undefined ? "<unread>" : gasVerdict.remaining.toString()}) ` +
                "-- this candidate did NOT submit (the gas floor is a kill-switch: it would deplete the " +
                "native reserve below minGasReserve and brick the wallet). Falling back.",
            });
            continue; // fallback-safe: the gas floor is pre-submit; nothing moved.
          }
        }

        // (3d) SUBMIT -- the ONLY value-moving step. This is the fund-loss-safe boundary: from here on a
        // success means value has moved, and the gateway must NEVER retry/fall back (design WOW Feature 5).
        let order: OrderId;
        try {
          order = await adapter.submit(tx, ctx);
        } catch (err) {
          const detail = err instanceof Error ? err.message : String(err);
          // A not-wired live signer is a GUARANTEED pre-broadcast refusal (the adapter contract: submit fails
          // CLOSED with a loud not-wired error BEFORE touching the signer). That moved nothing -> fallback-safe.
          if (err instanceof ConnectorError && /NOT_WIRED/.test(detail)) {
            attempts.push({
              protocol: adapter.protocol,
              quote,
              mandate: verdict,
              gasFloor: gasVerdict,
              dispatched: false,
              order: undefined,
              refusedAt: AttemptStage.SUBMIT_NOT_WIRED,
              note:
                `submit fails CLOSED (pre-broadcast, nothing moved): ${detail}. The live signer is operator-` +
                "gated; in a dry-run nothing is dispatched. Falling back to the next candidate.",
            });
            continue; // fallback-safe: a not-wired signer never broadcast.
          }
          // ANY OTHER submit throw is AMBIGUOUS -- the live signer may have broadcast before failing. The
          // fund-loss-safe rule is to STOP and refuse to fall back (never risk a double-spend on an unknown
          // broadcast state). This is the conservative default (design WOW Feature 5 -- the hard invariant).
          attempts.push({
            protocol: adapter.protocol,
            quote,
            mandate: verdict,
            gasFloor: gasVerdict,
            dispatched: false,
            order: undefined,
            refusedAt: undefined,
            note:
              `submit FAILED ambiguously (the live signer may have broadcast): ${detail}. FUND-LOSS-SAFE STOP ` +
              "-- the gateway refuses to fall back (a re-dispatch could double-spend). Hand off to the verifier.",
          });
          throw new GatewayError(
            `gateway.execute: ${adapter.protocol} submit failed after the gate cleared and value may have moved ` +
              `(${detail}). FUND-LOSS-SAFE STOP -- the gateway will NOT retry or fall back (it could double-spend). ` +
              "The independent verifier must read the chain to determine whether anything settled.",
          );
        }

        // (3e) SUBMIT RETURNED an order -> value moved -> SHORT-CIRCUIT. STOP; never try another candidate.
        attempts.push({
          protocol: adapter.protocol,
          quote,
          mandate: verdict,
          gasFloor: gasVerdict,
          dispatched: true,
          order,
          refusedAt: undefined,
          note:
            `DISPATCHED via ${adapter.protocol} (${order.refs.length} ref) -- value moved on-chain. The gateway ` +
            "SHORT-CIRCUITS here (value_moved): it never retries or falls back (design WOW Feature 5). The " +
            "independent verifier reads the chain to mint the settlement verdict (this gateway never claims settled).",
        });
        return {
          outcome: GatewayOutcome.DISPATCHED,
          dispatchedProtocol: adapter.protocol,
          order,
          attempts,
          note:
            `gateway.execute: DISPATCHED via ${adapter.protocol} after ${attempts.length} candidate attempt(s); ` +
            "value moved, so the gateway short-circuited (no fallback). The verifier mints the settlement verdict.",
        };
      }

      // Every quotable candidate was refused PRE-submit (build / gate / not-wired signer) -- nothing moved.
      return {
        outcome: GatewayOutcome.NO_DISPATCH,
        dispatchedProtocol: undefined,
        order: undefined,
        attempts,
        note:
          `gateway.execute: every candidate (${attempts.length}) was refused PRE-submit (build failed / gate ` +
          "blocked / signer not wired) -- NOTHING moved value (the honest dry-run / all-blocked result). " +
          "No settlement is claimed (the verifier's job).",
      };
    },
  };
}

/**
 * Read a dispatched order's lifecycle [`OrderStatus`] through the adapter that owns it -- a thin convenience
 * over the contract's `status`, so a caller need not re-resolve the adapter. The `valueMoved` flag the
 * gateway short-circuits on is the adapter's honest read; an unreadable order degrades loudly to UNKNOWN.
 *
 * @throws {GatewayError} if no registered adapter serves the order's protocol (a programmer error).
 */
export async function statusOf(
  gatewayConfig: GatewayConfig,
  order: OrderId,
  ctx: ConnectorContext,
): Promise<OrderStatus> {
  const reg = gatewayConfig.adapters.find((a) => a.adapter.protocol === order.protocol);
  if (reg === undefined) {
    throw new GatewayError(`statusOf: no registered adapter serves protocol ${order.protocol}.`);
  }
  return reg.adapter.status(order, ctx);
}
