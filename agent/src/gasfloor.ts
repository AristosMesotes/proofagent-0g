/**
 * The gas floor -- `checkGasFloor(...)`: the pre-broadcast "can't deplete gas" kill-switch.
 *
 * Design SS3a (the gas floor -- "can't deplete gas"): a money-safety primitive. The RISK is that the
 * agent spends native 0G (the gas token) down to ~0 -- by burning it on fees, or by swapping / bridging
 * it away -- and is then STUCK: it can no longer pay for ANY transaction, so it cannot send a recovery
 * tx, cannot `cancelBridgeOut` a still-pending egress, and cannot move funds at all. A wallet that
 * cannot afford its own next transaction is a bricked wallet.
 *
 * The fix is a hard **gas floor**: a reserve of native 0G (`minGasReserve`) the agent must never spend
 * below. Before ANY value-moving action, the gateway asserts -- on the agent's own balance --
 *
 *     nativeBalance - actionNativeCost - estGasFee  >=  minGasReserve
 *
 * and REFUSES the action PRE-broadcast (the kill-switch) when the inequality does not hold. Like the
 * mandate cap, this gate is the SECOND kind of "can't overspend" -- the mandate bounds how much of an
 * *asset* leaves; the gas floor bounds how low the *native reserve* may fall, so the agent always keeps
 * enough 0G to pay for its own recovery.
 *
 * ## Where this sits in the loop (design SS3a + SS5)
 *
 * It is a pre-submit precondition in the gateway, evaluated for EVERY adapter alongside the mandate
 * `checkTransfer` gate (`gateway.ts`): a built (un-signed) action is gas-floor-checked BEFORE `submit`,
 * so a depleting action is refused before any broadcast -- nothing moves. The verifier then CONFIRMS,
 * post-action, that the native reserve actually held on-chain (`verifier/src/gasfloor.rs`): a depletion
 * the gate should have blocked reads as a LOUD `refuted` via the verdict monopoly, never a silent pass.
 *
 * ## Fail-CLOSED (design SS3 principle 3 + SS3a)
 *
 * Exactly like the mandate gate, the gas floor fails CLOSED. The action proceeds ONLY when the reserve
 * provably holds against a real on-chain balance read. Every other outcome -- an unreadable balance
 * (no transport, RPC error, malformed reply), an unconfigured / disabled floor, or a reserve that would
 * be breached -- yields `allowed: false`. There is NO path in which an unread or failed gas-floor check
 * returns `allowed: true`: a buggy or hijacked agent cannot deplete the wallet by making the check
 * merely *fail to answer*. When the floor is unread, `verified` is `false` (and `allowed` is therefore
 * `false`), kept deliberately distinct from a read floor that was breached (`verified: true`,
 * `allowed: false`).
 *
 * ## Two-source truth at the balance read (design SS3 principle 1)
 *
 * The agent's *claim* of what it will spend is only a proposal; the chain's `eth_getBalance` of the
 * agent is the *fact* the reserve is checked against. The read goes through one narrow seam --
 * [`NativeBalanceSource`] -- which a live JSON-RPC reader and an offline test double both satisfy, so a
 * recorded balance and a real one are interchangeable and the decision logic never changes (mirroring
 * the mandate gate's `EthCallTransport` and the verifier's `Source`).
 *
 * ## Default build needs no network (design SS6, offline-by-default)
 *
 * The decision arithmetic is std-only -- zero runtime dependencies, no I/O. The only network leg is
 * [`fetchNativeBalanceSource`], which a caller must EXPLICITLY construct with an RPC endpoint;
 * [`checkGasFloor`] called without a source performs NO network access and returns a loud not-wired
 * DO-NOT-EXECUTE. So `tsc` and the default loop are fully offline; the live `eth_getBalance` is opt-in,
 * supplied by the operator's config.
 *
 * ## Exact-integer money (design SS3 principle 5)
 *
 * Every amount here is a `bigint` in native MINOR units (wei) -- never `number`, never a float. The
 * reserve inequality is exact-integer `bigint` arithmetic; there is no floating-point on this money path.
 *
 * ## Clean-room (design SS6)
 *
 * No proprietary identifier, private path, or secret appears here. The native balance is read via the
 * public `eth_getBalance` JSON-RPC method; the floor amount comes from config (the data spine), never a
 * baked-in target.
 */

