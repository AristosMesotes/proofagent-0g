// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.26;

/// @title  IPriceFeedV2 -- the 2-return, staleness-aware opt-in price oracle for the USD-denominated cap.
/// @notice Given a token, return its price in USD micro-units (1e6 == $1) per ONE WHOLE token AND the unix
///         second the price was last updated. The `updatedAt` second lets the registry FAIL CLOSED on a
///         STALE feed (a frozen oracle is as dangerous as a wrong one). A `0` price is "unavailable" and the
///         registry fails closed (REASON_PRICE_UNAVAILABLE).
/// @dev    The breaking change from the single-return `IPriceFeed`: a real Chainlink/0G feed (which always
///         carries an `updatedAt`) is adapted behind this 2-return shape; the registry holds only the
///         address and reads it under a gas cap, fail-closed. Declared at file scope (Solidity does not
///         allow a nested interface inside a contract).
interface IPriceFeedV2 {
    /// @return usdMicros USD micro-dollars per one whole `token` (1e6 == $1); `0` == unavailable.
    /// @return updatedAt the unix second the price was last refreshed (for the staleness guard).
    function priceUsdMicros(address token) external view returns (uint256 usdMicros, uint64 updatedAt);
}

/// @title  IERC20Decimals -- the one ERC-20 view the registry reads to BIND a token's stored decimals to its
///         LIVE on-chain decimals (so a config can never silently disagree with the real token).
interface IERC20Decimals {
    function decimals() external view returns (uint8);
}

