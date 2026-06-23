// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.26;

/// @title  IMandateGate -- the minimal, v2-compatible spend-gate seam the time-lock composes with.
/// @notice The exact {checkTransferTo(agent, token, amount, spender) -> (ok, reason)} shape of
///         {MandateRegistryV3} (and the v2 {checkTransfer} family). The time-lock holds only the
///         registry ADDRESS and calls this view as a zero-gas `eth_call` precondition when a bridge-out
///         is QUEUED -- so the same fail-closed four-tier gate that bounds an on-hub spend also bounds
///         every outbound bridge, BEFORE anything is queued. Declared at file scope (a clean-room,
///         swappable interface; the registry is wired by address, never vendored).
/// @dev    The real registry's {checkTransferTo} is a `view` that never reverts (its gates never
///         revert); the time-lock treats any `ok == false` as a refused queue and surfaces the
///         registry's own reason tag. The interface method is declared NON-view (the widest mutability)
///         so a `view` registry satisfies it AND a recording test double can implement it -- mutability
///         is not part of the function selector, so the on-chain call shape is identical either way.
interface IMandateGate {
    /// @return ok     true iff the spend clears every enabled mandate tier.
    /// @return reason the registry's ASCII `bytes32` reason tag (`bytes32(0)` == REASON_OK).
    function checkTransferTo(address agent, address token, uint256 amount, address spender)
        external
        returns (bool ok, bytes32 reason);

    /// @notice The registry's per-destination 'sandbox' cap for `spender`, MINOR units (V3 Tier 4).
    ///         `0` == unset (no per-destination tightening). The time-lock reads THIS, keyed by the
    ///         per-spoke sentinel, to surface a spoke's ISOLATED cap (design "2b.3").
    function destCap(address spender) external view returns (uint256);

    /// @notice The registry's effective per-tx limit for `token` to `spender` -- `min(perTxCap,
    ///         assetCap[token], destCap[spender])`, or `0` if the token is not allowlisted (V3). The
    ///         time-lock reads THIS, keyed by the per-spoke sentinel, for a spoke's effective ceiling.
    function effectiveCap(address token, address spender) external view returns (uint256);
}

