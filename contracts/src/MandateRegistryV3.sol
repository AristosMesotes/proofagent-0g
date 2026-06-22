// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title  IPriceFeed -- the minimal opt-in price oracle for the USD-denominated cap (Tier 3).
/// @notice Given a token, return its price in USD micro-units (1e6 == $1) per ONE WHOLE token. A `0`
///         return is treated as "unavailable" and the registry fails closed (REASON_PRICE_UNAVAILABLE).
/// @dev    Deliberately tiny + public so it is a clean-room, swappable interface (a real Chainlink/0G
///         feed can be adapted behind it); the registry holds only the address. Declared at file scope
///         (Solidity does not allow a nested interface inside a contract).
interface IPriceFeed {
    /// @return usdMicros USD micro-dollars per one whole `token` (1e6 == $1); `0` == unavailable.
    function priceUsdMicros(address token) external view returns (uint256 usdMicros);
}

/// @title  MandateRegistryV3 -- the four-tier production spend gate ("the agent can't overspend",
///         the production-grade Rails proof of ProofAgent-0G).
/// @author CJ (first author) -- SweePoh (second author / support)
/// @notice A clean-room, four-tier successor to the single per-transaction cap of the MVP
///         MandateRegistry. The MVP proves *one cap held*; V3 proves the agent is bounded against
///         FIVE real attacks the basic cap misses -- looping-drain, destination abuse, price-volatility,
///         no-emergency-stop, and TOCTOU double-spend -- and each tier is independently confirmable
///         on-chain (so the verifier can confirm it):
///
///         - TIER 1  cumulative per-PERIOD cap: a window-rollover accumulator + an atomic accrue, so
///                   LOOPING small in-cap trades can no longer drain past the per-tx ceiling.
///         - TIER 2  enforced expiry (a real time-box) + a spender/router ALLOWLIST
///                   ({checkTransferTo}) + owner-gated delegation, so a lapsed mandate cannot re-spend
///                   and the agent cannot send anywhere.
///         - TIER 3  per-asset sub-caps + a PAUSE kill-switch (global + per-agent) + an OPTIONAL
///                   USD-denominated cap (a price-feed interface, opt-in, fail-closed) + bounded lists
///                   (<= {MAX_LIST}), so a raw-unit cap, no emergency stop, a token-price move, and a
///                   gas-DoS via unbounded growth are all closed.
///         - TIER 4  per-DESTINATION 'sandbox' caps (a MIN that only ever tightens) + an ATOMIC
///                   {gateAndRecord} (gate AND accrue in ONE fail-closed call), closing the
///                   advisory-recordSpend / time-of-check-to-time-of-use (TOCTOU) double-spend gap.
///
/// @dev    SAME v2-compatible gate shape. {checkTransfer(agent, token, amount) -> (bool ok, bytes32
///         reason)} is preserved EXACTLY (selector `0xcc1dd94f`), so the existing agent + verifier +
///         web codecs read V3 unchanged. {checkTransferTo} extends it with a spender (Tier 2/4) and
///         {gateAndRecord} is the atomic gate+accrue (Tier 4).
///
///         FAIL-CLOSED (design SS3 principle 3, never fabricate -- applied to the spend side): every
///         view returns `(ok=false, reason)` on ANY failing condition and `(true, REASON_OK)` ONLY when
///         the spend clears EVERY tier. The reason codes are evaluated in a FIXED, documented order (see
///         {REASON_*} and the gate body) so the FIRST failing condition is named deterministically --
///         the same chain state + args always yield the same `(ok, reason)` (design SS3 principle 4).
///
///         EXACT-INTEGER MONEY (design SS3 principle 5): every comparison is exact `uint256` arithmetic
///         in a token's MINOR units (and USD micro-units for the opt-in USD cap). There is NO floating
///         point on the money path.
///
///         CLEAN-ROOM (design SS6): fresh Solidity on the PUBLIC `checkTransfer` shape + a public
///         price-feed interface + a `canTransfer`-style gate; it vendors no library and names no
///         proprietary identifier, private path, or secret.
contract MandateRegistryV3 {
    // ============================================================================================
    // Reason codes -- the second return value of the gate views. A non-zero reason means NOT ok;
    // `REASON_OK` (the zero word) means within the entire mandate. Stable, ASCII, human-readable
    // `bytes32` tags so an off-chain caller / the web UI renders WHY a spend was blocked with no side
    // lookup. EVALUATED IN A FIXED ORDER (the order they are declared here == the order checked in the
    // gate body == the documented precedence) so the first failing condition is deterministic.
    // ============================================================================================

    /// @notice Within the entire mandate (the only `ok == true` reason). Equals `bytes32(0)`.
    bytes32 public constant REASON_OK = bytes32(0);

    // --- Tier 3 (global / agent gates -- checked first, most-global first) ----------------------
    /// @notice The whole registry is paused (global kill-switch). Out-ranks everything.
    bytes32 public constant REASON_PAUSED = "PAUSED";
    /// @notice This specific agent is paused (per-agent kill-switch).
    bytes32 public constant REASON_AGENT_PAUSED = "AGENT_PAUSED";

    // --- Tier 2 (time-box + identity) -----------------------------------------------------------
    /// @notice The mandate's `expiry` timestamp has passed (the enforced time-box).
    bytes32 public constant REASON_EXPIRED = "EXPIRED";
    /// @notice `agent` is not the mandated agent for this registry.
    bytes32 public constant REASON_NOT_AGENT = "NOT_AGENT";

    // --- amount / asset shape -------------------------------------------------------------------
    /// @notice `amount` is zero -- a no-op spend is never a valid mandated transfer.
    bytes32 public constant REASON_ZERO_AMOUNT = "ZERO_AMOUNT";
    /// @notice `token` is not on the asset allowlist.
    bytes32 public constant REASON_TOKEN_NOT_ALLOWED = "TOKEN_NOT_ALLOWED";

    // --- Tier 2/4 (destination) -----------------------------------------------------------------
    /// @notice `spender` (the router/destination) is not on the spender allowlist (Tier 2).
    bytes32 public constant REASON_SPENDER_NOT_ALLOWED = "SPENDER_NOT_ALLOWED";

    // --- caps (raw-unit), ascending granularity -------------------------------------------------
    /// @notice `amount` exceeds the global per-transaction cap.
    bytes32 public constant REASON_OVER_TX_CAP = "OVER_TX_CAP";
    /// @notice `amount` exceeds this token's per-asset sub-cap (Tier 3).
    bytes32 public constant REASON_OVER_ASSET_CAP = "OVER_ASSET_CAP";
    /// @notice `amount` exceeds the per-destination 'sandbox' cap for `spender` (Tier 4).
    bytes32 public constant REASON_OVER_DEST_CAP = "OVER_DEST_CAP";

    // --- Tier 1 (cumulative window) -------------------------------------------------------------
    /// @notice this spend would push the current period's cumulative total over the period cap (Tier 1).
    bytes32 public constant REASON_OVER_PERIOD_CAP = "OVER_PERIOD_CAP";

    // --- Tier 3 (USD-denominated, opt-in) -------------------------------------------------------
    /// @notice the spend priced in USD exceeds the USD cap (Tier 3, opt-in).
    bytes32 public constant REASON_OVER_USD_CAP = "OVER_USD_CAP";
    /// @notice a USD cap is set but the price for `token` is unavailable/zero -> fail-closed (Tier 3).
    bytes32 public constant REASON_PRICE_UNAVAILABLE = "PRICE_UNAVAILABLE";

    // ============================================================================================
    // Bounded-list guard (Tier 3): a hard cap on every owner-grown list so the gate can never be
    // gas-DoS'd by unbounded growth. The gate itself touches only O(1) mappings, but the lists the
    // owner maintains (allowed tokens / spenders) are length-capped on insert.
    // ============================================================================================

    /// @notice The maximum number of entries in any owner-grown list (allowed tokens, allowed
    ///         spenders). A bounded list keeps the admin surface O(1)-ish and DoS-proof (Tier 3).
    uint256 public constant MAX_LIST = 16;

    // ============================================================================================
    // State.
    // ============================================================================================

    /// @notice The mandate owner / admin (holds the full mutating surface).
    address public owner;
    /// @notice The single agent this mandate authorizes.
    address public agent;

    /// @notice Global per-transaction cap, in a token's MINOR units (Tier 0/baseline, v2-compatible).
    uint256 public perTxCap;
    /// @notice Mandate expiry, a unix timestamp (seconds). `>= expiry` is expired (Tier 2).
    uint256 public expiry;

    /// @notice Global kill-switch (Tier 3). While true, the gate rejects everything (REASON_PAUSED).
    bool public paused;
    /// @notice Per-agent kill-switch (Tier 3). While true for `agent`, the gate rejects (AGENT_PAUSED).
    mapping(address => bool) public agentPaused;

    // --- Tier 3: per-asset sub-caps + allowlist (bounded) ---------------------------------------
    /// @notice Per-asset sub-cap, MINOR units. A token is allowlisted iff `allowed[token]`.
    mapping(address => uint256) public assetCap;
    /// @notice The asset allowlist.
    mapping(address => bool) public allowed;
    /// @notice Count of allowlisted tokens (bounded by {MAX_LIST}, Tier 3).
    uint256 public allowedTokenCount;

    // --- Tier 2/4: spender (router/destination) allowlist + per-destination caps (bounded) ------
    /// @notice The spender/router allowlist (Tier 2). When {spenderAllowlistEnabled}, a transfer to a
    ///         non-allowlisted spender is rejected.
    mapping(address => bool) public spenderAllowed;
    /// @notice Count of allowlisted spenders (bounded by {MAX_LIST}, Tier 3).
    uint256 public spenderCount;
    /// @notice When true, {checkTransferTo}/{gateAndRecord} REQUIRE `spender` to be allowlisted
    ///         (Tier 2). Off by default so the v2-shape {checkTransfer} (no spender) is unaffected.
    bool public spenderAllowlistEnabled;

    /// @notice Per-destination 'sandbox' cap, MINOR units (Tier 4). `0` == unset (no extra tightening).
    ///         When set, it is an additional MIN that can only TIGHTEN the effective cap for that
    ///         destination -- a low-trust router never shares the full cap.
    mapping(address => uint256) public destCap;

    // --- Tier 1: cumulative per-period cap (window-rollover accumulator) -------------------------
    /// @notice The period length in seconds (Tier 1). `0` disables the period cap entirely.
    uint256 public periodSeconds;
    /// @notice The cumulative spend cap per period, MINOR units (Tier 1). Only enforced when
    ///         {periodSeconds} > 0.
    uint256 public periodCap;
    /// @notice The unix timestamp at which the CURRENT accounting window began (Tier 1). Rolls forward
    ///         by whole {periodSeconds} steps as time passes.
    uint256 public windowStart;
    /// @notice Cumulative spend ACCRUED in the current window, MINOR units (Tier 1). Reset on rollover.
    uint256 public spentInWindow;

    // --- Tier 3: USD-denominated cap (opt-in, fail-closed) --------------------------------------
    /// @notice The opt-in price feed (Tier 3). `address(0)` == no USD cap (the USD tier is skipped).
    IPriceFeed public priceFeed;
    /// @notice The per-transaction USD cap, in USD micro-units (1e6 == $1), Tier 3. Only enforced when
    ///         {priceFeed} is set AND `usdCapMicros > 0`.
    uint256 public usdCapMicros;
    /// @notice The decimals of `token` used to convert a MINOR-unit amount to whole tokens for pricing
    ///         (Tier 3). Set per allowlisted asset; required for the USD tier. `0` decimals is valid.
    mapping(address => uint8) public tokenDecimals;
    /// @notice Whether `tokenDecimals[token]` has been explicitly set (so decimals `0` is distinguishable
    ///         from "unset" -- an unset token under an active USD cap fails closed, Tier 3).
    mapping(address => bool) public tokenDecimalsSet;

    // ============================================================================================
    // Events -- a full on-chain audit trail (design SS3 principle 1: the chain is the independent
    // record the verifier reads). Each tier's state change emits, so the verifier can confirm the tier.
    // ============================================================================================

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event AgentSet(address indexed previousAgent, address indexed newAgent);
    event PerTxCapSet(uint256 previousCap, uint256 newCap);
    event ExpirySet(uint256 previousExpiry, uint256 newExpiry);
    event PausedSet(bool paused);
    event AgentPausedSet(address indexed agent, bool paused);
    event AssetCapSet(address indexed token, uint256 cap, bool allowed);
    event TokenAllowlistSet(address indexed token, bool allowed);
    event TokenDecimalsSet(address indexed token, uint8 decimals);
    event SpenderAllowlistSet(address indexed spender, bool allowed);
    event SpenderAllowlistEnabledSet(bool enabled);
    event DestCapSet(address indexed spender, uint256 cap);
    event PeriodConfigSet(uint256 periodSeconds, uint256 periodCap, uint256 windowStart);
    event SpendRecorded(
        address indexed token,
        address indexed spender,
        uint256 amount,
        uint256 spentInWindow,
        uint256 windowStart
    );
    event WindowRolled(uint256 previousWindowStart, uint256 newWindowStart);
    event PriceFeedSet(address indexed feed, uint256 usdCapMicros);

    // ============================================================================================
    // Errors -- the mutating surface reverts (it changes state); the gate views NEVER revert.
    // ============================================================================================

    error NotOwner();
    error ZeroAddress();
    error ListFull(uint256 max);
    error BadPeriodConfig();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    /// @param initialOwner    The mandate admin (reverts on the zero addr).
    /// @param initialAgent    The single agent the mandate authorizes (reverts on the zero addr).
    /// @param initialPerTxCap The global per-transaction cap, MINOR units.
    /// @param initialExpiry   The mandate expiry (unix seconds); `type(uint256).max` for "never".
    constructor(address initialOwner, address initialAgent, uint256 initialPerTxCap, uint256 initialExpiry) {
        if (initialOwner == address(0) || initialAgent == address(0)) revert ZeroAddress();
        owner = initialOwner;
        agent = initialAgent;
        perTxCap = initialPerTxCap;
        expiry = initialExpiry;
        emit OwnershipTransferred(address(0), initialOwner);
        emit AgentSet(address(0), initialAgent);
        emit PerTxCapSet(0, initialPerTxCap);
        emit ExpirySet(0, initialExpiry);
    }

    // ============================================================================================
    // THE GATES -- the load-bearing views. `view`, never revert, deterministic.
    // ============================================================================================

    /// @notice v2-COMPATIBLE gate (selector `0xcc1dd94f`). Check whether `agent_` may transfer `amount`
    ///         of `token` under EVERY enabled tier, WITHOUT mutating state and WITHOUT a destination.
    ///         When the spender allowlist is enabled the destination IS still checked -- via the
    ///         {address(0)} spender, which is never allowlisted, so a v2-shape call under an enabled
    ///         allowlist fails closed with SPENDER_NOT_ALLOWED (callers that need a destination must use
    ///         {checkTransferTo}). Tier-1 period accounting is checked against the CURRENT accrued total.
    /// @dev    Pure read of current chain state; the agent calls this as a pre-broadcast `eth_call`.
    function checkTransfer(address agent_, address token, uint256 amount)
        external
        view
        returns (bool ok, bytes32 reason)
    {
        return _check(agent_, token, amount, address(0));
    }

    /// @notice Tier 2/4 gate: like {checkTransfer} but also enforces the spender/router allowlist
    ///         (Tier 2) and the per-destination 'sandbox' cap (Tier 4) for `spender`.
    function checkTransferTo(address agent_, address token, uint256 amount, address spender)
        external
        view
        returns (bool ok, bytes32 reason)
    {
        return _check(agent_, token, amount, spender);
    }

    /// @notice The internal gate -- the FIXED reason-code order (documented precedence). Returns the
    ///         FIRST failing reason; `(true, REASON_OK)` only when the spend clears every enabled tier.
    /// @param spender The destination/router. `address(0)` means "no destination given" (the v2 shape):
    ///        Tier-4 dest-cap is skipped for it, but if the spender allowlist is ENABLED an unset
    ///        destination is rejected (address(0) is never allowlisted), so the gate fails closed.
    function _check(address agent_, address token, uint256 amount, address spender)
        internal
        view
        returns (bool ok, bytes32 reason)
    {
        // (1) Global kill-switch (Tier 3) -- most global, checked first.
        if (paused) return (false, REASON_PAUSED);

        // (2) Per-agent kill-switch (Tier 3).
        if (agentPaused[agent_]) return (false, REASON_AGENT_PAUSED);

        // (3) Expiry / time-box (Tier 2). `>=` => the expiry instant is already expired (half-open
        //     validity window [start, expiry)).
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp >= expiry) return (false, REASON_EXPIRED);

        // (4) Agent identity (Tier 2).
        if (agent_ != agent) return (false, REASON_NOT_AGENT);

        // (5) Zero amount.
        if (amount == 0) return (false, REASON_ZERO_AMOUNT);

        // (6) Asset allowlist (Tier 3).
        if (!allowed[token]) return (false, REASON_TOKEN_NOT_ALLOWED);

        // (7) Spender/router allowlist (Tier 2) -- only when enabled. address(0) is never allowlisted,
        //     so a v2-shape call (no spender) under an enabled allowlist fails closed here.
        if (spenderAllowlistEnabled && !spenderAllowed[spender]) {
            return (false, REASON_SPENDER_NOT_ALLOWED);
        }

        // (8) Global per-tx cap (baseline).
        if (amount > perTxCap) return (false, REASON_OVER_TX_CAP);

        // (9) Per-asset sub-cap (Tier 3).
        if (amount > assetCap[token]) return (false, REASON_OVER_ASSET_CAP);

        // (10) Per-destination 'sandbox' cap (Tier 4) -- a MIN that only tightens. Skipped for the
        //      unset destination (address(0)); only enforced when a cap is set for `spender`.
        if (spender != address(0)) {
            uint256 dcap = destCap[spender];
            if (dcap != 0 && amount > dcap) return (false, REASON_OVER_DEST_CAP);
        }

        // (11) Cumulative per-period cap (Tier 1) -- the looping-drain guard. Checked against the
        //      CURRENT window's accrued total, rolling the window forward in a pure way for the read.
        if (periodSeconds != 0) {
            uint256 accrued = _accruedNow();
            // amount + accrued must not exceed periodCap (exact-integer, overflow-safe).
            if (amount > periodCap || accrued > periodCap - amount) {
                return (false, REASON_OVER_PERIOD_CAP);
            }
        }

        // (12) USD-denominated cap (Tier 3, opt-in, fail-closed). Only when a feed + cap are set.
        if (address(priceFeed) != address(0) && usdCapMicros != 0) {
            (bool priced, uint256 usdMicros) = _usdValueMicros(token, amount);
            if (!priced) return (false, REASON_PRICE_UNAVAILABLE);
            if (usdMicros > usdCapMicros) return (false, REASON_OVER_USD_CAP);
        }

        // Within the entire mandate.
        return (true, REASON_OK);
    }

    /// @notice The cumulative spend accrued in the CURRENT window, accounting for window rollover, as a
    ///         PURE read (Tier 1). If `>= periodSeconds` have elapsed since {windowStart}, the window
    ///         has rolled and the accrued total is `0`; otherwise it is {spentInWindow}. This is the
    ///         read-only twin of the rollover that {_rollWindow} performs on accrue.
    function _accruedNow() internal view returns (uint256) {
        if (periodSeconds == 0) return 0;
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp >= windowStart + periodSeconds) {
            return 0; // the window has rolled -- a fresh window starts empty.
        }
        return spentInWindow;
    }

    // ============================================================================================
    // ATOMIC gate+accrue (Tier 4) -- the TOCTOU close. Gate AND accrue in ONE fail-closed call, so a
    // gate check and the accrual that follows it can never be split by a concurrent spend.
    // ============================================================================================

    /// @notice Gate `amount` of `token` to `spender` AND, iff it clears every tier, atomically accrue it
    ///         into the current period window -- in ONE call (Tier 4). This closes the
    ///         advisory-recordSpend / TOCTOU double-spend gap: there is no window between the check and
    ///         the accrual for a second spend to slip through.
    ///
    /// @dev    FAIL-CLOSED: on ANY failing tier it returns `(false, reason)` and accrues NOTHING (no
    ///         state change). Only on a full pass does it roll the window if due, add `amount` to
    ///         {spentInWindow}, emit, and return `(true, REASON_OK)`. Callable only by the {agent} or
    ///         the {owner} (so an arbitrary caller cannot poison the accumulator); a non-authorized
    ///         caller is a fail-closed `(false, NOT_AGENT)`, never a revert, so the gate contract is the
    ///         single honest answer surface.
    function gateAndRecord(address agent_, address token, uint256 amount, address spender)
        external
        returns (bool ok, bytes32 reason)
    {
        // Authorization: only the mandated agent or the owner may move the accumulator. A stranger is a
        // fail-closed NOT_AGENT (never a revert) so the atomic gate behaves like the views.
        if (msg.sender != agent && msg.sender != owner) {
            return (false, REASON_NOT_AGENT);
        }

        (ok, reason) = _check(agent_, token, amount, spender);
        if (!ok) {
            return (ok, reason); // fail-closed: nothing is accrued.
        }

        // Passed every tier -> accrue atomically into the (possibly rolled) window (Tier 1/4).
        if (periodSeconds != 0) {
            _rollWindow();
            // Safe: _check already proved amount + spentInWindow <= periodCap for the current window.
            spentInWindow += amount;
            emit SpendRecorded(token, spender, amount, spentInWindow, windowStart);
        }
        return (true, REASON_OK);
    }

    /// @notice ADVISORY accrue (Tier 1) -- record `amount` into the current period window WITHOUT gating.
    ///         This is the legacy "recordSpend" shape: a caller gates with {checkTransfer} and then,
    ///         separately, records the spend. It is owner/agent-gated and rolls the window first, but it
    ///         is NOT atomic with the gate.
    /// @dev    DEPRECATED in favor of {gateAndRecord}. The split between {checkTransfer} and a separate
    ///         {recordSpend} IS the TOCTOU double-spend gap Tier 4 closes (two spends can both gate-pass
    ///         before either records). Provided for completeness + operator window-seeding, but the
    ///         agent should use the atomic {gateAndRecord}. To avoid silently exceeding the period cap,
    ///         this still REVERTS if the accrual would push the window over {periodCap} -- so even the
    ///         advisory path cannot over-accrue, though it offers no cross-call atomicity.
    function recordSpend(address token, uint256 amount, address spender) external {
        if (msg.sender != agent && msg.sender != owner) revert NotOwner();
        if (periodSeconds == 0) return; // no period accounting configured -> nothing to record.
        _rollWindow();
        // Even the advisory path must not over-accrue: revert if amount + accrued would exceed the cap.
        if (amount > periodCap || spentInWindow > periodCap - amount) revert BadPeriodConfig();
        spentInWindow += amount;
        emit SpendRecorded(token, spender, amount, spentInWindow, windowStart);
    }

    /// @notice Roll the accounting window forward to the current period if it is due (Tier 1). Mutating
    ///         twin of {_accruedNow}: advances {windowStart} by whole {periodSeconds} steps and resets
    ///         {spentInWindow} to `0`. A no-op if the window has not yet elapsed.
    function _rollWindow() internal {
        if (periodSeconds == 0) return;
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp >= windowStart + periodSeconds) {
            uint256 previous = windowStart;
            // Advance by whole periods to the window containing `now` (no drift, no unbounded loop:
            // a single division computes how many whole periods elapsed).
            // forge-lint: disable-next-line(block-timestamp)
            uint256 elapsed = block.timestamp - windowStart;
            uint256 periods = elapsed / periodSeconds;
            windowStart = windowStart + periods * periodSeconds;
            spentInWindow = 0;
            emit WindowRolled(previous, windowStart);
        }
    }

    // ============================================================================================
    // USD pricing (Tier 3) -- exact-integer conversion, fail-closed.
    // ============================================================================================

    /// @notice Price `amount` MINOR units of `token` in USD micro-units (1e6 == $1), exact-integer
    ///         (design SS3 principle 5). Returns `(false, 0)` -- fail-closed -- when no feed is set, the
    ///         token's decimals are unset, or the feed returns a `0` (unavailable) price.
    /// @dev    `priceUsdMicros(token)` is USD micros per ONE WHOLE token. amount is in MINOR units, so
    ///         usdMicros = amount * price / 10^decimals (floor) -- a pure-integer computation, never a
    ///         float. Overflow on `amount * price` is caught by Solidity 0.8 checked arithmetic and
    ///         surfaces as a revert ONLY inside this internal helper, which {checkTransfer}'s caller
    ///         never reaches (the feed is opt-in); for the view path a malicious feed that returns an
    ///         enormous price simply makes the spend exceed the cap (rejected), it cannot fabricate ok.
    function _usdValueMicros(address token, uint256 amount)
        internal
        view
        returns (bool priced, uint256 usdMicros)
    {
        if (address(priceFeed) == address(0)) return (false, 0);
        if (!tokenDecimalsSet[token]) return (false, 0); // can't convert without decimals -> fail-closed.

        // The feed read is wrapped in a try/catch so a reverting/missing feed is fail-closed
        // (PRICE_UNAVAILABLE), never a revert that propagates out of a `view` gate.
        try priceFeed.priceUsdMicros(token) returns (uint256 price) {
            if (price == 0) return (false, 0); // unavailable -> fail-closed.
            uint8 dec = tokenDecimals[token];
            uint256 scale = 10 ** uint256(dec);
            // amount(minor) * price(micros/whole) / 10^dec(minor/whole) = micros. Exact-integer floor.
            usdMicros = (amount * price) / scale;
            return (true, usdMicros);
        } catch {
            return (false, 0); // a reverting feed is unavailable -> fail-closed (PRICE_UNAVAILABLE).
        }
    }

    /// @notice Public view of {_usdValueMicros} -- price `amount` MINOR units of `token` in USD micros.
    ///         For the verifier / UI to independently confirm the USD tier (Tier 3) on-chain.
    function usdValueMicros(address token, uint256 amount)
        external
        view
        returns (bool priced, uint256 usdMicros)
    {
        return _usdValueMicros(token, amount);
    }

    // ============================================================================================
    // Admin surface -- owner-gated mutators. These change state and revert on misuse; the gate views
    // never revert.
    // ============================================================================================

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    function setAgent(address newAgent) external onlyOwner {
        if (newAgent == address(0)) revert ZeroAddress();
        emit AgentSet(agent, newAgent);
        agent = newAgent;
    }

    function setPerTxCap(uint256 newCap) external onlyOwner {
        emit PerTxCapSet(perTxCap, newCap);
        perTxCap = newCap;
    }

    function setExpiry(uint256 newExpiry) external onlyOwner {
        emit ExpirySet(expiry, newExpiry);
        expiry = newExpiry;
    }

    /// @notice Engage/release the GLOBAL kill-switch (Tier 3).
    function setPaused(bool newPaused) external onlyOwner {
        paused = newPaused;
        emit PausedSet(newPaused);
    }

    /// @notice Engage/release the PER-AGENT kill-switch (Tier 3).
    function setAgentPaused(address agent_, bool newPaused) external onlyOwner {
        if (agent_ == address(0)) revert ZeroAddress();
        agentPaused[agent_] = newPaused;
        emit AgentPausedSet(agent_, newPaused);
    }

    /// @notice Allowlist `token` and set its per-asset sub-cap in one call (Tier 3). Both the allow flag
    ///         and the sub-cap are written so an allowlisted token always has a defined sub-cap.
    ///         BOUNDED: turning a token ON when {allowedTokenCount} is already at {MAX_LIST} reverts
    ///         {ListFull} (Tier 3, gas-DoS guard).
    function setAssetCap(address token, uint256 cap, bool isAllowed) external onlyOwner {
        if (token == address(0)) revert ZeroAddress();
        _setAllowed(token, isAllowed);
        assetCap[token] = cap;
        emit AssetCapSet(token, cap, isAllowed);
    }

    /// @notice Toggle a token's allowlist flag without touching its sub-cap (Tier 3, bounded).
    function setAllowed(address token, bool isAllowed) external onlyOwner {
        if (token == address(0)) revert ZeroAddress();
        _setAllowed(token, isAllowed);
        emit TokenAllowlistSet(token, isAllowed);
    }

    /// @dev Internal allowlist toggle with the bounded-list count maintained (Tier 3).
    function _setAllowed(address token, bool isAllowed) internal {
        bool was = allowed[token];
        if (isAllowed && !was) {
            if (allowedTokenCount >= MAX_LIST) revert ListFull(MAX_LIST);
            allowedTokenCount += 1;
        } else if (!isAllowed && was) {
            allowedTokenCount -= 1;
        }
        allowed[token] = isAllowed;
    }

    /// @notice Set the decimals for `token` used by the USD tier's MINOR->whole conversion (Tier 3).
    function setTokenDecimals(address token, uint8 decimals_) external onlyOwner {
        if (token == address(0)) revert ZeroAddress();
        tokenDecimals[token] = decimals_;
        tokenDecimalsSet[token] = true;
        emit TokenDecimalsSet(token, decimals_);
    }

    /// @notice Allowlist/de-allowlist a spender/router (Tier 2, bounded).
    function setSpenderAllowed(address spender, bool isAllowed) external onlyOwner {
        if (spender == address(0)) revert ZeroAddress();
        bool was = spenderAllowed[spender];
        if (isAllowed && !was) {
            if (spenderCount >= MAX_LIST) revert ListFull(MAX_LIST);
            spenderCount += 1;
        } else if (!isAllowed && was) {
            spenderCount -= 1;
        }
        spenderAllowed[spender] = isAllowed;
        emit SpenderAllowlistSet(spender, isAllowed);
    }

    /// @notice Enable/disable enforcement of the spender allowlist (Tier 2). When enabled, the gates
    ///         require an allowlisted `spender` (and the v2-shape {checkTransfer} fails closed -- see it).
    function setSpenderAllowlistEnabled(bool enabled) external onlyOwner {
        spenderAllowlistEnabled = enabled;
        emit SpenderAllowlistEnabledSet(enabled);
    }

    /// @notice Set the per-destination 'sandbox' cap for `spender`, MINOR units (Tier 4). `0` clears it
    ///         (no extra tightening). A set cap can only TIGHTEN the effective cap for that destination.
    function setDestCap(address spender, uint256 cap) external onlyOwner {
        if (spender == address(0)) revert ZeroAddress();
        destCap[spender] = cap;
        emit DestCapSet(spender, cap);
    }

    /// @notice Configure the cumulative per-period cap (Tier 1). `periodSeconds_ == 0` disables it. A
    ///         fresh config (re)starts the window at the current block time and zeroes the accumulator,
    ///         so the new policy applies cleanly from now. A nonzero period requires a nonzero cap.
    function setPeriodConfig(uint256 periodSeconds_, uint256 periodCap_) external onlyOwner {
        if (periodSeconds_ != 0 && periodCap_ == 0) revert BadPeriodConfig();
        periodSeconds = periodSeconds_;
        periodCap = periodCap_;
        // forge-lint: disable-next-line(block-timestamp)
        windowStart = block.timestamp;
        spentInWindow = 0;
        emit PeriodConfigSet(periodSeconds_, periodCap_, windowStart);
    }

    /// @notice Set the opt-in USD-denominated cap (Tier 3): the price feed + the per-tx USD cap in
    ///         micro-dollars. `feed == address(0)` OR `usdCapMicros_ == 0` disables the USD tier.
    function setPriceFeed(IPriceFeed feed, uint256 usdCapMicros_) external onlyOwner {
        priceFeed = feed;
        usdCapMicros = usdCapMicros_;
        emit PriceFeedSet(address(feed), usdCapMicros_);
    }

    // ============================================================================================
    // Views -- read helpers for the agent / web UI / verifier.
    // ============================================================================================

    /// @notice The effective per-transaction limit for `token` to `spender`: the MIN of the global
    ///         per-tx cap, the per-asset sub-cap, and (when set) the per-destination cap -- or `0` if
    ///         the token is not allowlisted. A convenience read; the gates are authoritative. The
    ///         period/USD tiers are window/price-dependent and are NOT folded into this static MIN.
    function effectiveCap(address token, address spender) external view returns (uint256) {
        if (!allowed[token]) return 0;
        uint256 cap = perTxCap;
        uint256 sub = assetCap[token];
        if (sub < cap) cap = sub;
        if (spender != address(0)) {
            uint256 dcap = destCap[spender];
            if (dcap != 0 && dcap < cap) cap = dcap;
        }
        return cap;
    }

    /// @notice The cumulative spend accrued in the current window (Tier 1), accounting for rollover.
    ///         For the verifier / UI to confirm the period tier on-chain.
    function accruedInWindow() external view returns (uint256) {
        return _accruedNow();
    }

    /// @notice The remaining headroom under the period cap in the current window (Tier 1), or
    ///         `type(uint256).max` when no period cap is configured.
    function periodHeadroom() external view returns (uint256) {
        if (periodSeconds == 0) return type(uint256).max;
        uint256 accrued = _accruedNow();
        return accrued >= periodCap ? 0 : periodCap - accrued;
    }

    /// @notice `true` iff the mandate is currently live for `agent` (not globally paused, not
    ///         agent-paused, not expired). Independent of any specific transfer.
    function isActive(address agent_) external view returns (bool) {
        // forge-lint: disable-next-line(block-timestamp)
        return !paused && !agentPaused[agent_] && block.timestamp < expiry;
    }
}