/// @title  MandateRegistryV4 -- THE consolidated, hardened, ADVISORY + verifier-enforced + NON-CUSTODIAL
///         spend-bounding mandate ("the agent can't overspend -- the mandate blocks it pre-broadcast and the
///         independent verifier proves it").
/// @author CJ (first author) -- SweePoh (second author / support)
/// @notice The single, consolidated successor to the MVP `MandateRegistry`, the four-tier
///         `MandateRegistryV3`, and the separate `TimelockGuard` -- folded into ONE self-contained contract
///         with the hardened, best-in-class feature set distilled from a nine-lens adversarial review
///         (TOCTOU/double-spend, asset/value-confusion, gas-grief/unbounded-work, governance-bypass).
///
///         ## The honest money-safety model (ADVISORY + verifier-enforced + NON-CUSTODIAL)
///
///         This contract HOLDS NO FUNDS (no custody, no escrow -- consistent with the no-shared-pool
///         philosophy). It is the on-chain SOURCE-OF-TRUTH for the spend caps, read by the agent gateway as a
///         zero-gas `eth_call` (`checkTransfer`) BEFORE it broadcasts, and accrued atomically by the agent
///         via `gateAndRecord`. The off-chain gateway ENFORCES by REFUSING an over-cap action PRE-broadcast
///         (a fail-closed kill-switch, never shadow-only); the independent verifier CATCHES any violation
///         LOUD (it reads the gate itself, two-source). The HONEST claim is therefore: "the agent can't
///         overspend -- the mandate blocks it pre-broadcast and the verifier proves it", NEVER "physically
///         can't overspend" (the contract cannot physically stop a hijacked key that ignores the gate; it
///         makes such a spend provably out-of-mandate and instantly catchable).
///
///         ## The hardened feature set (each tier maps to the attack it closes)
///
///         - **Per-tx cap** (`perTxCap`) -- one call cannot drain in a single shot.
///         - **Rolling-period limiter -- LEAKY BUCKET, overflow-safe refill** -- closes salami/looping-drain
///           AND the calendar-window 2x boundary. HONEST BOUND: a leaky bucket bounds the instantaneous
///           level <= cap and the long-run average rate <= cap/period, but admits up to ~2x cap over one
///           arbitrary rolling window (greedy top-up). We advertise that TRUE bound (NOT "structurally
///           impossible looping-drain"); a deployment needing a hard rolling bound sizes the enforced cap at
///           periodCap/2 (documented in {setPeriodConfig} + the design doc).
///         - **Expiry `[start, expiry)` + EPOCH on the money path** -- stale authority + agent-rotation
///           strands no in-flight grant (`bumpEpoch` is a real, money-path revocation, not a no-op view).
///         - **Spender/router allowlist (default-deny) + per-spoke isolation (typed, default-deny)** -- funds
///           to an attacker, a re-delegated lapsed mandate, a weak spoke inheriting the full hub budget.
///         - **Pause kill-switch: global + per-agent, GUARDIAN-settable, covering in-flight egress** -- an
///           exploit in progress with no instant low-priv halt; a paused registry still clearing a queued
///           egress (the folded time-lock RE-GATES at execute).
///         - **Runtime asset allowlist + per-asset raw sub-caps + USD cap** -- a staleness-guarded,
///           sanity-banded, gas-bounded, fail-closed 2-return price feed; live-decimals-validated; a
///           native-vs-ERC20 sentinel; overflow-safe amount*price. PLUS a global USD-denominated period cap
///           (defense-in-depth alongside the per-asset caps).
///         - **BOUNDED EVERYTHING** (MAX_LIST=16 lists, MAX_PENDING queue, MAX_DESTCAP dest/spoke caps,
///           bounded param queue) + an O(1) hot path -- no gas-DoS / state-bloat / verifier-blinding.
///         - **ATOMIC check-and-effect** (`gateAndRecord`, checks-effects, `nonReentrant`) -- record ==
///           accrual in one tx (no view-path TOCTOU gap on the accumulator).
///         - **Value-tiered outbound time-lock, FOLDED IN, re-gated at execute, bucket-reserving** -- instant
///           large egress; a queued egress ignoring pause/expiry/epoch/caps; smurfing under the threshold.
///         - **Immutable enforcement logic + DELAYED-LOOSENING params + two-step ownership + guardian
///           (tighten/pause only)** -- an upgradeable backdoor; instant cap-loosening by a hot owner; a
///           silent repoint; an owner hot-key SPOF.
///         - **Cooldown + dust floors (raw + USD)** -- add-attacker-and-drain in one block; dust grinding.
///         - **EVENT-completeness for two-source verification** -- every spend/config/queue/exec/cancel
///           carries headroom + epoch + spendId so the verifier reconciles 1:1.
///
///         ## Backward-compat (frozen v2 gate)
///
///         `checkTransfer(agent,token,amount) -> (ok,reason)` keeps selector `0xcc1dd94f` byte-identical;
///         `checkTransferTo(agent,token,amount,spender) -> (ok,reason)` keeps `0x697bb97c`. Every hardened
///         knob is ADDITIVE + off by default, so a caller reading only the v2 shape sees V3-equivalent
///         behavior -- except where a deliberate CORRECTNESS fix changes a verdict (the 2-return feed, the
///         live-decimals bind, the deletion of the advisory `recordSpend` TOCTOU primitive).
///
///         ## Doctrine (clean-room, design SS3)
///
///         FAIL-CLOSED (never fabricate an OK): every disabled/unwired/unreadable rung degrades to the SAFE
///         verdict, never a fabricated pass. The view gates are `view` and NEVER revert over any reachable
///         state (the folded queue path calls the same `_check` from a mutating context, so a revert-free
///         core is load-bearing). EXACT-INTEGER money (no float; overflow-safe). DETERMINISTIC (the
///         first-failing rung in a fixed, documented order). Vendors no library; names no proprietary
///         identifier, private path, or secret.
contract MandateRegistryV4 {
    // ============================================================================================
    // Reason codes -- the second return of the gate views. A non-zero reason means NOT ok; `REASON_OK`
    // (the zero word) means within the entire mandate. Stable ASCII bytes32 tags, evaluated in a FIXED
    // order (declaration order == checked order == documented precedence) so the FIRST failing condition
    // is named deterministically. FAIL-CLOSED: the gates return (false, reason), never revert.
    // ============================================================================================

    /// @notice Within the entire mandate (the only `ok == true` reason). Equals `bytes32(0)`.
    bytes32 public constant REASON_OK = bytes32(0);

    /// @notice The whole registry is paused (global kill-switch). Out-ranks everything.
    bytes32 public constant REASON_PAUSED = "PAUSED";
    /// @notice This specific agent is paused (per-agent kill-switch).
    bytes32 public constant REASON_AGENT_PAUSED = "AGENT_PAUSED";
    /// @notice now < start -- the mandate has not begun (half-open [start, expiry)).
    bytes32 public constant REASON_NOT_STARTED = "NOT_STARTED";
    /// @notice now >= expiry -- the mandate's time-box has elapsed.
    bytes32 public constant REASON_EXPIRED = "EXPIRED";
    /// @notice `agent_` is not the bound agent for this registry.
    bytes32 public constant REASON_NOT_AGENT = "NOT_AGENT";
    /// @notice the request's epoch != the current epoch -- a stranded (revoked) in-flight grant.
    bytes32 public constant REASON_EPOCH_STALE = "EPOCH_STALE";
    /// @notice `amount` is zero -- a no-op spend is never a valid mandated transfer.
    bytes32 public constant REASON_ZERO_AMOUNT = "ZERO_AMOUNT";
    /// @notice `amount` is below the raw dust floor `minSpend`.
    bytes32 public constant REASON_BELOW_MIN_SPEND = "BELOW_MIN_SPEND";
    /// @notice `token` is not on the asset allowlist.
    bytes32 public constant REASON_TOKEN_NOT_ALLOWED = "TOKEN_NOT_ALLOWED";
    /// @notice `spender` (router/destination) is not on the address spender/router allowlist.
    bytes32 public constant REASON_SPENDER_NOT_ALLOWED = "SPENDER_NOT_ALLOWED";
    /// @notice the TYPED bridge SPOKE (`destSelector`) is unconfigured -- the bridge-out path's own
    ///         default-deny (distinct from the ADDRESS spender allowlist). A dedicated, machine-readable
    ///         reason so the verifier's two-source story reads honestly at the bridge boundary: an
    ///         unconfigured spoke is named SPOKE_NOT_CONFIGURED, never folded into the generic spender deny.
    bytes32 public constant REASON_SPOKE_NOT_CONFIGURED = "SPOKE_NOT_CONFIGURED";
    /// @notice `amount` exceeds the global per-transaction cap.
    bytes32 public constant REASON_OVER_TX_CAP = "OVER_TX_CAP";
    /// @notice `amount` exceeds this token's per-asset sub-cap.
    bytes32 public constant REASON_OVER_ASSET_CAP = "OVER_ASSET_CAP";
    /// @notice `amount` exceeds the per-destination/spoke 'sandbox' cap (or a blocked dest's zero allowance).
    bytes32 public constant REASON_OVER_DEST_CAP = "OVER_DEST_CAP";
    /// @notice this spend would push the leaky-bucket level over the period cap (looping-drain guard).
    bytes32 public constant REASON_OVER_PERIOD_CAP = "OVER_PERIOD_CAP";
    /// @notice this spend would push the tx-count leaky-bucket over `maxTxPerPeriod`.
    bytes32 public constant REASON_OVER_TXCOUNT_CAP = "OVER_TXCOUNT_CAP";
    /// @notice a USD cap is on but the price is unavailable/zero/STALE/out-of-band/overflow -> fail-closed.
    bytes32 public constant REASON_PRICE_UNAVAILABLE = "PRICE_UNAVAILABLE";
    /// @notice the spend priced in USD is below the USD dust floor `minUsdMicros`.
    bytes32 public constant REASON_BELOW_MIN_USD = "BELOW_MIN_USD";
    /// @notice the spend priced in USD exceeds the USD cap `usdCapMicros`.
    bytes32 public constant REASON_OVER_USD_CAP = "OVER_USD_CAP";

    // ============================================================================================
    // Bounded-list / queue guards -- a hard cap on EVERY owner-grown structure so the gate can never be
    // gas-DoS'd by unbounded growth and the verifier is never blinded by an unbounded set. The hot path
    // touches only O(1) mappings; only the owner-maintained lists are length-capped on insert.
    // ============================================================================================

    /// @notice Max entries in any allowlist (allowed tokens, allowed spenders). Bounded => O(1)-ish admin.
    uint16 public constant MAX_LIST = 16;
    /// @notice Max distinct per-destination + per-spoke caps (the previously-unbounded dest/spoke maps).
    uint16 public constant MAX_DESTCAP = 16;
    /// @notice Max LIVE (Pending) outbound time-lock requests at once (the previously-unbounded queue).
    uint16 public constant MAX_PENDING = 16;
    /// @notice Gas cap on the (opt-in) price-feed call -- a hostile/gas-bomb feed cannot brick the gate.
    uint256 public constant PRICE_FEED_GAS = 100_000;
    /// @notice The overflow ceiling for `amount * price` -- above it the USD math fail-closes, never reverts.
    uint256 public constant MAX_PRICE_MICROS = type(uint256).max / 1e30;
    /// @notice The canonical native-0G sentinel (a token of this address is the native asset, decimals 18).
    address public constant NATIVE = 0x0000000000000000000000000000000000000001;

    // ============================================================================================
    // Roles / roots of trust (governance hardened: two-step ownership + guardian + delayed loosening).
    // ============================================================================================

    /// @notice The mandate owner / admin (multisig). RISK-INCREASING (loosening) ops are DELAYED.
    address public owner;
    /// @notice The pending owner in a two-step handshake (no transfer to a key that has not proven live).
    address public pendingOwner;
    /// @notice The low-priv guardian: may PAUSE + cancel a pending loosening ONLY. Never loosens.
    address public guardian;
    /// @notice The single bound agent this mandate authorizes (the spender key).
    address public agent;

    // ============================================================================================
    // Mandate identity / time (half-open [start, expiry) + a money-path epoch).
    // ============================================================================================

    /// @notice notBefore -- `0` means active immediately (the mandate is inert while now < start).
    uint64 public start;
    /// @notice notAfter -- half-open: `now >= expiry` is EXPIRED.
    uint64 public expiry;
    /// @notice Bumped to invalidate every prior in-flight grant; CHECKED on the money path (a real revoke).
    uint64 public epoch;

    // ============================================================================================
    // Global caps + dust floor.
    // ============================================================================================

    /// @notice Global per-transaction cap, MINOR units (v2-compatible baseline).
    uint256 public perTxCap;
    /// @notice Raw dust floor: a spend below this is BELOW_MIN_SPEND (0 => off).
    uint256 public minSpend;

    // ============================================================================================
    // Pause (global + per-agent).
    // ============================================================================================

    /// @notice Global kill-switch. While true the gate rejects everything (PAUSED).
    bool public paused;
    /// @notice Per-agent kill-switch.
    mapping(address => bool) public agentPaused;

    // ============================================================================================
    // Asset allowlist + per-asset sub-caps (bounded, default-deny) + live-bound decimals.
    // ============================================================================================

    /// @notice The asset allowlist (default-deny).
    mapping(address => bool) public allowed;
    /// @notice Per-asset sub-cap, MINOR units.
    mapping(address => uint256) public assetCap;
    /// @notice Count of allowlisted tokens (bounded by MAX_LIST).
    uint16 public allowedTokenCount;
    /// @notice The decimals used for the USD MINOR->whole conversion, BOUND to the token's live `decimals()`.
    mapping(address => uint8) public tokenDecimals;
    /// @notice Whether `tokenDecimals[token]` was set (so decimals `0` is distinguishable from "unset").
    mapping(address => bool) public tokenDecimalsSet;

    // ============================================================================================
    // Spender/router allowlist (bounded, default-deny opt-in).
    // ============================================================================================

    /// @notice The spender/router allowlist.
    mapping(address => bool) public spenderAllowed;
    /// @notice Count of allowlisted spenders (bounded by MAX_LIST).
    uint16 public spenderCount;
    /// @notice When true, the gates REQUIRE an allowlisted `spender` (default-deny). Off by default.
    bool public spenderAllowlistEnabled;

    // ============================================================================================
    // Per-destination caps (bounded + blockable) + per-spoke isolation (TYPED, namespace-disjoint).
    // ============================================================================================

    /// @notice Per-destination 'sandbox' cap, MINOR units (tighten-only; 0 => unset).
    mapping(address => uint256) public destCap;
    /// @notice Explicit zero-allowance for a destination (a hard block, distinct from "unset").
    mapping(address => bool) public destBlocked;
    /// @notice Count of distinct destination caps (bounded by MAX_DESTCAP).
    uint16 public destCapCount;

    /// @notice Per-spoke cap keyed by a uint64 selector in a namespace DISJOINT from router addresses (no
    ///         address value can alias a spoke and a router -- isolation is structural).
    mapping(uint64 => uint256) public spokeCap;
    /// @notice Default-deny: an UNCONFIGURED spoke authorizes nothing (a weak spoke never inherits the hub).
    mapping(uint64 => bool) public spokeConfigured;
    /// @notice Count of configured spokes (bounded by MAX_DESTCAP).
    uint16 public spokeCount;

    // ============================================================================================
    // Rolling-period limiter -- LEAKY BUCKET, overflow-safe. + a tx-count leaky bucket.
    // ============================================================================================

    /// @notice The period length in seconds (0 => the period tier is off).
    uint64 public periodSeconds;
    /// @notice The cumulative spend cap per period, MINOR units (the looping-drain guard).
    uint256 public periodCap;
    /// @notice The current value-bucket level (consumed on accrue, leaks down over time).
    uint256 public bucketLevel;
    /// @notice The unix second the value bucket was last updated.
    uint64 public bucketUpdatedAt;
    /// @notice Max accrued spends (count) per period (0 => off).
    uint32 public maxTxPerPeriod;
    /// @notice The current tx-count-bucket level.
    uint256 public txBucketLevel;
    /// @notice The unix second the tx-count bucket was last updated.
    uint64 public txBucketUpdatedAt;

    // ============================================================================================
    // USD cap (opt-in; 2-return staleness/sanity/gas-guarded; fail-closed) + USD dust floor.
    // ============================================================================================

    /// @notice The opt-in price feed. `address(0)` => no USD cap.
    IPriceFeedV2 public priceFeed;
    /// @notice The per-tx USD cap, micro-dollars (1e6 == $1). 0 => off.
    uint256 public usdCapMicros;
    /// @notice The USD dust floor, micro-dollars. 0 => off.
    uint256 public minUsdMicros;
    /// @notice The staleness bound, seconds: a price older than this is unavailable (0 => no staleness check).
    uint64 public maxPriceAge;
    /// @notice Per-token sanity band LOW (micros/whole). 0 => no low band. A price below it fails closed.
    mapping(address => uint256) public minTokenPriceMicros;
    /// @notice Per-token sanity band HIGH. 0 => no high band. A price above it fails closed.
    mapping(address => uint256) public maxTokenPriceMicros;

    // ============================================================================================
    // Delayed-loosening governance (every risk-INCREASING owner op is queued, time-delayed, cancellable).
    // ============================================================================================

    /// @notice The delay on risk-increasing owner ops (0 => instant, discouraged).
    uint64 public paramDelaySeconds;
    /// @notice Monotonic param-change id.
    uint256 public nextParamId;
    /// @notice Count of LIVE (queued, not yet executed/cancelled) param changes (bounded by MAX_LIST).
    uint16 public pendingParamCount;

    /// @notice One queued risk-increasing parameter change (a raw calldata blob, executed by the registry).
    struct ParamChange {
        /// The status (None until queued; Queued; Executed; Cancelled -- terminal states absorbing).
        ParamStatus status;
        /// The ABI-encoded self-call to run after the delay (selector + args of a loosening setter).
        bytes call;
        /// The unix second at/after which it may execute.
        uint64 executableAt;
    }

    /// @notice Lifecycle of a queued param change.
    enum ParamStatus {
        None,
        Queued,
        Executed,
        Cancelled
    }

    /// @notice paramId => the queued change (id 0 never used; 0 is the None sentinel).
    mapping(uint256 => ParamChange) public paramChanges;

    // ============================================================================================
    // Folded outbound time-lock (re-gated at execute, bounded, bucket-reserving). NON-CUSTODIAL: the
    // lock AUTHORIZES an egress + holds it under a value-tiered delay; it moves NO tokens (the actual
    // ccipSend is the operator/agent step after a cleared execute). The contract holds no funds.
    // ============================================================================================

    /// @notice The value boundary, MINOR units: `<=` is the small tier (short delay), `>` is the big tier.
    uint256 public bigValueThreshold;
    /// @notice The SHORT-tier delay, seconds.
    uint64 public shortDelaySeconds;
    /// @notice The LONG-tier (24h-style) delay, seconds (>= shortDelay -- enforced).
    uint64 public longDelaySeconds;
    /// @notice The window, seconds, after `executableAt` past which a Pending request is inert (reapable).
    uint64 public cancelWindowSeconds;
    /// @notice The cumulative-egress leaky bucket level (tiers the delay so smurfing crosses the threshold).
    uint256 public outboundBucketLevel;
    /// @notice The unix second the cumulative-egress bucket was last updated.
    uint64 public outboundBucketUpdatedAt;
    /// @notice Monotonic queue id (starts at 1; 0 is the None sentinel).
    uint256 public nextQueueId;
    /// @notice Count of LIVE (Pending) requests (bounded by MAX_PENDING).
    uint16 public pendingCount;

    /// @notice Lifecycle of a queued bridge-out.
    enum LockStatus {
        None,
        Pending,
        Executed,
        Cancelled,
        Expired
    }

    /// @notice One queued outbound-bridge authorization (records exactly what the verifier confirms).
    struct Request {
        LockStatus status;
        address agent;
        address token;
        uint64 destSelector;
        address recipient;
        uint256 amount;
        /// The period headroom RESERVED at queue (released on cancel/expire) so egress is period-bounded.
        uint256 reservedBucket;
        /// The epoch snapshot at queue; re-checked at execute (a rotation strands the queued egress).
        uint64 epochAtQueue;
        uint64 delaySeconds;
        uint64 queuedAt;
        uint64 executableAt;
        /// `executableAt + cancelWindowSeconds`; past this the request is inert (reapable).
        uint64 staleAfter;
    }

    /// @notice queueId => the queued request. id 0 is never used (the None sentinel).
    mapping(uint256 => Request) public requests;

    // ============================================================================================
    // Accrual / spend-id (event-completeness for two-source reconciliation).
    // ============================================================================================

    /// @notice Monotonic spend id (binds a `SpendRecorded` to the verifier's on-chain `Transfer` read).
    uint256 public nextSpendId;

    // ============================================================================================
    // Reentrancy guard (the atomic accrue + the time-lock paths run under it).
    // ============================================================================================

    uint256 private _locked = 1;

    // ============================================================================================
    // Events -- the full on-chain audit trail (the chain is the verifier's independent record). Every
    // spend/config/queue/exec/cancel emits, carrying headroom + epoch + spendId for 1:1 reconciliation.
    // ============================================================================================

    event OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event GuardianSet(address indexed previousGuardian, address indexed newGuardian);
    event AgentSet(address indexed previousAgent, address indexed newAgent);
    event StartSet(uint64 previousStart, uint64 newStart);
    event ExpirySet(uint64 previousExpiry, uint64 newExpiry);
    event EpochBumped(uint64 previousEpoch, uint64 newEpoch);
    event PerTxCapSet(uint256 previousCap, uint256 newCap);
    event MinSpendSet(uint256 previousMin, uint256 newMin);
    event MinUsdSet(uint256 previousMin, uint256 newMin);
    event Paused(bool paused);
    event AgentPaused(address indexed agent, bool paused);
    event AssetRuleSet(address indexed token, uint256 cap, bool allowed);
    event AssetCapSet(address indexed token, uint256 cap);
    event TokenAllowlistSet(address indexed token, bool allowed);
    event TokenDecimalsSet(address indexed token, uint8 decimals);
    event PriceBandSet(address indexed token, uint256 lo, uint256 hi);
    event SpenderAllowlistSet(address indexed spender, bool allowed);
    event SpenderAllowlistEnabledSet(bool enabled);
    event DestCapSet(address indexed spender, uint256 cap);
    event DestBlocked(address indexed spender, bool blocked);
    event SpokeCapSet(uint64 indexed selector, uint256 cap);
    event SpokeCleared(uint64 indexed selector);
    event PeriodConfigSet(uint64 periodSeconds, uint256 periodCap);
    event MaxTxPerPeriodSet(uint32 maxTxPerPeriod);
    event PriceFeedSet(address indexed feed, uint64 maxPriceAge);
    event UsdCapSet(uint256 usdCapMicros);
    event ParamDelaySet(uint64 secs);
    event BucketSeeded(uint256 previousLevel, uint256 newLevel);
    /// @notice An atomic gate+accrue cleared (the ADVISORY accrual path). Carries headroom + epoch + spendId
    ///         for the verifier's 1:1 reconciliation.
    event SpendRecorded(
        uint256 indexed spendId,
        address indexed agent,
        address indexed token,
        uint256 amount,
        address spender,
        uint256 periodRemaining,
        uint64 epoch
    );
    event BucketDebited(uint256 level, uint64 at);
    event BucketReleased(uint256 level, uint64 at);
    event TxBucketDebited(uint256 level, uint64 at);
    event ParamChangeQueued(uint256 indexed paramId, uint64 executableAt);
    event ParamChangeExecuted(uint256 indexed paramId);
    event ParamChangeCancelled(uint256 indexed paramId);
    event TiersSet(
        uint256 bigValueThreshold,
        uint64 shortDelaySeconds,
        uint64 longDelaySeconds,
        uint64 cancelWindowSeconds
    );
    event BridgeOutQueued(
        uint256 indexed queueId,
        address indexed token,
        uint64 indexed destSelector,
        address recipient,
        uint256 amount,
        uint256 reservedBucket,
        uint64 epochAtQueue,
        uint64 delaySeconds,
        uint64 queuedAt,
        uint64 executableAt,
        uint64 staleAfter
    );
    event BridgeOutExecuted(uint256 indexed queueId, uint64 executedAt, uint64 executableAt);
    event BridgeOutCancelled(uint256 indexed queueId, uint64 cancelledAt);
    event BridgeOutExpired(uint256 indexed queueId, uint64 reapedAt);

    // ============================================================================================
    // Errors -- mutating paths only (the gates never revert).
    // ============================================================================================

    error NotOwner();
    error NotOwnerOrGuardian();
    error NotPendingOwner();
    error NotAuthorized();
    error ZeroAddress();
    error ZeroAmount();
    error ListFull(uint16 max);
    error TooManyPending(uint16 max);
    error BadPeriodConfig();
    error BadTierConfig();
    error BadPriceConfig();
    error BadDecimals();
    error NotAContract();
    error MandateRefused(bytes32 reason);
    error UnknownQueueId(uint256 queueId);
    error TooEarly(uint256 queueId, uint64 nowTs, uint64 executableAt);
    error NotPending(uint256 queueId, LockStatus status);
    error UnknownParam(uint256 paramId);
    error ParamNotReady(uint256 paramId, uint64 nowTs, uint64 executableAt);
    error ParamNotQueued(uint256 paramId, ParamStatus status);
    error SentinelReserved();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyOwnerOrGuardian() {
        if (msg.sender != owner && msg.sender != guardian) revert NotOwnerOrGuardian();
        _;
    }

    /// @dev A minimal in-file reentrancy guard (clean-room; no vendored lib). The atomic accrue + the
    ///      time-lock mutators run under it -- belt-and-braces, since this contract makes no token calls.
    modifier nonReentrant() {
        if (_locked != 1) revert NotAuthorized();
        _locked = 2;
        _;
        _locked = 1;
    }

    /// @param initialOwner    The mandate admin (reverts on the zero addr).
    /// @param initialAgent    The single bound agent (reverts on the zero addr).
    /// @param initialGuardian The low-priv guardian (must differ from the owner; reverts on zero).
    /// @param initialPerTxCap The global per-transaction cap, MINOR units.
    /// @param initialStart    notBefore (0 => active immediately).
    /// @param initialExpiry   notAfter (`type(uint64).max` for "never").
    constructor(
        address initialOwner,
        address initialAgent,
        address initialGuardian,
        uint256 initialPerTxCap,
        uint64 initialStart,
        uint64 initialExpiry
    ) {
        if (initialOwner == address(0) || initialAgent == address(0) || initialGuardian == address(0)) {
            revert ZeroAddress();
        }
        // The guardian is a SEPARATE blast-radius role from the owner -- they must not be the same key.
        if (initialGuardian == initialOwner) revert BadTierConfig();
        owner = initialOwner;
        agent = initialAgent;
        guardian = initialGuardian;
        perTxCap = initialPerTxCap;
        start = initialStart;
        expiry = initialExpiry;
        epoch = 1; // start at 1 so 0 is the "uninitialized / any" sentinel for off-chain default reads.
        nextQueueId = 1;
        nextParamId = 1;
        nextSpendId = 1;
        // Pin the native sentinel's decimals so a native-0G spend is priceable/gateable out of the box.
        tokenDecimals[NATIVE] = 18;
        tokenDecimalsSet[NATIVE] = true;

        emit OwnershipTransferred(address(0), initialOwner);
        emit AgentSet(address(0), initialAgent);
        emit GuardianSet(address(0), initialGuardian);
        emit PerTxCapSet(0, initialPerTxCap);
        emit StartSet(0, initialStart);
        emit ExpirySet(0, initialExpiry);
        emit EpochBumped(0, 1);
        emit TokenDecimalsSet(NATIVE, 18);
    }

    // ============================================================================================
    // THE GATES -- the load-bearing views. `view`, NEVER revert over any reachable state, deterministic.
    // ============================================================================================

    /// @notice v2-COMPATIBLE gate (selector `0xcc1dd94f`). Check whether `agent_` may transfer `amount` of
    ///         `token` under EVERY enabled tier, with NO destination and the CURRENT epoch. When the spender
    ///         allowlist is enabled, the destination is checked via `address(0)` (never allowlisted) so this
    ///         v2-shape call fails closed -- callers needing a destination use {checkTransferTo}.
    function checkTransfer(address agent_, address token, uint256 amount)
        external
        view
        returns (bool ok, bytes32 reason)
    {
        return _check(agent_, token, amount, address(0), epoch);
    }

    /// @notice Tier 2/4 gate (selector `0x697bb97c`): like {checkTransfer} but also enforces the
    ///         spender/router allowlist + per-destination cap for `spender`, at the CURRENT epoch.
    function checkTransferTo(address agent_, address token, uint256 amount, address spender)
        external
        view
        returns (bool ok, bytes32 reason)
    {
        return _check(agent_, token, amount, spender, epoch);
    }

    /// @notice Epoch-bearing gate: like {checkTransferTo} but the caller pins the request's `reqEpoch` (the
    ///         money path passes the epoch it intends to spend under, so a `bumpEpoch` between gate + spend
    ///         strands the stale request as EPOCH_STALE).
    function checkTransferEpoch(
        address agent_,
        address token,
        uint256 amount,
        address spender,
        uint64 reqEpoch
    ) external view returns (bool ok, bytes32 reason) {
        return _check(agent_, token, amount, spender, reqEpoch);
    }

    /// @notice The internal gate -- the FIXED reason-code order (documented precedence). Returns the FIRST
    ///         failing reason; `(true, REASON_OK)` only when the spend clears every enabled tier. NEVER
    ///         reverts over any reachable state (the folded queue path calls this from a mutating context).
    ///         A thin wrapper over {_checkReserved} with no already-reserved headroom (the fresh-spend path).
    function _check(address agent_, address token, uint256 amount, address spender, uint64 reqEpoch)
        internal
        view
        returns (bool ok, bytes32 reason)
    {
        return _checkReserved(agent_, token, amount, spender, reqEpoch, 0, false, false);
    }

    /// @notice The gate core, parameterized for the RE-GATE of an already-reserved egress. `reservedAmount`
    ///         is period-bucket headroom this very spend ALREADY consumed at queue (so it must be netted out
    ///         of the period rung -- otherwise the re-gate would count the same money TWICE and spuriously
    ///         refuse a valid queued egress). `skipTxCount` likewise skips the tx-count rung at execute (a
    ///         queued egress reserves the VALUE bucket, never the tx-count bucket; re-charging tx-count at
    ///         execute would let unrelated `gateAndRecord` activity strand a long-locked egress). Both knobs
    ///         are FALSE on the fresh-spend path, so the ordinary gate is unchanged. `skipSpenderAllowlist`
    ///         is TRUE on the TYPED-spoke bridge path: that path passes the `address(0)` sentinel (the spoke
    ///         selector, NOT an address, is its isolation key) and is ALREADY default-deny gated by
    ///         `spokeConfigured` -- so re-applying the ADDRESS spender-allowlist (which can never admit
    ///         `address(0)`) would wrongly BRICK every bridge-out the moment the address allowlist is enabled.
    ///         Every OTHER rung (pause/agent-pause/expiry/epoch/asset-allowlist/per-tx/asset/dest/USD) STILL
    ///         re-runs -- the re-gate can only DENY, never extend executability. NEVER reverts.
    function _checkReserved(
        address agent_,
        address token,
        uint256 amount,
        address spender,
        uint64 reqEpoch,
        uint256 reservedAmount,
        bool skipTxCount,
        bool skipSpenderAllowlist
    ) internal view returns (bool ok, bytes32 reason) {
        //  1 global kill-switch (most global first).
        if (paused) return (false, REASON_PAUSED);
        //  2 per-agent kill-switch.
        if (agentPaused[agent_]) return (false, REASON_AGENT_PAUSED);
        //  3 not-yet-started (half-open [start, expiry)).
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp < start) return (false, REASON_NOT_STARTED);
        //  4 expiry.
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp >= expiry) return (false, REASON_EXPIRED);
        //  5 agent identity.
        if (agent_ != agent) return (false, REASON_NOT_AGENT);
        //  6 epoch (money-path revocation).
        if (reqEpoch != epoch) return (false, REASON_EPOCH_STALE);
        //  7 zero amount.
        if (amount == 0) return (false, REASON_ZERO_AMOUNT);
        //  8 raw dust floor.
        if (minSpend != 0 && amount < minSpend) return (false, REASON_BELOW_MIN_SPEND);
        //  9 asset allowlist.
        if (!allowed[token]) return (false, REASON_TOKEN_NOT_ALLOWED);
        // 10 spender/router allowlist (default-deny opt-in). address(0) is never allowlisted. SKIPPED for
        //    the typed-spoke bridge path (its isolation is the spoke selector's own default-deny, not an
        //    address) so enabling the address allowlist never bricks bridge-outs.
        if (!skipSpenderAllowlist && spenderAllowlistEnabled && !spenderAllowed[spender]) {
            return (false, REASON_SPENDER_NOT_ALLOWED);
        }
        // 11 global per-tx cap.
        if (amount > perTxCap) return (false, REASON_OVER_TX_CAP);
        // 12 per-asset sub-cap.
        if (amount > assetCap[token]) return (false, REASON_OVER_ASSET_CAP);
        // 13 per-destination cap (and the explicit blocked zero-allowance). Skipped for address(0).
        if (spender != address(0)) {
            if (destBlocked[spender]) return (false, REASON_OVER_DEST_CAP);
            uint256 dcap = destCap[spender];
            if (dcap != 0 && amount > dcap) return (false, REASON_OVER_DEST_CAP);
        }
        // 14 rolling-period cap (leaky bucket, overflow-safe). NET OUT any headroom THIS spend already
        //    reserved at queue (re-gate path): the reserved amount is still sitting in the bucket, so the
        //    effective prior level is `level - min(level, reservedAmount)`; counting it again would
        //    double-charge the SAME money and falsely refuse a valid queued egress.
        if (periodSeconds != 0) {
            uint256 lvl = _levelNow();
            uint256 priorLvl = lvl > reservedAmount ? lvl - reservedAmount : 0;
            // overflow-safe: amount > periodCap OR priorLvl > periodCap - amount.
            if (amount > periodCap || priorLvl > periodCap - amount) {
                return (false, REASON_OVER_PERIOD_CAP);
            }
        }
        // 15 tx-count cap (leaky bucket). Skipped on the re-gate of a reserved egress (it never charged
        //    tx-count at queue, so re-charging here would let unrelated activity strand it).
        if (!skipTxCount && maxTxPerPeriod != 0) {
            uint256 txLvl = _txLevelNow();
            if (txLvl + 1 > maxTxPerPeriod) return (false, REASON_OVER_TXCOUNT_CAP);
        }
        // 16 USD-denominated cap (opt-in, fail-closed) + USD dust floor.
        if (address(priceFeed) != address(0) && usdCapMicros != 0) {
            (bool priced, uint256 usdMicros) = _usdValueMicros(token, amount);
            if (!priced) return (false, REASON_PRICE_UNAVAILABLE);
            if (minUsdMicros != 0 && usdMicros < minUsdMicros) return (false, REASON_BELOW_MIN_USD);
            if (usdMicros > usdCapMicros) return (false, REASON_OVER_USD_CAP);
        }
        // within the entire mandate.
        return (true, REASON_OK);
    }

    // ============================================================================================
    // Leaky-bucket math (overflow-safe; never reverts in the view path).
    // ============================================================================================

    /// @notice The value-bucket level NOW (a pure read; the leak that {_consume} applies on accrue). A full
    ///         period of refill empties it (clamp `elapsed` first so the refill product never overflows --
    ///         the `setPeriodConfig` precondition guarantees `periodSeconds * periodCap` fits in uint256).
    function _levelNow() internal view returns (uint256) {
        if (periodSeconds == 0) return 0;
        // forge-lint: disable-next-line(block-timestamp)
        uint256 elapsed = block.timestamp - bucketUpdatedAt;
        if (elapsed >= periodSeconds) return 0; // a full period drains it (clamp first -- overflow guard).
        uint256 refill = (elapsed * periodCap) / periodSeconds;
        return bucketLevel <= refill ? 0 : bucketLevel - refill;
    }

    /// @notice The tx-count-bucket level NOW (the same leaky math in "tx units" with cap == maxTxPerPeriod).
    function _txLevelNow() internal view returns (uint256) {
        if (periodSeconds == 0 || maxTxPerPeriod == 0) return 0;
        // forge-lint: disable-next-line(block-timestamp)
        uint256 elapsed = block.timestamp - txBucketUpdatedAt;
        if (elapsed >= periodSeconds) return 0;
        uint256 refill = (elapsed * maxTxPerPeriod) / periodSeconds;
        return txBucketLevel <= refill ? 0 : txBucketLevel - refill;
    }

    /// @notice The cumulative-egress-bucket level NOW (tiers the time-lock delay against smurfing).
    function _outboundLevelNow() internal view returns (uint256) {
        if (periodSeconds == 0) return outboundBucketLevel; // no period => no leak; the bucket is a running sum.
        // forge-lint: disable-next-line(block-timestamp)
        uint256 elapsed = block.timestamp - outboundBucketUpdatedAt;
        if (elapsed >= periodSeconds) return 0;
        uint256 refill = (elapsed * periodCap) / periodSeconds;
        return outboundBucketLevel <= refill ? 0 : outboundBucketLevel - refill;
    }

    // ============================================================================================
    // USD pricing (2-return, staleness + sanity-band + gas + overflow guarded; fail-closed; never reverts).
    // ============================================================================================

    /// @notice Price `amount` MINOR units of `token` in USD micros, exact-integer + fail-closed. Returns
    ///         `(false, 0)` on no feed / unset decimals / zero or stale or out-of-band price / overflow --
    ///         NEVER a revert (the folded queue path calls this from a mutating context).
    function _usdValueMicros(address token, uint256 amount)
        internal
        view
        returns (bool priced, uint256 usdMicros)
    {
        if (address(priceFeed) == address(0)) return (false, 0);
        if (!tokenDecimalsSet[token]) return (false, 0); // can't convert without decimals -> fail-closed.

        // The feed read is gas-capped + wrapped so a hostile/reverting/gas-bomb feed is fail-closed.
        try priceFeed.priceUsdMicros{gas: PRICE_FEED_GAS}(token) returns (uint256 price, uint64 updatedAt) {
            if (price == 0) return (false, 0);
            // forge-lint: disable-next-line(block-timestamp)
            if (maxPriceAge != 0 && block.timestamp > updatedAt && block.timestamp - updatedAt > maxPriceAge)
            {
                return (false, 0); // STALE -> fail-closed.
            }
            uint256 lo = minTokenPriceMicros[token];
            if (lo != 0 && price < lo) return (false, 0); // out-of-band low.
            uint256 hi = maxTokenPriceMicros[token];
            if (hi != 0 && price > hi) return (false, 0); // out-of-band high.
            // Overflow guard: above the ceiling, amount*price would overflow -> fail-closed, NEVER revert.
            if (price > MAX_PRICE_MICROS || amount > type(uint256).max / price) return (false, 0);
            uint256 scale = 10 ** uint256(tokenDecimals[token]);
            return (true, (amount * price) / scale);
        } catch {
            return (false, 0); // a reverting feed is unavailable -> fail-closed.
        }
    }

    /// @notice Public view of {_usdValueMicros} -- for the verifier / UI to confirm the USD tier on-chain.
    function usdValueMicros(address token, uint256 amount)
        external
        view
        returns (bool priced, uint256 micros)
    {
        return _usdValueMicros(token, amount);
    }

    // ============================================================================================
    // ATOMIC gate+accrue (the ADVISORY accrual path; the TOCTOU close). Gate AND accrue in ONE call.
    // ============================================================================================

    /// @notice Gate `amount` of `token` to `spender` at `reqEpoch` AND, iff it clears every tier, atomically
    ///         accrue it into the leaky bucket + tx-count -- in ONE call. This closes the
    ///         advisory-recordSpend / TOCTOU gap: there is no window between the check and the accrual.
    ///
    /// @dev    ADVISORY: this contract holds no funds, so the accrual is the agent's honest record of what it
    ///         is about to spend off-contract; the verifier reconciles every `SpendRecorded` 1:1 against the
    ///         on-chain `Transfer` it reads (the money-safe guarantee for a non-custodial registry). Only the
    ///         bound {agent} may accrue (owner CANNOT accrue on the agent bucket -- closes the owner-poison
    ///         gap); a non-agent caller is a fail-closed `(false, NOT_AGENT)`, never a revert. CEI +
    ///         `nonReentrant`: consume + emit; no state write on any non-OK rung.
    function gateAndRecord(address token, uint256 amount, address spender, uint64 reqEpoch)
        external
        nonReentrant
        returns (bool ok, bytes32 reason, uint256 spendId)
    {
        // Money-path identity is msg.sender (NOT a passed agent_); only the bound agent may accrue.
        if (msg.sender != agent) return (false, REASON_NOT_AGENT, 0);

        (ok, reason) = _check(msg.sender, token, amount, spender, reqEpoch);
        if (!ok) return (ok, reason, 0); // fail-closed: nothing accrued.

        // Passed every tier -> accrue atomically (check-then-effect).
        if (periodSeconds != 0) {
            _consume(amount);
        }
        if (maxTxPerPeriod != 0) {
            _consumeTx();
        }
        spendId = nextSpendId;
        nextSpendId = spendId + 1;
        emit SpendRecorded(spendId, msg.sender, token, amount, spender, periodHeadroom(), epoch);
        return (true, REASON_OK, spendId);
    }

    /// @dev Consume `amount` from the value bucket (mutating; called only after a full gate pass).
    function _consume(uint256 amount) internal {
        uint256 lvl = _levelNow();
        // _check already proved lvl + amount <= periodCap for the current block.
        bucketLevel = lvl + amount;
        // forge-lint: disable-next-line(block-timestamp)
        bucketUpdatedAt = uint64(block.timestamp);
        emit BucketDebited(bucketLevel, bucketUpdatedAt);
    }

    /// @dev Consume one unit from the tx-count bucket.
    function _consumeTx() internal {
        uint256 lvl = _txLevelNow();
        txBucketLevel = lvl + 1;
        // forge-lint: disable-next-line(block-timestamp)
        txBucketUpdatedAt = uint64(block.timestamp);
        emit TxBucketDebited(txBucketLevel, txBucketUpdatedAt);
    }

    /// @dev Release `amount` back into the value bucket (a cancel/expire refund of a reserved queue).
    function _release(uint256 amount) internal {
        uint256 lvl = _levelNow();
        bucketLevel = lvl > amount ? lvl - amount : 0;
        // forge-lint: disable-next-line(block-timestamp)
        bucketUpdatedAt = uint64(block.timestamp);
        emit BucketReleased(bucketLevel, bucketUpdatedAt);
    }

    /// @notice Seed the value bucket to `newLevel` -- owner-only, MONOTONIC-UP only (a window-carryover at
    ///         genesis; never a free-cap reset). `newLevel` must be `>=` the current level and `<= periodCap`.
    function ownerSeedBucket(uint256 newLevel) external onlyOwner {
        if (periodSeconds == 0) revert BadPeriodConfig();
        uint256 lvl = _levelNow();
        if (newLevel < lvl || newLevel > periodCap) revert BadPeriodConfig();
        emit BucketSeeded(lvl, newLevel);
        bucketLevel = newLevel;
        // forge-lint: disable-next-line(block-timestamp)
        bucketUpdatedAt = uint64(block.timestamp);
    }

    // ============================================================================================
    // Views -- read helpers for the agent / web UI / verifier.
    // ============================================================================================

    /// @notice The effective per-tx ceiling for `token` to `spender`: min(perTxCap, assetCap, destCap), or 0
    ///         if not allowlisted / blocked. The gates are authoritative; period/USD tiers are not folded in.
    function effectiveCap(address token, address spender) external view returns (uint256) {
        if (!allowed[token]) return 0;
        if (spender != address(0) && destBlocked[spender]) return 0;
        uint256 cap = perTxCap;
        uint256 sub = assetCap[token];
        if (sub < cap) cap = sub;
        if (spender != address(0)) {
            uint256 dcap = destCap[spender];
            if (dcap != 0 && dcap < cap) cap = dcap;
        }
        return cap;
    }

    /// @notice The effective per-tx ceiling for `token` over a TYPED spoke `selector`: min(perTxCap,
    ///         assetCap, spokeCap[selector]). An UNCONFIGURED spoke authorizes nothing (returns 0).
    function spokeEffectiveCap(address token, uint64 selector) external view returns (uint256) {
        if (!allowed[token]) return 0;
        if (!spokeConfigured[selector]) return 0; // default-deny.
        uint256 cap = perTxCap;
        uint256 sub = assetCap[token];
        if (sub < cap) cap = sub;
        uint256 scap = spokeCap[selector];
        if (scap != 0 && scap < cap) cap = scap;
        return cap;
    }

    /// @notice The remaining headroom under the period cap in the current bucket, or `type(uint256).max`
    ///         when no period cap is configured.
    function periodHeadroom() public view returns (uint256) {
        if (periodSeconds == 0) return type(uint256).max;
        uint256 lvl = _levelNow();
        return lvl >= periodCap ? 0 : periodCap - lvl;
    }

    /// @notice The cumulative spend accrued in the current window (the value-bucket level NOW).
    function accruedInWindow() external view returns (uint256) {
        return _levelNow();
    }

    /// @notice The cumulative-egress bucket level NOW (the time-lock's anti-smurf tier).
    function outboundHeadroom() external view returns (uint256) {
        if (periodSeconds == 0) return type(uint256).max;
        uint256 lvl = _outboundLevelNow();
        return lvl >= periodCap ? 0 : periodCap - lvl;
    }

    /// @notice `true` iff the mandate is currently live for `agent_` (not paused/agent-paused/expired,
    ///         and started). Independent of any specific transfer.
    function isActive(address agent_) external view returns (bool) {
        // forge-lint: disable-next-line(block-timestamp)
        return !paused && !agentPaused[agent_] && block.timestamp >= start && block.timestamp < expiry;
    }

    /// @notice The lifecycle status of `queueId` (None for an unknown id).
    function statusOf(uint256 queueId) external view returns (LockStatus) {
        return requests[queueId].status;
    }

    /// @notice `true` iff `queueId` is Pending AND its delay has elapsed AND it is not past staleAfter.
    function isExecutable(uint256 queueId) external view returns (bool) {
        Request storage r = requests[queueId];
        if (r.status != LockStatus.Pending) return false;
        // forge-lint: disable-next-line(block-timestamp)
        uint256 nowTs = block.timestamp;
        return nowTs >= r.executableAt && nowTs < r.staleAfter;
    }

    /// @notice Seconds remaining until `queueId` becomes executable, or 0 if already executable / not Pending.
    function timeRemaining(uint256 queueId) external view returns (uint64) {
        Request storage r = requests[queueId];
        if (r.status != LockStatus.Pending) return 0;
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp >= r.executableAt) return 0;
        // forge-lint: disable-next-line(block-timestamp)
        return r.executableAt - uint64(block.timestamp);
    }

    /// @notice The value-tier delay (seconds) for an outbound `amount`: short when `<= bigValueThreshold`,
    ///         else long. Inclusive at the threshold == small.
    function delayFor(uint256 amount) public view returns (uint64) {
        return amount > bigValueThreshold ? longDelaySeconds : shortDelaySeconds;
    }

    // ============================================================================================
    // FOLDED OUTBOUND TIME-LOCK -- queue / execute (RE-GATED) / cancel / reap. NON-CUSTODIAL (no funds).
    // ============================================================================================

    /// @notice Queue an outbound bridge-out over a TYPED spoke `destSelector`, gated by the mandate at queue
    ///         AND scheduled by its value tier. RESERVES the amount against the period bucket (so egress is
    ///         period-bounded); tiers the delay against the cumulative-egress bucket (so smurfing past the
    ///         threshold crosses into the long lock). A refused gate REVERTS {MandateRefused} -- a queue id
    ///         only exists for a mandate-cleared egress. Bounded by MAX_PENDING. NON-CUSTODIAL: moves no
    ///         tokens -- it authorizes + delays the egress; the actual ccipSend follows a cleared execute.
    function queueBridgeOut(address token, uint256 amount, uint64 destSelector, address recipient)
        external
        nonReentrant
        returns (uint256 queueId)
    {
        if (msg.sender != agent && msg.sender != owner) revert NotAuthorized();
        if (token == address(0) || recipient == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        if (pendingCount >= MAX_PENDING) revert TooManyPending(MAX_PENDING);

        // (1) The mandate gate -- the kill-switch, BEFORE a queue id exists. The TYPED spoke must be
        //     configured (default-deny) and the spoke cap bounds it; we run _check with spender==address(0)
        //     (the spoke selector is the isolation key, not an address) and apply the spoke cap explicitly.
        if (!spokeConfigured[destSelector]) revert MandateRefused(REASON_SPOKE_NOT_CONFIGURED);
        // skipSpenderAllowlist=true: the typed spoke (proven configured above) is this path's isolation, so
        // the ADDRESS allowlist (which can never admit the address(0) sentinel) must not gate it.
        (bool ok, bytes32 reason) = _checkReserved(agent, token, amount, address(0), epoch, 0, false, true);
        if (!ok) revert MandateRefused(reason);
        // The spoke cap is an explicit additional tighten (typed, default-deny already proven above).
        uint256 scap = spokeCap[destSelector];
        if (scap != 0 && amount > scap) revert MandateRefused(REASON_OVER_DEST_CAP);

        // (2) Reserve period headroom (so a queued egress consumes the period cap up front; cancel/expire
        //     releases it). The reservation IS a consume of the value bucket.
        uint256 reserved = 0;
        if (periodSeconds != 0) {
            _consume(amount);
            reserved = amount;
        }
        // The cumulative-egress bucket accrues too (the anti-smurf tier read).
        _accrueOutbound(amount);

        // (3) The value-tiered schedule + the storage write + event are folded into a helper so this
        //     function's local-stack stays shallow (avoids stack-too-deep without via-ir).
        queueId = _recordQueue(token, amount, destSelector, recipient, reserved);
    }

    /// @dev Build the Request, store it under a fresh queue id, bump the pending count, and emit the queue
    ///      event. Split out of {queueBridgeOut} purely to keep the parent's stack shallow.
    function _recordQueue(
        address token,
        uint256 amount,
        uint64 destSelector,
        address recipient,
        uint256 reserved
    ) internal returns (uint256 queueId) {
        uint64 delaySeconds = _tieredDelay(amount);
        // forge-lint: disable-next-line(block-timestamp)
        uint64 queuedAt = uint64(block.timestamp);
        uint64 executableAt = queuedAt + delaySeconds;
        uint64 staleAfter = executableAt + cancelWindowSeconds;

        queueId = nextQueueId;
        nextQueueId = queueId + 1;
        pendingCount += 1;
        requests[queueId] = Request({
            status: LockStatus.Pending,
            agent: agent,
            token: token,
            destSelector: destSelector,
            recipient: recipient,
            amount: amount,
            reservedBucket: reserved,
            epochAtQueue: epoch,
            delaySeconds: delaySeconds,
            queuedAt: queuedAt,
            executableAt: executableAt,
            staleAfter: staleAfter
        });

        emit BridgeOutQueued(
            queueId,
            token,
            destSelector,
            recipient,
            amount,
            reserved,
            epoch,
            delaySeconds,
            queuedAt,
            executableAt,
            staleAfter
        );
    }

    /// @notice The delay tier for an egress, judged by the CUMULATIVE outbound level (anti-smurf): if the
    ///         running egress total has crossed `bigValueThreshold`, the long lock applies even to a small
    ///         leg; otherwise the per-amount tier. Inclusive at the threshold == small.
    function _tieredDelay(uint256 amount) internal view returns (uint64) {
        if (cancelWindowSeconds == 0 && shortDelaySeconds == 0 && longDelaySeconds == 0) {
            return 0; // tiers unconfigured -> no delay (the time-lock is opt-in).
        }
        uint256 cumulative = _outboundLevelNow();
        if (amount > bigValueThreshold || cumulative > bigValueThreshold) {
            return longDelaySeconds;
        }
        return shortDelaySeconds;
    }

    /// @dev Accrue `amount` into the cumulative-egress bucket (the anti-smurf running sum).
    function _accrueOutbound(uint256 amount) internal {
        uint256 lvl = _outboundLevelNow();
        outboundBucketLevel = lvl + amount;
        // forge-lint: disable-next-line(block-timestamp)
        outboundBucketUpdatedAt = uint64(block.timestamp);
    }

    /// @notice Execute a queued bridge-out -- ONLY after its delay elapsed AND it RE-PASSES the gate at the
    ///         current state + its `epochAtQueue`. RE-GATING is load-bearing: a pause / expiry / epoch-bump /
    ///         de-allowlist / cap-tighten between queue and execute REFUSES the execute ({MandateRefused}) --
    ///         the schedule can only DENY, never extend executability. REVERTS {TooEarly} while too early,
    ///         {NotPending} if not pending. NON-CUSTODIAL: marks Executed + emits; moves no tokens.
    function executeBridgeOut(uint256 queueId) external nonReentrant {
        if (msg.sender != agent && msg.sender != owner) revert NotAuthorized();
        Request storage r = requests[queueId];
        if (r.status == LockStatus.None) revert UnknownQueueId(queueId);
        if (r.status != LockStatus.Pending) revert NotPending(queueId, r.status);

        // forge-lint: disable-next-line(block-timestamp)
        uint64 nowTs = uint64(block.timestamp);
        if (nowTs < r.executableAt) revert TooEarly(queueId, nowTs, r.executableAt);

        // RE-GATE at execute (D1): the queued egress must STILL clear the gate at the snapshot epoch.
        // It already RESERVED `r.reservedBucket` of period headroom at queue (still consumed), so net that
        // out of the period rung + skip tx-count -- otherwise the re-gate double-charges the SAME money and
        // wrongly refuses a valid egress. Every other rung (pause/expiry/epoch/allowlist/caps) STILL re-runs,
        // so a tighten between queue and execute can only DENY, never extend executability.
        if (!spokeConfigured[r.destSelector]) revert MandateRefused(REASON_SPOKE_NOT_CONFIGURED);
        (bool ok, bytes32 reason) = _checkReserved(
            r.agent, r.token, r.amount, address(0), r.epochAtQueue, r.reservedBucket, true, true
        );
        if (!ok) revert MandateRefused(reason);
        uint256 scap = spokeCap[r.destSelector];
        if (scap != 0 && r.amount > scap) revert MandateRefused(REASON_OVER_DEST_CAP);

        r.status = LockStatus.Executed; // absorbing success -- a request executes at most once.
        // The reservation is now a real spend (it stays consumed; no release).
        pendingCount -= 1;
        emit BridgeOutExecuted(queueId, nowTs, r.executableAt);
    }

    /// @notice Cancel a still-Pending bridge-out before it executes -- the owner/guardian/queuer in-window
    ///         abort. RELEASES the reserved period headroom (so a cancelled egress does not strand the cap).
    ///         Cancel does NOT reset the cumulative-egress clock (a re-queue of the same lane keeps its
    ///         smurf-tier position). NON-CUSTODIAL: no value ever moved.
    function cancelBridgeOut(uint256 queueId) external nonReentrant {
        if (msg.sender != agent && msg.sender != owner && msg.sender != guardian) revert NotAuthorized();
        Request storage r = requests[queueId];
        if (r.status == LockStatus.None) revert UnknownQueueId(queueId);
        if (r.status != LockStatus.Pending) revert NotPending(queueId, r.status);

        r.status = LockStatus.Cancelled; // absorbing abort.
        pendingCount -= 1;
        if (r.reservedBucket != 0) {
            _release(r.reservedBucket);
        }
        // forge-lint: disable-next-line(block-timestamp)
        emit BridgeOutCancelled(queueId, uint64(block.timestamp));
    }

    /// @notice Reap a Pending request past its `staleAfter` window -- marks it Expired (inert), releases its
    ///         reservation, frees a pending slot. Anyone may reap (it is a tighten / GC, never a loosen).
    function reapStale(uint256 queueId) external nonReentrant {
        Request storage r = requests[queueId];
        if (r.status == LockStatus.None) revert UnknownQueueId(queueId);
        if (r.status != LockStatus.Pending) revert NotPending(queueId, r.status);
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp < r.staleAfter) revert TooEarly(queueId, uint64(block.timestamp), r.staleAfter);

        r.status = LockStatus.Expired;
        pendingCount -= 1;
        if (r.reservedBucket != 0) {
            _release(r.reservedBucket);
        }
        // forge-lint: disable-next-line(block-timestamp)
        emit BridgeOutExpired(queueId, uint64(block.timestamp));
    }

    // ============================================================================================
    // ADMIN -- tighten ops are INSTANT (owner; some guardian-shared); loosen ops are DELAYED (owner-only).
    // ============================================================================================

    // --- pause (tighten -- owner OR guardian) / unpause (owner-only, instant recovery) ----------

    /// @notice Engage the GLOBAL kill-switch (a TIGHTEN -- owner OR guardian; covers in-flight egress via
    ///         the execute re-gate).
    function pause() external onlyOwnerOrGuardian {
        paused = true;
        emit Paused(true);
    }

    /// @notice Release the global kill-switch (owner-only; an instant recovery, not a loosening-delay op).
    function unpause() external onlyOwner {
        paused = false;
        emit Paused(false);
    }

    /// @notice Engage a PER-AGENT kill-switch (TIGHTEN -- owner OR guardian).
    function pauseAgent(address a) external onlyOwnerOrGuardian {
        if (a == address(0)) revert ZeroAddress();
        agentPaused[a] = true;
        emit AgentPaused(a, true);
    }

    /// @notice Release a per-agent kill-switch (owner-only recovery).
    function unpauseAgent(address a) external onlyOwner {
        if (a == address(0)) revert ZeroAddress();
        agentPaused[a] = false;
        emit AgentPaused(a, false);
    }

    // --- epoch / expiry-shrink / dest-block / spoke-clear / asset-remove (TIGHTEN -- instant) ----

    /// @notice Bump the epoch -- an INSTANT, money-path TIGHTEN that strands every in-flight grant (and any
    ///         queued egress re-gated at execute). A real revocation.
    function bumpEpoch() external onlyOwner {
        uint64 prev = epoch;
        epoch = prev + 1;
        emit EpochBumped(prev, epoch);
    }

    /// @notice Set the start time. Moving the start LATER shrinks the active window forward (a TIGHTEN --
    ///         instant). Moving it EARLIER widens the window / un-defers a delayed activation (a LOOSEN) and
    ///         MUST go through {queueParamChange} -> {setStartLoosen}; this direct path reverts on a non-raise
    ///         so the delayed-loosening doctrine holds on EVERY risk-increasing op.
    function setStart(uint64 start_) external onlyOwner {
        if (start_ < start) revert BadTierConfig(); // an earlier start is a loosen -> use the param queue.
        emit StartSet(start, start_);
        start = start_;
    }

    /// @notice SHRINK the expiry (a TIGHTEN -- instant). Extending the expiry is a LOOSEN and must go through
    ///         {queueParamChange} -> {setExpiryLoosen}. Reverts if `newExpiry >= expiry` (use the queue).
    function setExpiry(uint64 newExpiry) external onlyOwner {
        if (newExpiry >= expiry) revert BadTierConfig(); // a non-shrink is a loosen -> use the param queue.
        emit ExpirySet(expiry, newExpiry);
        expiry = newExpiry;
    }

    /// @notice Block a destination (an explicit zero-allowance TIGHTEN -- instant).
    function blockDest(address spender, bool blocked) external onlyOwner {
        if (spender == address(0)) revert ZeroAddress();
        destBlocked[spender] = blocked;
        emit DestBlocked(spender, blocked);
    }

    /// @notice Clear a spoke (restore default-deny -- a TIGHTEN, instant).
    function clearSpoke(uint64 selector) external onlyOwner {
        if (spokeConfigured[selector]) {
            spokeConfigured[selector] = false;
            spokeCap[selector] = 0;
            spokeCount -= 1;
            emit SpokeCleared(selector);
        }
    }

    /// @notice Remove a token from the allowlist (a TIGHTEN -- instant).
    function removeAllowedAsset(address token) external onlyOwner {
        if (allowed[token]) {
            allowed[token] = false;
            allowedTokenCount -= 1;
            emit AssetRuleSet(token, assetCap[token], false);
        }
    }

    /// @notice De-allowlist a spender (a TIGHTEN -- instant).
    function removeSpender(address spender) external onlyOwner {
        if (spenderAllowed[spender]) {
            spenderAllowed[spender] = false;
            spenderCount -= 1;
            emit SpenderAllowlistSet(spender, false);
        }
    }

    /// @notice TIGHTEN the per-tx cap (a lower cap -- instant). Raising it is a LOOSEN (param queue).
    function setPerTxCapTighten(uint256 newCap) external onlyOwner {
        if (newCap >= perTxCap) revert BadTierConfig();
        emit PerTxCapSet(perTxCap, newCap);
        perTxCap = newCap;
    }

    /// @notice Set the raw dust floor (always a tighten on the low edge -- instant).
    function setMinSpend(uint256 raw_) external onlyOwner {
        emit MinSpendSet(minSpend, raw_);
        minSpend = raw_;
    }

    /// @notice Set the USD dust floor (instant).
    function setMinUsdMicros(uint256 micros) external onlyOwner {
        emit MinUsdSet(minUsdMicros, micros);
        minUsdMicros = micros;
    }

    // --- allowlist / cap setters with the bounded-list count (tighten-or-config) -----------------

    /// @notice Allowlist `token`, set its sub-cap, and BIND its decimals to the live on-chain `decimals()`.
    ///         Reverts unless `token.code.length>0` and the live decimals match `dec`. The native sentinel
    ///         skips the live read (decimals pinned to 18 at construction). Bounded by MAX_LIST. The cap is a
    ///         CONFIG (a fresh allowlist entry) -- raising an EXISTING asset's cap goes through the param
    ///         queue ({setAssetCapLoosen}); a fresh add or a cap reduction is instant.
    function addAllowedAsset(address token, uint256 cap, uint8 dec) external onlyOwner {
        if (token == address(0)) revert ZeroAddress();
        if (token == NATIVE) {
            if (dec != 18) revert BadDecimals();
        } else {
            if (token.code.length == 0) revert NotAContract();
            if (IERC20Decimals(token).decimals() != dec) revert BadDecimals();
        }
        // A cap raise on an EXISTING allowed asset must use the param queue.
        if (allowed[token] && cap > assetCap[token]) revert BadTierConfig();
        _setAllowed(token, true);
        assetCap[token] = cap;
        tokenDecimals[token] = dec;
        tokenDecimalsSet[token] = true;
        emit AssetRuleSet(token, cap, true);
        emit TokenDecimalsSet(token, dec);
    }

    /// @notice TIGHTEN an allowlisted asset's sub-cap (a lower cap -- instant). Raising goes through the
    ///         param queue ({setAssetCapLoosen}).
    function setAssetCapTighten(address token, uint256 cap) external onlyOwner {
        if (!allowed[token]) revert NotAuthorized();
        if (cap >= assetCap[token]) revert BadTierConfig();
        assetCap[token] = cap;
        emit AssetCapSet(token, cap);
    }

    /// @dev Internal allowlist toggle with the bounded-list count maintained.
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

    /// @notice Re-bind a token's decimals to its live `decimals()` (instant; reverts unless they match).
    function setTokenDecimals(address token, uint8 dec) external onlyOwner {
        if (token == address(0)) revert ZeroAddress();
        if (token == NATIVE) {
            if (dec != 18) revert BadDecimals();
        } else {
            if (token.code.length == 0) revert NotAContract();
            if (IERC20Decimals(token).decimals() != dec) revert BadDecimals();
        }
        tokenDecimals[token] = dec;
        tokenDecimalsSet[token] = true;
        emit TokenDecimalsSet(token, dec);
    }

    /// @notice Set a token's USD sanity band (a tighten on the priced range -- instant). `lo<=hi` required.
    function setPriceBand(address token, uint256 lo, uint256 hi) external onlyOwner {
        if (lo != 0 && hi != 0 && lo > hi) revert BadPriceConfig();
        minTokenPriceMicros[token] = lo;
        maxTokenPriceMicros[token] = hi;
        emit PriceBandSet(token, lo, hi);
    }

    /// @notice Allowlist a spender/router (bounded by MAX_LIST). Rejects the native sentinel (a spoke is a
    ///         typed key, never an address). Adding a spender is a config/tighten (default-deny on) -- instant.
    function setSpenderAllowed(address spender, bool isAllowed) external onlyOwner {
        if (spender == address(0)) revert ZeroAddress();
        if (spender == NATIVE) revert SentinelReserved();
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

    /// @notice Enable the spender allowlist (default-deny ON is a TIGHTEN -- instant); DISABLING it is a
    ///         LOOSEN and goes through the param queue ({setSpenderAllowlistEnabledLoosen}).
    function setSpenderAllowlistEnabled(bool on) external onlyOwner {
        if (!on && spenderAllowlistEnabled) revert BadTierConfig(); // disabling is a loosen -> param queue.
        spenderAllowlistEnabled = on;
        emit SpenderAllowlistEnabledSet(on);
    }

    /// @notice Set a per-destination cap (bounded by MAX_DESTCAP; 0 clears). Tighten-or-config -- instant.
    function setDestCap(address spender, uint256 cap) external onlyOwner {
        if (spender == address(0)) revert ZeroAddress();
        uint256 was = destCap[spender];
        if (cap != 0 && was == 0) {
            if (destCapCount >= MAX_DESTCAP) revert ListFull(MAX_DESTCAP);
            destCapCount += 1;
        } else if (cap == 0 && was != 0) {
            destCapCount -= 1;
        }
        destCap[spender] = cap;
        emit DestCapSet(spender, cap);
    }

    /// @notice Configure a TYPED spoke cap (bounded by MAX_DESTCAP; marks the spoke configured). Setting a
    ///         spoke cap is a config (default-deny -> configured) -- instant.
    function setSpokeCap(uint64 selector, uint256 cap) external onlyOwner {
        if (!spokeConfigured[selector]) {
            if (spokeCount >= MAX_DESTCAP) revert ListFull(MAX_DESTCAP);
            spokeCount += 1;
            spokeConfigured[selector] = true;
        }
        spokeCap[selector] = cap;
        emit SpokeCapSet(selector, cap);
    }

    // --- period / tx-count / feed mechanics ------------------------------------------------------

    /// @notice Configure the leaky-bucket period cap. Enforces `periodCap <= max/periodSeconds` so the refill
    ///         product never overflows the view gate. CARRIES the level forward (a retune is never a free-cap
    ///         event). HONEST BOUND: a leaky bucket admits up to ~2x cap over an arbitrary rolling window;
    ///         a deployment needing a hard rolling bound sizes the enforced cap at periodCap/2.
    function setPeriodConfig(uint64 periodSeconds_, uint256 periodCap_) external onlyOwner {
        if (periodSeconds_ != 0) {
            if (periodCap_ == 0) revert BadPeriodConfig();
            if (periodCap_ > type(uint256).max / periodSeconds_) revert BadPeriodConfig();
        }
        // Carry the current level forward (clamped to the new cap) so the retune is not a free-cap reset.
        uint256 carried = _levelNow();
        periodSeconds = periodSeconds_;
        periodCap = periodCap_;
        if (carried > periodCap_) carried = periodCap_;
        bucketLevel = carried;
        // forge-lint: disable-next-line(block-timestamp)
        bucketUpdatedAt = uint64(block.timestamp);
        // The tx + outbound buckets re-anchor to now (their caps are independent knobs).
        // forge-lint: disable-next-line(block-timestamp)
        txBucketUpdatedAt = uint64(block.timestamp);
        // forge-lint: disable-next-line(block-timestamp)
        outboundBucketUpdatedAt = uint64(block.timestamp);
        emit PeriodConfigSet(periodSeconds_, periodCap_);
    }

    /// @notice Set the max accrued spends (count) per period (the tx-count leaky bucket). Instant.
    function setMaxTxPerPeriod(uint32 n) external onlyOwner {
        maxTxPerPeriod = n;
        emit MaxTxPerPeriodSet(n);
    }

    /// @notice Set the opt-in price feed + the staleness bound. Repointing the feed is a LOOSEN (a permissive
    ///         twin) and goes through the param queue ({setPriceFeedLoosen}); CLEARING it (feed==0) is a
    ///         tighten (instant). The staleness bound is part of the same call.
    function setPriceFeed(IPriceFeedV2 feed, uint64 maxPriceAge_) external onlyOwner {
        if (address(feed) != address(0) && address(priceFeed) != address(0) && feed != priceFeed) {
            revert BadTierConfig(); // repoint is a loosen -> param queue.
        }
        priceFeed = feed;
        maxPriceAge = maxPriceAge_;
        emit PriceFeedSet(address(feed), maxPriceAge_);
    }

    /// @notice TIGHTEN the USD cap (a lower cap -- instant). Raising it is a LOOSEN (param queue). Setting it
    ///         from 0 (enabling the USD tier) is a tighten (adds a constraint) -- instant.
    function setUsdCapMicros(uint256 micros) external onlyOwner {
        if (usdCapMicros != 0 && micros > usdCapMicros) revert BadTierConfig(); // raise -> param queue.
        usdCapMicros = micros;
        emit UsdCapSet(micros);
    }

    /// @notice Set the value tiers + the cancel window. `longDelay >= shortDelay`. Instant for a delay
    ///         INCREASE (a tighten); a delay DECREASE is a loosen (param queue -> {setTiersLoosen}).
    function setTiers(uint256 bigValueThreshold_, uint64 shortDelay_, uint64 longDelay_, uint64 cancelWindow_)
        external
        onlyOwner
    {
        if (longDelay_ < shortDelay_) revert BadTierConfig();
        // A shorter delay than the current is a loosen.
        if (shortDelay_ < shortDelaySeconds || longDelay_ < longDelaySeconds) revert BadTierConfig();
        bigValueThreshold = bigValueThreshold_;
        shortDelaySeconds = shortDelay_;
        longDelaySeconds = longDelay_;
        cancelWindowSeconds = cancelWindow_;
        emit TiersSet(bigValueThreshold_, shortDelay_, longDelay_, cancelWindow_);
    }

    // ============================================================================================
    // GOVERNANCE -- two-step ownership + guardian + delayed-loosening param queue.
    // ============================================================================================

    /// @notice Begin a TWO-STEP ownership transfer (sets the pending owner; the new key must {acceptOwnership}).
    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        pendingOwner = newOwner;
        emit OwnershipTransferStarted(owner, newOwner);
    }

    /// @notice Complete the two-step ownership transfer (the pending owner commits -- proves liveness).
    function acceptOwnership() external {
        if (msg.sender != pendingOwner) revert NotPendingOwner();
        emit OwnershipTransferred(owner, pendingOwner);
        owner = pendingOwner;
        pendingOwner = address(0);
    }

    /// @notice Set the guardian (a SEPARATE role from owner; reverts if it equals the owner).
    function setGuardian(address g) external onlyOwner {
        if (g == address(0)) revert ZeroAddress();
        if (g == owner) revert BadTierConfig();
        emit GuardianSet(guardian, g);
        guardian = g;
    }

    /// @notice Set the agent. Changing the agent is a LOOSEN (it re-points spend authority) and goes through
    ///         the param queue ({setAgentLoosen}); this direct path is therefore owner-only AND delayed --
    ///         it reverts (use the queue). Kept for ABI clarity / the queue target.
    function setAgent(address) external view onlyOwner {
        revert BadTierConfig(); // setAgent is a loosen -> queueParamChange(setAgentLoosen).
    }

    /// @notice RAISE the delay on risk-increasing owner ops (a TIGHTEN -- instant). LOWERING the delay is
    ///         itself a risk-increasing op (it would let a future loosen land sooner -- the classic bypass of
    ///         a hijacked owner key shortening its own time-lock), so a DECREASE must go through
    ///         {queueParamChange} -> {setParamDelayLoosen} and is therefore delayed BY THE CURRENT delay.
    ///         Reverts on a decrease via this direct path.
    function setParamDelay(uint64 secs) external onlyOwner {
        if (secs < paramDelaySeconds) revert BadTierConfig(); // shortening the delay is a loosen -> queue.
        paramDelaySeconds = secs;
        emit ParamDelaySet(secs);
    }

    // --- the param queue: every LOOSEN is queued, delayed, guardian-cancellable -------------------

    /// @notice Queue a risk-INCREASING (loosening) self-call -- raise a cap, extend expiry, change the agent,
    ///         repoint the feed, disable an allowlist. Executes only after `paramDelaySeconds`, and is
    ///         guardian-cancellable. The `call` is the ABI-encoded self-call of a `*Loosen` setter. Bounded.
    function queueParamChange(bytes calldata call) external onlyOwner returns (uint256 paramId) {
        if (pendingParamCount >= MAX_LIST) revert ListFull(MAX_LIST);
        paramId = nextParamId;
        nextParamId = paramId + 1;
        pendingParamCount += 1;
        // forge-lint: disable-next-line(block-timestamp)
        uint64 executableAt = uint64(block.timestamp) + paramDelaySeconds;
        paramChanges[paramId] =
            ParamChange({status: ParamStatus.Queued, call: call, executableAt: executableAt});
        emit ParamChangeQueued(paramId, executableAt);
    }

    /// @notice Execute a queued param change after its delay -- re-validates by running the encoded self-call
    ///         (a `*Loosen` setter that is callable ONLY via this path -- it checks `msg.sender == address(this)`).
    function executeParamChange(uint256 paramId) external onlyOwner {
        ParamChange storage p = paramChanges[paramId];
        if (p.status == ParamStatus.None) revert UnknownParam(paramId);
        if (p.status != ParamStatus.Queued) revert ParamNotQueued(paramId, p.status);
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp < p.executableAt) {
            // forge-lint: disable-next-line(block-timestamp)
            revert ParamNotReady(paramId, uint64(block.timestamp), p.executableAt);
        }
        p.status = ParamStatus.Executed;
        pendingParamCount -= 1;
        // Run the loosening self-call (the *Loosen setters gate on msg.sender == address(this)).
        (bool success,) = address(this).call(p.call);
        if (!success) revert BadTierConfig();
        emit ParamChangeExecuted(paramId);
    }

    /// @notice Cancel a queued param change (owner OR guardian -- a tighten).
    function cancelParamChange(uint256 paramId) external onlyOwnerOrGuardian {
        ParamChange storage p = paramChanges[paramId];
        if (p.status == ParamStatus.None) revert UnknownParam(paramId);
        if (p.status != ParamStatus.Queued) revert ParamNotQueued(paramId, p.status);
        p.status = ParamStatus.Cancelled;
        pendingParamCount -= 1;
        emit ParamChangeCancelled(paramId);
    }

    /// @dev Only the contract itself (via {executeParamChange} after the delay) may call a `*Loosen` setter.
    modifier onlySelf() {
        if (msg.sender != address(this)) revert NotAuthorized();
        _;
    }

    /// @notice LOOSEN the per-tx cap (delayed -- via the param queue only).
    function setPerTxCapLoosen(uint256 newCap) external onlySelf {
        emit PerTxCapSet(perTxCap, newCap);
        perTxCap = newCap;
    }

    /// @notice LOOSEN an asset sub-cap (delayed).
    function setAssetCapLoosen(address token, uint256 cap) external onlySelf {
        assetCap[token] = cap;
        emit AssetCapSet(token, cap);
    }

    /// @notice LOOSEN the USD cap (delayed).
    function setUsdCapLoosen(uint256 micros) external onlySelf {
        usdCapMicros = micros;
        emit UsdCapSet(micros);
    }

    /// @notice EXTEND the expiry (delayed -- a longer time-box is a loosen).
    function setExpiryLoosen(uint64 newExpiry) external onlySelf {
        emit ExpirySet(expiry, newExpiry);
        expiry = newExpiry;
    }

    /// @notice CHANGE the agent (delayed -- re-points spend authority).
    function setAgentLoosen(address newAgent) external onlySelf {
        if (newAgent == address(0)) revert ZeroAddress();
        emit AgentSet(agent, newAgent);
        agent = newAgent;
    }

    /// @notice REPOINT the price feed (delayed -- a permissive twin is a loosen).
    function setPriceFeedLoosen(IPriceFeedV2 feed, uint64 maxPriceAge_) external onlySelf {
        priceFeed = feed;
        maxPriceAge = maxPriceAge_;
        emit PriceFeedSet(address(feed), maxPriceAge_);
    }

    /// @notice DISABLE the spender allowlist (delayed -- default-deny off is a loosen).
    function setSpenderAllowlistEnabledLoosen(bool on) external onlySelf {
        spenderAllowlistEnabled = on;
        emit SpenderAllowlistEnabledSet(on);
    }

    /// @notice SHORTEN the value tiers (delayed -- a faster lock is a loosen).
    function setTiersLoosen(
        uint256 bigValueThreshold_,
        uint64 shortDelay_,
        uint64 longDelay_,
        uint64 cancelWindow_
    ) external onlySelf {
        if (longDelay_ < shortDelay_) revert BadTierConfig();
        bigValueThreshold = bigValueThreshold_;
        shortDelaySeconds = shortDelay_;
        longDelaySeconds = longDelay_;
        cancelWindowSeconds = cancelWindow_;
        emit TiersSet(bigValueThreshold_, shortDelay_, longDelay_, cancelWindow_);
    }

    /// @notice SHORTEN the param-change delay (delayed -- shortening the time-lock is itself a loosen, so it
    ///         is gated BY THE CURRENT delay; a hijacked owner cannot instantly disarm the loosening delay).
    function setParamDelayLoosen(uint64 secs) external onlySelf {
        paramDelaySeconds = secs;
        emit ParamDelaySet(secs);
    }

    /// @notice Move the START earlier (delayed -- widening the active window / un-deferring activation is a
    ///         loosen). Raising the start (a tighten) stays the instant {setStart} path.
    function setStartLoosen(uint64 start_) external onlySelf {
        emit StartSet(start, start_);
        start = start_;
    }
}