/// @title  TimelockGuard -- the ASYMMETRICAL, VALUE-TIERED outbound bridge time-lock.
/// @author CJ (first author) -- SweePoh (second author / support)
/// @notice The on-chain half of the hub-and-spoke cross-chain envelope's RISKY direction (design
///         "2b.2 Outbound (hub -> spoke) is the RISKY direction"). Bridging value OUT of the 0G hub
///         BURNS/LOCKS on the hub and then depends on a remote chain we do NOT control to release --
///         the hollow-egress trap. Inbound (spoke -> hub) is autonomous and needs no extra ceremony;
///         OUTBOUND gets an asymmetric control inbound does not: a TWO-STEP, VALUE-TIERED time-lock.
///
///         The flow is split so a large outbound transfer is HELD for a delay before it can execute,
///         giving the owner a window to cancel a mistaken or hijacked egress BEFORE any value burns:
///
///         - {queueBridgeOut}(token, amount, destSelector, recipient) -> queueId
///             Runs the mandate {checkTransferTo} gate (the SAME four-tier fail-closed precondition that
///             bounds an on-hub spend, pinned to the per-spoke destination) HERE, at queue time, and
///             records the request with a value-TIERED `executableAt`:
///               * amount <= {bigValueThreshold}  -> a SHORT delay ({shortDelaySeconds})
///               * amount  > {bigValueThreshold}  -> a LONG  delay ({longDelaySeconds}, the 24h-style lock)
///             A refused mandate gate REVERTS the queue (nothing is recorded) -- the kill-switch runs
///             before a queue id even exists.
///         - {executeBridgeOut}(queueId)
///             REVERTS with {TooEarly} unless `block.timestamp >= executableAt` (no bypass: a too-early
///             execute can never pass), and reverts if already executed/cancelled. On success it marks
///             the request executed and EMITS {BridgeOutExecuted} -- the on-chain record the independent
///             verifier reads to CONFIRM "executed only AFTER the tier's delay elapsed."
///         - {cancelBridgeOut}(queueId)
///             The owner (or the original queuer) aborts a still-pending request IN-WINDOW. Reverts if
///             the request already executed (you cannot un-burn). This is the human-in-the-loop window
///             the asymmetry buys: the safest egress failure is the one that never burns on the hub.
///
/// @dev    The time-lock does NOT itself move tokens or call the bridge -- it is a GUARD that gates +
///         delays + records the AUTHORIZATION to bridge out. The actual `ccipSend` is the operator/agent
///         step that follows a cleared {executeBridgeOut}; keeping the burn OUT of this contract means a
///         queue/cancel can never strand value, and the contract holds no funds (no custody surface).
///
///         FAIL-CLOSED (design SS3 principle 3, never fabricate -- on the spend side): a refused mandate
///         reverts the queue; a too-early or twice-spent execute reverts; an unknown queue id reverts.
///         No path fabricates an executable authorization.
///
///         EXACT-INTEGER (design SS3 principle 5): every amount + threshold comparison is exact `uint256`
///         minor-unit arithmetic; delays are exact second counts. No floating point on the money path.
///
///         DETERMINISTIC (design SS3 principle 4): `executableAt` is a pure function of the queue-time
///         `block.timestamp` + the value tier's fixed delay; the same inputs always yield the same
///         schedule + the same (revert | execute) decision.
///
///         CLEAN-ROOM (design SS6): fresh Solidity, vendors no library, names no proprietary identifier,
///         private path, or secret; it composes with the public {checkTransferTo} gate shape by address.
contract TimelockGuard {
    // ============================================================================================
    // The two-step lifecycle status of a queued bridge-out. A request is created PENDING; it ends
    // EXECUTED (the delay elapsed and {executeBridgeOut} cleared it) or CANCELLED (the owner/queuer
    // aborted it in-window). The terminal states are absorbing -- neither can transition again.
    // ============================================================================================

    /// @notice Lifecycle of a queued bridge-out request.
    enum Status {
        /// The slot has never been used (a zero/unknown queue id reads as None).
        None,
        /// Queued + within (or past) its delay window, not yet executed or cancelled.
        Pending,
        /// {executeBridgeOut} cleared it AFTER the tier's delay -- the absorbing success state.
        Executed,
        /// {cancelBridgeOut} aborted it in-window -- the absorbing abort state.
        Cancelled
    }

    /// @notice One queued outbound-bridge authorization. Records exactly what the verifier needs to
    ///         CONFIRM the time-lock held: who queued it, the lane (token + destSelector + recipient),
    ///         the exact-integer amount, the value tier's `delaySeconds`, the `queuedAt` time, the
    ///         derived `executableAt` (queuedAt + delaySeconds), and the lifecycle status. Append-only
    ///         in spirit: a slot is written once at queue and only its `status` flips on execute/cancel.
    struct Request {
        /// The lifecycle status (None until queued).
        Status status;
        /// The agent the queue was authorized for (the mandate's agent; echoed for the audit trail).
        address agent;
        /// The bridged token (the lane asset, e.g. USDC.E / w0G), MINOR units.
        address token;
        /// The CCIP destination-chain selector this egress targets (the pinned spoke).
        uint64 destSelector;
        /// The destination-chain recipient of the released/minted value.
        address recipient;
        /// The amount to bridge out, MINOR units (exact-integer).
        uint256 amount;
        /// The value tier's delay, in seconds (short for small, long for big -- the 24h-style lock).
        uint256 delaySeconds;
        /// The unix second the request was queued.
        uint256 queuedAt;
        /// The unix second at/after which {executeBridgeOut} may clear it (`queuedAt + delaySeconds`).
        uint256 executableAt;
    }

    // ============================================================================================
    // Immutable wiring + owner.
    // ============================================================================================

    /// @notice The guard owner / admin (can re-tune the tiers, cancel any pending request).
    address public owner;

    /// @notice The agent the outbound queue is authorized for -- the mandate's single agent. Only this
    ///         agent (or the owner) may QUEUE an egress, mirroring the registry's agent-gated spend.
    address public agent;

    /// @notice The mandate registry the queue gates against (its {checkTransferTo} is the precondition).
    ///         Held by ADDRESS only -- a clean-room, swappable wiring; the guard vendors no registry code.
    IMandateGate public mandate;

    // ============================================================================================
    // The VALUE TIERS (design "2b.2 value-tiered time-lock"). Small outbound transfers clear fast;
    // a big-value transfer (over the threshold) is held under a long, 24h-style lock so the owner has
    // a real window to cancel a mistaken/hijacked large egress. Owner-tunable.
    // ============================================================================================

    /// @notice The value boundary, MINOR units: `amount <= bigValueThreshold` is the SMALL tier (short
    ///         delay); `amount > bigValueThreshold` is the BIG tier (the long 24h-style lock).
    uint256 public bigValueThreshold;
    /// @notice The SHORT delay for the small tier, in seconds.
    uint256 public shortDelaySeconds;
    /// @notice The LONG delay for the big tier, in seconds (the 24h-style lock for a large egress).
    uint256 public longDelaySeconds;

    /// @notice Monotonic queue-id counter; the next id {queueBridgeOut} will assign. Starts at 1 so a
    ///         `0` id is always the unused/None sentinel (no request ever has id 0).
    uint256 public nextQueueId;

    /// @notice queueId => the queued request. id 0 is never used (the None sentinel).
    mapping(uint256 => Request) public requests;

    // ============================================================================================
    // Events -- the on-chain audit trail the independent verifier reads (design SS3 principle 1). The
    // verifier confirms "executed only AFTER the delay" from {BridgeOutQueued} + {BridgeOutExecuted}.
    // ============================================================================================

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event AgentSet(address indexed previousAgent, address indexed newAgent);
    event MandateSet(address indexed previousMandate, address indexed newMandate);
    event TiersSet(uint256 bigValueThreshold, uint256 shortDelaySeconds, uint256 longDelaySeconds);

    /// @notice A bridge-out was queued (the mandate gate cleared). Carries the full lane + the value
    ///         tier's `delaySeconds` + the derived `executableAt`, so the verifier can CONFIRM the
    ///         schedule from the chain alone.
    event BridgeOutQueued(
        uint256 indexed queueId,
        address indexed token,
        uint64 indexed destSelector,
        address recipient,
        uint256 amount,
        uint256 delaySeconds,
        uint256 queuedAt,
        uint256 executableAt
    );
    /// @notice A queued bridge-out was EXECUTED -- AND only because `block.timestamp >= executableAt`.
    ///         The verifier reads this + the queue event to confirm the delay was honored (no bypass).
    event BridgeOutExecuted(uint256 indexed queueId, uint256 executedAt, uint256 executableAt);
    /// @notice A pending bridge-out was CANCELLED in-window by the owner/queuer (no value ever burned).
    event BridgeOutCancelled(uint256 indexed queueId, uint256 cancelledAt);

    // ============================================================================================
    // Errors. The mutating surface reverts (it changes state / refuses an unsafe action).
    // ============================================================================================

    error NotOwner();
    error NotAuthorized();
    error ZeroAddress();
    error ZeroAmount();
    error BadTierConfig();
    /// @notice The mandate gate refused the queue; carries the registry's own reason tag (fail-closed).
    error MandateRefused(bytes32 reason);
    /// @notice The queue id is unknown / never queued (status None).
    error UnknownQueueId(uint256 queueId);
    /// @notice {executeBridgeOut} called before the tier's delay elapsed -- the NO-BYPASS revert.
    error TooEarly(uint256 queueId, uint256 nowTs, uint256 executableAt);
    /// @notice The request is not Pending (already executed or cancelled) -- the absorbing-state guard.
    error NotPending(uint256 queueId, Status status);

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    /// @param initialOwner       The guard admin (reverts on the zero addr).
    /// @param initialAgent       The agent the outbound queue is authorized for (reverts on the zero addr).
    /// @param mandateRegistry    The mandate the queue gates against (reverts on the zero addr).
    /// @param threshold          The big-value boundary, MINOR units (`<=` small, `>` big).
    /// @param shortDelay         The small-tier delay, seconds.
    /// @param longDelay          The big-tier (24h-style) delay, seconds. MUST be `>= shortDelay` so the
    ///                           big tier never holds for LESS time than the small tier.
    constructor(
        address initialOwner,
        address initialAgent,
        IMandateGate mandateRegistry,
        uint256 threshold,
        uint256 shortDelay,
        uint256 longDelay
    ) {
        if (
            initialOwner == address(0) || initialAgent == address(0)
                || address(mandateRegistry) == address(0)
        ) {
            revert ZeroAddress();
        }
        // The big tier must never be FASTER than the small tier (it is the stronger lock).
        if (longDelay < shortDelay) revert BadTierConfig();

        owner = initialOwner;
        agent = initialAgent;
        mandate = mandateRegistry;
        bigValueThreshold = threshold;
        shortDelaySeconds = shortDelay;
        longDelaySeconds = longDelay;
        nextQueueId = 1; // ids start at 1 so 0 is always the None sentinel.

        emit OwnershipTransferred(address(0), initialOwner);
        emit AgentSet(address(0), initialAgent);
        emit MandateSet(address(0), address(mandateRegistry));
        emit TiersSet(threshold, shortDelay, longDelay);
    }

    // ============================================================================================
    // The value-tier schedule -- a PURE function (deterministic, design SS3 principle 4).
    // ============================================================================================

    /// @notice The delay (seconds) for an outbound `amount`: {shortDelaySeconds} when `amount <=`
    ///         {bigValueThreshold} (the SMALL tier), else {longDelaySeconds} (the BIG, 24h-style tier).
    ///         A pure read so the schedule is independently checkable off-chain (the verifier re-derives
    ///         it) and the tier boundary is exact-integer.
    /// @dev    The boundary is INCLUSIVE at the threshold: `amount == bigValueThreshold` is still SMALL
    ///         (short delay); strictly above is BIG (long lock).
    function delayFor(uint256 amount) public view returns (uint256) {
        return amount > bigValueThreshold ? longDelaySeconds : shortDelaySeconds;
    }

    /// @notice `true` iff `amount` is in the BIG-value tier (`> bigValueThreshold`) -- the long-lock tier.
    function isBigValue(uint256 amount) external view returns (bool) {
        return amount > bigValueThreshold;
    }

    // ============================================================================================
    // STEP 1 -- queue. Gates the mandate, derives the tier delay, records the request. FAIL-CLOSED.
    // ============================================================================================

    /// @notice Queue an outbound bridge-out, gated by the mandate and scheduled by its value tier.
    ///         Step 1 of the two-step time-lock. The mandate {checkTransferTo} gate runs HERE (the SAME
    ///         four-tier fail-closed precondition that bounds an on-hub spend, with `spender` pinned to
    ///         the per-spoke destination sentinel for the selector) -- a refused gate REVERTS, so a queue
    ///         id only ever exists for a mandate-cleared egress.
    ///
    /// @param  token        The bridged lane asset, MINOR units (e.g. USDC.E / w0G).
    /// @param  amount       The amount to bridge out, MINOR units (exact-integer; reverts on zero).
    /// @param  destSelector The CCIP destination-chain selector (the pinned spoke).
    /// @param  recipient    The destination-chain recipient (reverts on the zero addr).
    /// @return queueId      The fresh queue id (>= 1) the request is recorded under.
    function queueBridgeOut(address token, uint256 amount, uint64 destSelector, address recipient)
        external
        returns (uint256 queueId)
    {
        // Only the authorized agent (or the owner) may queue an egress -- mirrors the registry's
        // agent-gated spend so a stranger can never seed the outbound queue.
        if (msg.sender != agent && msg.sender != owner) revert NotAuthorized();
        if (token == address(0) || recipient == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();

        // (1) The mandate gate -- the kill-switch, BEFORE a queue id exists. `spender` is the per-spoke
        //     destination sentinel for this selector, so the registry's per-destination (Tier 4) cap +
        //     spender allowlist bound this exact spoke. A refused gate reverts (fail-closed): nothing
        //     is recorded, no authorization is fabricated (design SS3 principle 3).
        address spoke = spokeSpender(destSelector);
        (bool ok, bytes32 reason) = mandate.checkTransferTo(agent, token, amount, spoke);
        if (!ok) revert MandateRefused(reason);

        // (2) The value-tiered schedule (pure, deterministic): small -> short delay, big -> long lock.
        uint256 delaySeconds = delayFor(amount);
        // forge-lint: disable-next-line(block-timestamp)
        uint256 queuedAt = block.timestamp;
        uint256 executableAt = queuedAt + delaySeconds;

        // (3) Record the request under a fresh id (ids start at 1; 0 stays the None sentinel).
        queueId = nextQueueId;
        nextQueueId = queueId + 1;
        requests[queueId] = Request({
            status: Status.Pending,
            agent: agent,
            token: token,
            destSelector: destSelector,
            recipient: recipient,
            amount: amount,
            delaySeconds: delaySeconds,
            queuedAt: queuedAt,
            executableAt: executableAt
        });

        emit BridgeOutQueued(
            queueId, token, destSelector, recipient, amount, delaySeconds, queuedAt, executableAt
        );
    }

    // ============================================================================================
    // STEP 2 -- execute. NO BYPASS: reverts unless the delay elapsed. Absorbing success.
    // ============================================================================================

    /// @notice Execute a queued bridge-out -- ONLY after its value tier's delay elapsed. Step 2 of the
    ///         two-step time-lock. REVERTS with {TooEarly} when `block.timestamp < executableAt` (the
    ///         no-bypass guarantee the verifier confirms), and with {NotPending} if it already executed
    ///         or was cancelled. On success it marks the request {Status.Executed} (absorbing) and emits
    ///         {BridgeOutExecuted} -- the on-chain record that the delay was honored.
    /// @dev    The guard authorizes the egress; it does not itself `ccipSend`. The actual burn is the
    ///         agent/operator step that follows a cleared execute -- so this contract never custodies or
    ///         strands value. Callable by the agent or the owner (the authorized egress actors).
    function executeBridgeOut(uint256 queueId) external {
        if (msg.sender != agent && msg.sender != owner) revert NotAuthorized();
        Request storage r = requests[queueId];
        if (r.status == Status.None) revert UnknownQueueId(queueId);
        if (r.status != Status.Pending) revert NotPending(queueId, r.status);

        // NO BYPASS (design "no bypass; a too-early execute reverts"): the delay is a hard precondition.
        // forge-lint: disable-next-line(block-timestamp)
        uint256 nowTs = block.timestamp;
        if (nowTs < r.executableAt) revert TooEarly(queueId, nowTs, r.executableAt);

        r.status = Status.Executed; // absorbing success -- a request executes at most once.
        emit BridgeOutExecuted(queueId, nowTs, r.executableAt);
    }

    // ============================================================================================
    // ABORT -- cancel a still-pending request in-window. Absorbing abort. The human-in-the-loop window.
    // ============================================================================================

    /// @notice Cancel a still-PENDING bridge-out before it executes -- the owner's (or the original
    ///         queuer's) in-window abort. REVERTS with {NotPending} if it already executed (you cannot
    ///         un-burn) or was already cancelled. Marks {Status.Cancelled} (absorbing) and emits
    ///         {BridgeOutCancelled}. This is the window the asymmetric outbound lock buys: a mistaken or
    ///         hijacked large egress can be stopped BEFORE any value burns on the hub.
    /// @dev    Cancellable by the {owner} or the original {agent} queuer (the egress authorizers); a
    ///         stranger is {NotAuthorized}. A cancel can happen any time while Pending -- before OR after
    ///         the delay elapses (the owner may abort right up until execute is actually called).
    function cancelBridgeOut(uint256 queueId) external {
        if (msg.sender != agent && msg.sender != owner) revert NotAuthorized();
        Request storage r = requests[queueId];
        if (r.status == Status.None) revert UnknownQueueId(queueId);
        if (r.status != Status.Pending) revert NotPending(queueId, r.status);

        r.status = Status.Cancelled; // absorbing abort -- once cancelled, never executable.
        // forge-lint: disable-next-line(block-timestamp)
        emit BridgeOutCancelled(queueId, block.timestamp);
    }

    // ============================================================================================
    // Views -- read helpers for the agent / web UI / verifier.
    // ============================================================================================

    /// @notice The per-spoke destination "sentinel" address for a CCIP `destSelector`. A deterministic,
    ///         collision-free address derived from the selector, used as the mandate gate's `spender` so
    ///         the registry's per-destination (Tier 4) sandbox cap + spender allowlist can bound EACH
    ///         spoke independently (the per-spoke isolated caps, design "2b.3"). Pure -> the verifier
    ///         re-derives the exact spender the gate was probed with.
    /// @dev    `address(uint160(uint256(keccak256(selector))))` -- a stable mapping selector -> address
    ///         with no registry/configuration; two different selectors yield two different sentinels, so
    ///         per-spoke caps never collide.
    function spokeSpender(uint64 destSelector) public pure returns (address) {
        return address(uint160(uint256(keccak256(abi.encodePacked("proofagent:spoke:", destSelector)))));
    }

    // ============================================================================================
    // PER-SPOKE ISOLATED CAPS (design "2b.3") -- read-throughs that surface a spoke's OWN cap. The caps
    // themselves live on the mandate registry (its per-destination Tier-4 `destCap`, reused), keyed by
    // the per-spoke sentinel, so a weak-spoke exploit is bounded to THAT spoke's cap -- never the hub and
    // never another spoke. These views just expose the per-spoke ceiling the queue gate already enforces.
    // ============================================================================================

    /// @notice The ISOLATED per-spoke cap for `destSelector`, MINOR units -- the registry's
    ///         per-destination (Tier-4) `destCap` keyed by this spoke's sentinel. `0` == unset (the
    ///         spoke inherits the registry's global/asset caps; no extra per-spoke tightening). A weak
    ///         spoke's exploit is capped HERE, independently of every other spoke + the hub.
    /// @dev    Reads through to the wired mandate; the cap is configured ON the registry
    ///         (`setDestCap(spokeSpender(destSelector), cap)`), since the registry owns its own caps.
    function spokeCap(uint64 destSelector) external view returns (uint256) {
        return mandate.destCap(spokeSpender(destSelector));
    }

    /// @notice The EFFECTIVE per-tx ceiling for bridging `token` out over `destSelector` -- the
    ///         registry's `effectiveCap(token, spokeSpender(destSelector))` = `min(perTxCap,
    ///         assetCap[token], spokeCap(destSelector))`, or `0` if `token` is not allowlisted. The real
    ///         ceiling a queued egress to this spoke must clear (period/USD tiers are dynamic + not folded
    ///         into this static min).
    function spokeEffectiveCap(address token, uint64 destSelector) external view returns (uint256) {
        return mandate.effectiveCap(token, spokeSpender(destSelector));
    }

    /// @notice The lifecycle status of `queueId` (None for an unknown id).
    function statusOf(uint256 queueId) external view returns (Status) {
        return requests[queueId].status;
    }

    /// @notice `true` iff `queueId` is Pending AND its delay has elapsed (so {executeBridgeOut} would
    ///         clear it now). A convenience read; {executeBridgeOut} is authoritative.
    function isExecutable(uint256 queueId) external view returns (bool) {
        Request storage r = requests[queueId];
        // forge-lint: disable-next-line(block-timestamp)
        return r.status == Status.Pending && block.timestamp >= r.executableAt;
    }

    /// @notice Seconds remaining until `queueId` becomes executable, or `0` if already executable / not
    ///         Pending. A convenience read for the UI countdown.
    function timeRemaining(uint256 queueId) external view returns (uint256) {
        Request storage r = requests[queueId];
        if (r.status != Status.Pending) return 0;
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp >= r.executableAt) return 0;
        // forge-lint: disable-next-line(block-timestamp)
        return r.executableAt - block.timestamp;
    }

    // ============================================================================================
    // Admin surface -- owner-gated mutators. Re-tune the tiers / re-wire / re-key. Revert on misuse.
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

    function setMandate(IMandateGate newMandate) external onlyOwner {
        if (address(newMandate) == address(0)) revert ZeroAddress();
        emit MandateSet(address(mandate), address(newMandate));
        mandate = newMandate;
    }

    /// @notice Re-tune the value tiers. `longDelay` MUST be `>= shortDelay` (the big tier is never the
    ///         faster one). Affects only requests queued AFTER this call (existing requests keep the
    ///         delay they were recorded with -- a queued schedule is immutable, design SS3 principle 4).
    function setTiers(uint256 threshold, uint256 shortDelay, uint256 longDelay) external onlyOwner {
        if (longDelay < shortDelay) revert BadTierConfig();
        bigValueThreshold = threshold;
        shortDelaySeconds = shortDelay;
        longDelaySeconds = longDelay;
        emit TiersSet(threshold, shortDelay, longDelay);
    }
}