/**
 * The agent's proposed value-moving action, priced in NATIVE minor units (wei) -- the **Claim** the gas
 * floor checks. `actionNativeCost` is how much native 0G this specific action itself moves OUT of the
 * agent (the `msg.value` it attaches -- e.g. a native CCIP fee paid as `value`, or a native-token egress
 * amount); it is `0n` for a pure ERC-20 action that attaches no native value. `estGasFee` is the
 * conservatively-estimated fee the broadcast will burn (gas limit * gas price, in wei). BOTH are
 * subtracted from the live balance before comparing to the reserve, so the floor accounts for the action
 * AND the cost of broadcasting it.
 */
export interface GasFloorRequest {
  /** The agent address whose native balance is the reserve being protected (gate-checked, on-chain). */
  readonly agent: string;
  /**
   * The native 0G (wei) this action itself moves OUT of the agent as `msg.value` (a native CCIP fee, a
   * native-token egress amount, ...). `0n` for a pure ERC-20 action that attaches no native value.
   */
  readonly actionNativeCost: bigint;
  /**
   * The conservatively-estimated gas fee the broadcast will burn (gas limit * gas price, wei). Always
   * subtracted, so even a `0`-native action must still leave the reserve intact AFTER paying its own gas.
   */
  readonly estGasFee: bigint;
}

/**
 * The gas-floor config -- the reserve to protect (`minGasReserve`, native wei) + the on/off knob.
 *
 * `minGasReserve` is read from operator config (`proofagent.toml [gas_floor].min_gas_reserve`) -- never
 * hardcoded, so the protected floor is a data-spine value, tunable per network. `enabled` is the explicit
 * knob: when `false` the floor is OFF (the gateway does not gate on it) -- but turning it off is itself an
 * honest, visible config decision (the gateway records `verified: false, reason: GAS_FLOOR_DISABLED`),
 * never a silent bypass. A negative reserve is rejected loudly by [`checkGasFloor`] (it would be
 * meaningless).
 */
export interface GasFloorConfig {
  /** The native reserve to keep (wei, `bigint`) -- the agent must never spend below this. */
  readonly minGasReserve: bigint;
  /** `true` to enforce the floor (the default intent); `false` turns it OFF (an explicit, visible knob). */
  readonly enabled: boolean;
}

/**
 * The gas floor's single, honest decision -- the **kill-switch** output (design SS3a).
 *
 * `allowed` is the gateway's instruction: `true` => the reserve provably holds, proceed; `false` => DO
 * NOT broadcast (the action would deplete the gas reserve, or the floor could not be read). It is `true`
 * ONLY when a real on-chain balance read proves `balance - actionNativeCost - estGasFee >= minGasReserve`.
 * `reason` is a loud tag for the journal/UI; `verified` is `true` iff an actual balance read happened.
 */
export interface GasFloorVerdict {
  /** `true` iff the native reserve provably HOLDS after this action (a real read + the inequality). */
  readonly allowed: boolean;
  /** A reason tag (one of [`GAS_FLOOR_REASON`]) for the journal/UI; never changes the meaning of `allowed`. */
  readonly reason: GasFloorReason;
  /**
   * `true` iff the live `eth_getBalance` actually answered (the verdict reflects a real read); `false`
   * iff the floor could not be read (no source, RPC error, malformed reply) or is disabled. When `false`,
   * `allowed` is ALWAYS `false` -- an unread floor never permits an action (fail-closed, design SS3 #3).
   */
  readonly verified: boolean;
  /**
   * The exact-integer reserve that WOULD remain after the action (`balance - actionNativeCost -
   * estGasFee`), present iff a balance was read; `undefined` when unread/disabled. Journal/UI evidence
   * only -- the typed `allowed`/`verified` are the source of truth.
   */
  readonly remaining: bigint | undefined;
}

/**
 * The reason tags a [`GasFloorVerdict`] carries. Exactly one of these explains every decision; they are
 * distinct so the journal/UI can render WHY an action was refused (and an `OK` is the only allow tag).
 */
export const GAS_FLOOR_REASON = {
  /** The reserve provably holds after the action -- the ONLY `allowed: true` reason. */
  OK: "OK",
  /** The action would push the native reserve BELOW `minGasReserve` -- the depletion kill-switch fired. */
  WOULD_DEPLETE_RESERVE: "WOULD_DEPLETE_RESERVE",
  /** No balance source was wired -- the floor could not be read (fail-closed not-wired). */
  NOT_WIRED: "NOT_WIRED",
  /** The on-chain balance read failed (RPC error / malformed reply) -- fail-closed, never an allow. */
  BALANCE_UNREAD: "BALANCE_UNREAD",
  /** The floor is explicitly disabled in config (`enabled: false`) -- an honest, visible off-state. */
  DISABLED: "GAS_FLOOR_DISABLED",
} as const;

/** A gas-floor reason tag (one of [`GAS_FLOOR_REASON`]). */
export type GasFloorReason = (typeof GAS_FLOOR_REASON)[keyof typeof GAS_FLOOR_REASON];

/**
 * The independent native-balance read seam -- an `eth_getBalance` reader (mirrors the mandate gate's
 * [`EthCallTransport`] and the verifier's `Source`). A live JSON-RPC reader and an offline test double
 * both satisfy it, so the gas-floor decision logic is identical whether it reads the real chain or a
 * recorded reply.
 *
 * An implementation returns the agent's native balance in wei as a `bigint`, or throws on any transport
 * failure (the gate maps a throw to a loud, fail-closed DO-NOT-EXECUTE -- it never lets a transport error
 * become an allow).
 */
export interface NativeBalanceSource {
  /**
   * Read the native balance (wei) of `agent` at the latest block.
   * @param agent the address whose native reserve is being protected.
   * @returns the balance in wei as a non-negative `bigint`.
   * @throws on any transport/RPC failure -- the gate treats a throw as DO-NOT-EXECUTE.
   */
  nativeBalance(agent: string): Promise<bigint>;
}

/** A loud gas-floor failure (design SS3 principle 3 -- degrade loudly). Thrown ONLY for a malformed request. */
export class GasFloorError extends Error {
  public override readonly name = "GasFloorError";
  public constructor(message: string) {
    super(message);
    Object.setPrototypeOf(this, GasFloorError.prototype);
  }
}

/** Match a 20-byte EVM address: `0x` + exactly 40 hex digits (case-insensitive). */
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/**
 * Validate + normalize the agent address to lowercase `0x` + 40 hex. A malformed address is a loud
 * [`GasFloorError`] (never silently zero-padded) -- a wrong address would read the wrong reserve.
 */
function normalizeAgent(addr: string): string {
  if (typeof addr !== "string" || !ADDRESS_RE.test(addr.trim())) {
    throw new GasFloorError(`agent must be a 20-byte 0x address (0x + 40 hex), got ${String(addr)}`);
  }
  return addr.trim().toLowerCase();
}

/**
 * Validate a non-negative native-wei `bigint` (an action cost, a fee, the reserve). A negative or
 * non-`bigint` value is a loud [`GasFloorError`] (exact-integer money path -- design SS3 principle 5).
 */
function requireNonNegBigint(label: string, value: bigint): bigint {
  if (typeof value !== "bigint") {
    throw new GasFloorError(`${label} must be a bigint in native wei (exact-integer money path)`);
  }
  if (value < 0n) {
    throw new GasFloorError(`${label} must be non-negative, got ${value.toString()}`);
  }
  return value;
}

/**
 * The gas-floor gate -- assert the native reserve HOLDS after `req`, as a pre-broadcast `eth_getBalance`
 * read (design SS3a). Returns a [`GasFloorVerdict`] whose `allowed` is the gateway's kill-switch
 * instruction.
 *
 * The reserve inequality, evaluated on the agent's REAL on-chain balance (exact-integer, design SS3 #5):
 *
 *     remaining = balance - actionNativeCost - estGasFee
 *     allowed   = remaining >= minGasReserve
 *
 * Fail-CLOSED in every non-OK path (design SS3 principle 3 + SS3a):
 *  - floor disabled (`enabled: false`)  => `verified: false`, `allowed: false` (loud `GAS_FLOOR_DISABLED`).
 *  - no `source` supplied               => `verified: false`, `allowed: false` (loud `NOT_WIRED`).
 *  - `source.nativeBalance` throws       => `verified: false`, `allowed: false` (loud `BALANCE_UNREAD`).
 *  - reserve WOULD be breached          => `verified: true`,  `allowed: false` (`WOULD_DEPLETE_RESERVE`).
 *  - reserve provably holds             => `verified: true`,  `allowed: true`  (the ONLY allow path).
 *
 * It NEVER throws for an operational failure -- it returns a fail-closed verdict so the gateway always
 * gets a definitive proceed/refuse answer. It DOES throw [`GasFloorError`] for a programmer error in the
 * *request/config* (a malformed agent address, a negative amount, a negative reserve), surfaced before
 * any read.
 *
 * @param req     The proposed action priced in native wei (agent, action native cost, est gas fee).
 * @param config  The reserve to protect + the on/off knob (from operator config; never hardcoded).
 * @param source  OPTIONAL `eth_getBalance` source. Omit it for a fully offline call that fails closed
 *                with a loud not-wired reason (the default build needs no network -- design SS6).
 */
export async function checkGasFloor(
  req: GasFloorRequest,
  config: GasFloorConfig,
  source?: NativeBalanceSource,
): Promise<GasFloorVerdict> {
  // Validate the request + config up front -- a malformed input is a programmer error (loud throw),
  // distinct from an operational failure (fail-closed verdict).
  const agent = normalizeAgent(req.agent);
  const actionNativeCost = requireNonNegBigint("actionNativeCost", req.actionNativeCost);
  const estGasFee = requireNonNegBigint("estGasFee", req.estGasFee);
  const minGasReserve = requireNonNegBigint("minGasReserve", config.minGasReserve);

  // The floor is explicitly OFF. This is an honest, visible config decision (not a silent bypass): the
  // verdict records it loudly so a viewer sees the protection was disabled, never that it passed.
  if (config.enabled !== true) {
    return {
      allowed: false,
      reason: GAS_FLOOR_REASON.DISABLED,
      verified: false,
      remaining: undefined,
    };
  }

  // No source wired => honest "we did not read the balance" => DO NOT broadcast (fail-closed, SS3 #3).
  if (source === undefined) {
    return {
      allowed: false,
      reason: GAS_FLOOR_REASON.NOT_WIRED,
      verified: false,
      remaining: undefined,
    };
  }

  // Read the agent's native balance independently. ANY throw is a transport failure -> fail closed.
  let balance: bigint;
  try {
    balance = await source.nativeBalance(agent);
  } catch {
    return {
      allowed: false,
      reason: GAS_FLOOR_REASON.BALANCE_UNREAD,
      verified: false,
      remaining: undefined,
    };
  }
  // A malformed (negative / non-bigint) balance from a source is treated as unread, never coerced to ok.
  if (typeof balance !== "bigint" || balance < 0n) {
    return {
      allowed: false,
      reason: GAS_FLOOR_REASON.BALANCE_UNREAD,
      verified: false,
      remaining: undefined,
    };
  }

  // The reserve inequality, exact-integer (design SS3 #5). `remaining` may go negative if the action +
  // fee exceed the balance entirely -- that is a depletion (and below any non-negative reserve), caught
  // by the same comparison; we never clamp it, so the journal shows the true (possibly negative) figure.
  const remaining = balance - actionNativeCost - estGasFee;
  const holds = remaining >= minGasReserve;

  return {
    allowed: holds,
    reason: holds ? GAS_FLOOR_REASON.OK : GAS_FLOOR_REASON.WOULD_DEPLETE_RESERVE,
    verified: true,
    remaining,
  };
}

// ----------------------------------------------------------------------------------------------
// fetchNativeBalanceSource -- the live raw-JSON-RPC eth_getBalance leg. OPT-IN: a caller constructs it
// with an endpoint. The default build / checkGasFloor(no source) never touches the network (SS6).
// ----------------------------------------------------------------------------------------------

/**
 * A live native-balance source over raw JSON-RPC (`eth_getBalance`), using the platform `fetch` (design
 * SS2: the verifier "reads 0G via raw JSON-RPC"; the gas floor uses the same raw transport for the
 * balance read).
 *
 * This is the ONLY network leg in the module and it is OPT-IN: a caller must explicitly construct it with
 * an RPC endpoint (read from `OG_RPC` per the data spine -- never hardcoded here). It adds NO runtime
 * dependency: it uses the standard global `fetch`. [`checkGasFloor`] called without a source performs no
 * network access, so the default build stays offline (design SS6).
 *
 * On any non-2xx, malformed JSON, JSON-RPC `error`, missing/`non-hex` `result`, or a negative balance, it
 * THROWS -- which [`checkGasFloor`] maps to a fail-closed DO-NOT-BROADCAST. It never returns a fabricated
 * balance.
 *
 * @param endpoint The JSON-RPC endpoint URL (e.g. from the `OG_RPC` env var).
 */
export function fetchNativeBalanceSource(endpoint: string): NativeBalanceSource {
  if (typeof endpoint !== "string" || endpoint.trim() === "") {
    throw new GasFloorError("fetchNativeBalanceSource requires a non-empty RPC endpoint URL");
  }
  const url = endpoint.trim();
  return {
    async nativeBalance(agent: string): Promise<bigint> {
      const addr = normalizeAgent(agent);
      const payload = {
        jsonrpc: "2.0",
        id: 1,
        method: "eth_getBalance",
        // "latest" reads the current chain head -- the reserve right now, before this action.
        params: [addr, "latest"],
      };
      const resp = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!resp.ok) {
        throw new GasFloorError(`eth_getBalance HTTP ${resp.status} ${resp.statusText}`);
      }
      const json: unknown = await resp.json();
      if (typeof json !== "object" || json === null) {
        throw new GasFloorError("eth_getBalance: non-object JSON-RPC response");
      }
      const rec = json as { error?: { message?: unknown }; result?: unknown };
      if (rec.error !== undefined) {
        const msg = typeof rec.error.message === "string" ? rec.error.message : JSON.stringify(rec.error);
        throw new GasFloorError(`eth_getBalance JSON-RPC error: ${msg}`);
      }
      if (typeof rec.result !== "string" || !/^0x[0-9a-fA-F]+$/.test(rec.result.trim())) {
        throw new GasFloorError("eth_getBalance: JSON-RPC response missing a hex `result`");
      }
      // Parse the hex quantity to an exact-integer bigint (wei). A negative is impossible from a valid
      // balance; BigInt of a 0x hex is always non-negative, so this is exact and safe.
      const balance = BigInt(rec.result.trim());
      if (balance < 0n) {
        throw new GasFloorError(`eth_getBalance returned a negative balance: ${balance.toString()}`);
      }
      return balance;
    },
  };
}
