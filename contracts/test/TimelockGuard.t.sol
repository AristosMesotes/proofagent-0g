// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.26;

import {TimelockGuard, IMandateGate} from "../src/TimelockGuard.sol";

/// @dev Minimal inline cheatcode interface -- the repo vendors NO forge-std (clean-room /
///      offline-by-default, design SS6). We declare only the cheatcodes used: `warp` (drive
///      `block.timestamp` across the value-tier delays) and `prank` (call as the agent / owner /
///      a stranger to exercise the authorization gates).
interface IVm {
    function warp(uint256 newTimestamp) external;
    function prank(address sender) external;
}

/// @dev A mock mandate gate for the time-lock tests: returns a settable `(ok, reason)` so a test can
///      drive both the cleared-queue path and the fail-closed MandateRefused path WITHOUT deploying the
///      full {MandateRegistryV3}. It records the LAST `(agent, token, amount, spender)` it was probed
///      with so a test can assert the per-spoke `spender` sentinel was passed.
contract MockMandateGate is IMandateGate {
    bool public okFlag = true;
    bytes32 public reasonTag = bytes32(0);

    address public lastAgent;
    address public lastToken;
    uint256 public lastAmount;
    address public lastSpender;

    function set(bool ok_, bytes32 reason_) external {
        okFlag = ok_;
        reasonTag = reason_;
    }

    // Per-spoke (Tier-4 destCap) read-throughs (design "2b.3"): a settable per-spender cap so a test can
    // assert the guard's spokeCap/spokeEffectiveCap views read through correctly.
    mapping(address => uint256) public destCapOf;
    uint256 public effectiveCapValue;

    function setDestCap(address spender, uint256 cap) external {
        destCapOf[spender] = cap;
    }

    function setEffectiveCap(uint256 cap) external {
        effectiveCapValue = cap;
    }

    function checkTransferTo(address agent_, address token, uint256 amount, address spender)
        external
        override
        returns (bool ok, bytes32 reason)
    {
        // Records the probe args so a test can assert the per-spoke `spender` sentinel was passed. The
        // {IMandateGate} method is non-view (the widest mutability), so this recording double satisfies
        // it; the real {MandateRegistryV3.checkTransferTo} is a view and satisfies it identically.
        lastAgent = agent_;
        lastToken = token;
        lastAmount = amount;
        lastSpender = spender;
        return (okFlag, reasonTag);
    }

    function destCap(address spender) external view override returns (uint256) {
        return destCapOf[spender];
    }

    function effectiveCap(address, address) external view override returns (uint256) {
        return effectiveCapValue;
    }
}

/// @title TimelockGuardTest -- dependency-free Foundry tests for the value-tiered outbound time-lock.
/// @notice Covers the FULL two-step lifecycle + every safety invariant of design "2b.2": the mandate
///         gate runs at queue (and a refused gate reverts the queue), the value tiers (small -> short
///         delay, big -> long 24h-style lock), the NO-BYPASS too-early execute revert, the
///         execute-after-delay success, the in-window cancel, the absorbing terminal states, and the
///         authorization gates. No forge-std: assertions are plain `require`. Each `testXxx` is
///         auto-discovered.
contract TimelockGuardTest {
    IVm internal constant VM = IVm(address(uint160(uint256(keccak256("hevm cheat code")))));

    TimelockGuard internal guard;
    MockMandateGate internal mandate;

    // Fixed actors / tokens (deterministic; design SS3 principle 4).
    address internal constant OWNER = address(0xA11CE);
    address internal constant AGENT = address(0xA6E47);
    address internal constant STRANGER = address(0xBEEF);
    address internal constant TOKEN = address(0x1111111111111111111111111111111111111111);
    address internal constant RECIPIENT = address(0x2222222222222222222222222222222222222222);

    // Public 0G CCIP destination selectors (design WOW Feature 3b) -- the spokes.
    uint64 internal constant SEL_ETHEREUM = 5_009_297_550_715_157_269;
    uint64 internal constant SEL_ARBITRUM = 4_949_039_107_694_359_620;
    uint64 internal constant SEL_BNB = 11_344_663_589_394_136_015;

    // Value tiers, MINOR units / seconds.
    uint256 internal constant THRESHOLD = 1_000_000; // <= 1.0M is small; > 1.0M is big
    uint256 internal constant SHORT_DELAY = 1 hours; // small-tier delay
    uint256 internal constant LONG_DELAY = 1 days; // big-tier 24h-style lock

    uint256 internal constant SMALL_AMOUNT = 500_000; // small tier
    uint256 internal constant BIG_AMOUNT = 5_000_000; // big tier

    uint256 internal constant T0 = 2_000_000;

    function setUp() public {
        VM.warp(T0);
        mandate = new MockMandateGate();
        guard = new TimelockGuard(OWNER, AGENT, IMandateGate(address(mandate)), THRESHOLD, SHORT_DELAY, LONG_DELAY);
    }

    function _assertTrue(bool cond, string memory why) internal pure {
        require(cond, why);
    }

    function _expectRevert(address target, bytes memory call, bytes4 expectedSelector, string memory why)
        internal
    {
        (bool ok, bytes memory data) = target.call(call);
        _assertTrue(!ok, why);
        bytes4 got;
        assembly {
            got := mload(add(data, 0x20))
        }
        _assertTrue(got == expectedSelector, why);
    }

    // --- construction / config -------------------------------------------------------------------

    function test_Constructor_SetsOwnerAgentMandateAndTiers() public view {
        _assertTrue(guard.owner() == OWNER, "owner set");
        _assertTrue(guard.agent() == AGENT, "agent set");
        _assertTrue(address(guard.mandate()) == address(mandate), "mandate wired");
        _assertTrue(guard.bigValueThreshold() == THRESHOLD, "threshold set");
        _assertTrue(guard.shortDelaySeconds() == SHORT_DELAY, "short delay set");
        _assertTrue(guard.longDelaySeconds() == LONG_DELAY, "long delay set");
        _assertTrue(guard.nextQueueId() == 1, "queue ids start at 1");
    }

    function test_Constructor_RevertsWhenLongDelayShorterThanShort() public {
        // The big tier must never be FASTER than the small tier -- the constructor enforces it.
        bool reverted = false;
        try this.deployBadTiers() {
            reverted = false;
        } catch {
            reverted = true;
        }
        _assertTrue(reverted, "constructor must revert when longDelay < shortDelay");
    }

    /// @dev External helper so the bad-tier construction can be caught by a try/catch.
    function deployBadTiers() external returns (TimelockGuard) {
        return new TimelockGuard(
            OWNER, AGENT, IMandateGate(address(mandate)), THRESHOLD, LONG_DELAY, SHORT_DELAY
        );
    }

    // --- the value-tier schedule (pure) ----------------------------------------------------------

    function test_DelayFor_SmallTierIsShortDelay() public view {
        _assertTrue(guard.delayFor(SMALL_AMOUNT) == SHORT_DELAY, "small amount -> short delay");
        // boundary is INCLUSIVE: amount == threshold is still small.
        _assertTrue(guard.delayFor(THRESHOLD) == SHORT_DELAY, "amount == threshold is still small");
        _assertTrue(!guard.isBigValue(THRESHOLD), "threshold itself is not big");
    }

    function test_DelayFor_BigTierIsLongDelay() public view {
        _assertTrue(guard.delayFor(BIG_AMOUNT) == LONG_DELAY, "big amount -> long delay");
        _assertTrue(guard.delayFor(THRESHOLD + 1) == LONG_DELAY, "just over threshold is big");
        _assertTrue(guard.isBigValue(THRESHOLD + 1), "just over threshold is big");
    }

    // --- STEP 1: queue (mandate-gated) -----------------------------------------------------------

    function test_Queue_SmallValue_RecordsShortDelaySchedule() public {
        VM.prank(AGENT);
        uint256 id = guard.queueBridgeOut(TOKEN, SMALL_AMOUNT, SEL_ETHEREUM, RECIPIENT);
        _assertTrue(id == 1, "first queue id is 1");

        (
            TimelockGuard.Status status,
            address agent_,
            address token,
            uint64 destSelector,
            address recipient,
            uint256 amount,
            uint256 delaySeconds,
            uint256 queuedAt,
            uint256 executableAt
        ) = guard.requests(id);
        _assertTrue(status == TimelockGuard.Status.Pending, "queued -> Pending");
        _assertTrue(agent_ == AGENT, "agent recorded");
        _assertTrue(token == TOKEN, "token recorded");
        _assertTrue(destSelector == SEL_ETHEREUM, "selector recorded");
        _assertTrue(recipient == RECIPIENT, "recipient recorded");
        _assertTrue(amount == SMALL_AMOUNT, "amount recorded");
        _assertTrue(delaySeconds == SHORT_DELAY, "small tier -> short delay");
        _assertTrue(queuedAt == T0, "queuedAt is now");
        _assertTrue(executableAt == T0 + SHORT_DELAY, "executableAt = queuedAt + short delay");
        _assertTrue(guard.nextQueueId() == 2, "next id advanced");
    }

    function test_Queue_BigValue_RecordsLongLockSchedule() public {
        VM.prank(AGENT);
        uint256 id = guard.queueBridgeOut(TOKEN, BIG_AMOUNT, SEL_ARBITRUM, RECIPIENT);
        (,,,,, uint256 amount, uint256 delaySeconds,, uint256 executableAt) = guard.requests(id);
        _assertTrue(amount == BIG_AMOUNT, "big amount recorded");
        _assertTrue(delaySeconds == LONG_DELAY, "big tier -> long 24h-style lock");
        _assertTrue(executableAt == T0 + LONG_DELAY, "executableAt = queuedAt + long delay");
    }

    function test_Queue_ProbesMandateWithPerSpokeSpenderSentinel() public {
        VM.prank(AGENT);
        guard.queueBridgeOut(TOKEN, SMALL_AMOUNT, SEL_BNB, RECIPIENT);
        // The mandate gate must have been probed with the per-spoke sentinel for SEL_BNB (so the
        // registry's per-destination Tier-4 cap + spender allowlist bound THIS spoke).
        address expectedSpoke = guard.spokeSpender(SEL_BNB);
        _assertTrue(mandate.lastSpender() == expectedSpoke, "mandate probed with the per-spoke sentinel");
        _assertTrue(mandate.lastAgent() == AGENT, "mandate probed for the agent");
        _assertTrue(mandate.lastToken() == TOKEN, "mandate probed for the token");
        _assertTrue(mandate.lastAmount() == SMALL_AMOUNT, "mandate probed for the amount");
        // distinct selectors -> distinct sentinels (per-spoke isolation never collides).
        _assertTrue(
            guard.spokeSpender(SEL_BNB) != guard.spokeSpender(SEL_ARBITRUM),
            "distinct spokes get distinct sentinels"
        );
    }

    function test_Queue_RevertsWhenMandateRefuses() public {
        // A refused mandate gate REVERTS the queue (fail-closed) -- nothing is recorded.
        mandate.set(false, "OVER_PERIOD_CAP");
        bytes memory call =
            abi.encodeWithSelector(TimelockGuard.queueBridgeOut.selector, TOKEN, SMALL_AMOUNT, SEL_ETHEREUM, RECIPIENT);
        VM.prank(AGENT);
        _expectRevert(address(guard), call, TimelockGuard.MandateRefused.selector, "refused mandate must revert queue");
        // no request was recorded.
        _assertTrue(guard.statusOf(1) == TimelockGuard.Status.None, "no request recorded on refusal");
        _assertTrue(guard.nextQueueId() == 1, "id counter not advanced on refusal");
    }

    function test_Queue_RevertsForStranger() public {
        bytes memory call =
            abi.encodeWithSelector(TimelockGuard.queueBridgeOut.selector, TOKEN, SMALL_AMOUNT, SEL_ETHEREUM, RECIPIENT);
        VM.prank(STRANGER);
        _expectRevert(address(guard), call, TimelockGuard.NotAuthorized.selector, "stranger cannot queue");
    }

    function test_Queue_RevertsOnZeroAmount() public {
        bytes memory call =
            abi.encodeWithSelector(TimelockGuard.queueBridgeOut.selector, TOKEN, uint256(0), SEL_ETHEREUM, RECIPIENT);
        VM.prank(AGENT);
        _expectRevert(address(guard), call, TimelockGuard.ZeroAmount.selector, "zero amount cannot queue");
    }

    function test_Queue_RevertsOnZeroRecipient() public {
        bytes memory call =
            abi.encodeWithSelector(TimelockGuard.queueBridgeOut.selector, TOKEN, SMALL_AMOUNT, SEL_ETHEREUM, address(0));
        VM.prank(AGENT);
        _expectRevert(address(guard), call, TimelockGuard.ZeroAddress.selector, "zero recipient cannot queue");
    }

    function test_Queue_OwnerMayAlsoQueue() public {
        VM.prank(OWNER);
        uint256 id = guard.queueBridgeOut(TOKEN, SMALL_AMOUNT, SEL_ETHEREUM, RECIPIENT);
        _assertTrue(guard.statusOf(id) == TimelockGuard.Status.Pending, "owner may queue too");
    }

    // --- STEP 2: execute (NO BYPASS) -------------------------------------------------------------

    function test_Execute_RevertsBeforeShortDelay_TheNoBypassGuard() public {
        VM.prank(AGENT);
        uint256 id = guard.queueBridgeOut(TOKEN, SMALL_AMOUNT, SEL_ETHEREUM, RECIPIENT);
        // One second before the delay elapses -> TooEarly (no bypass).
        VM.warp(T0 + SHORT_DELAY - 1);
        bytes memory call = abi.encodeWithSelector(TimelockGuard.executeBridgeOut.selector, id);
        VM.prank(AGENT);
        _expectRevert(address(guard), call, TimelockGuard.TooEarly.selector, "execute before delay must revert");
        _assertTrue(guard.statusOf(id) == TimelockGuard.Status.Pending, "still pending after too-early");
    }

    function test_Execute_SucceedsExactlyAtShortDelayBoundary() public {
        VM.prank(AGENT);
        uint256 id = guard.queueBridgeOut(TOKEN, SMALL_AMOUNT, SEL_ETHEREUM, RECIPIENT);
        // The boundary is inclusive: at exactly executableAt it clears.
        VM.warp(T0 + SHORT_DELAY);
        _assertTrue(guard.isExecutable(id), "executable at the boundary");
        VM.prank(AGENT);
        guard.executeBridgeOut(id);
        _assertTrue(guard.statusOf(id) == TimelockGuard.Status.Executed, "executed after short delay");
    }

    function test_Execute_BigValue_RequiresTheFullLongLock() public {
        VM.prank(AGENT);
        uint256 id = guard.queueBridgeOut(TOKEN, BIG_AMOUNT, SEL_ARBITRUM, RECIPIENT);
        // The short delay is NOT enough for a big-value transfer -- it needs the full 24h-style lock.
        VM.warp(T0 + SHORT_DELAY);
        bytes memory call = abi.encodeWithSelector(TimelockGuard.executeBridgeOut.selector, id);
        VM.prank(AGENT);
        _expectRevert(address(guard), call, TimelockGuard.TooEarly.selector, "big value needs the long lock");
        // After the full long lock it clears.
        VM.warp(T0 + LONG_DELAY);
        VM.prank(AGENT);
        guard.executeBridgeOut(id);
        _assertTrue(guard.statusOf(id) == TimelockGuard.Status.Executed, "big value executes after long lock");
    }

    function test_Execute_RevertsOnUnknownQueueId() public {
        bytes memory call = abi.encodeWithSelector(TimelockGuard.executeBridgeOut.selector, uint256(999));
        VM.prank(AGENT);
        _expectRevert(address(guard), call, TimelockGuard.UnknownQueueId.selector, "unknown id cannot execute");
    }

    function test_Execute_CannotExecuteTwice_AbsorbingSuccess() public {
        VM.prank(AGENT);
        uint256 id = guard.queueBridgeOut(TOKEN, SMALL_AMOUNT, SEL_ETHEREUM, RECIPIENT);
        VM.warp(T0 + SHORT_DELAY);
        VM.prank(AGENT);
        guard.executeBridgeOut(id);
        // A second execute is NotPending (absorbing) -- no double-spend of the authorization.
        bytes memory call = abi.encodeWithSelector(TimelockGuard.executeBridgeOut.selector, id);
        VM.prank(AGENT);
        _expectRevert(address(guard), call, TimelockGuard.NotPending.selector, "cannot execute twice");
    }

    function test_Execute_RevertsForStranger() public {
        VM.prank(AGENT);
        uint256 id = guard.queueBridgeOut(TOKEN, SMALL_AMOUNT, SEL_ETHEREUM, RECIPIENT);
        VM.warp(T0 + SHORT_DELAY);
        bytes memory call = abi.encodeWithSelector(TimelockGuard.executeBridgeOut.selector, id);
        VM.prank(STRANGER);
        _expectRevert(address(guard), call, TimelockGuard.NotAuthorized.selector, "stranger cannot execute");
    }

    // --- ABORT: cancel (in-window) ---------------------------------------------------------------

    function test_Cancel_OwnerAbortsPendingInWindow() public {
        VM.prank(AGENT);
        uint256 id = guard.queueBridgeOut(TOKEN, BIG_AMOUNT, SEL_ARBITRUM, RECIPIENT);
        // The owner cancels the large egress before it can execute -- no value ever burns.
        VM.warp(T0 + SHORT_DELAY); // still inside the long lock
        VM.prank(OWNER);
        guard.cancelBridgeOut(id);
        _assertTrue(guard.statusOf(id) == TimelockGuard.Status.Cancelled, "owner cancelled in-window");
    }

    function test_Cancel_AgentQueuerMayAlsoCancel() public {
        VM.prank(AGENT);
        uint256 id = guard.queueBridgeOut(TOKEN, SMALL_AMOUNT, SEL_ETHEREUM, RECIPIENT);
        VM.prank(AGENT);
        guard.cancelBridgeOut(id);
        _assertTrue(guard.statusOf(id) == TimelockGuard.Status.Cancelled, "agent queuer may cancel");
    }

    function test_Cancel_BlocksASubsequentExecute() public {
        VM.prank(AGENT);
        uint256 id = guard.queueBridgeOut(TOKEN, SMALL_AMOUNT, SEL_ETHEREUM, RECIPIENT);
        VM.prank(OWNER);
        guard.cancelBridgeOut(id);
        // Even after the delay elapses, a cancelled request can NEVER execute (absorbing abort).
        VM.warp(T0 + SHORT_DELAY);
        bytes memory call = abi.encodeWithSelector(TimelockGuard.executeBridgeOut.selector, id);
        VM.prank(AGENT);
        _expectRevert(address(guard), call, TimelockGuard.NotPending.selector, "cancelled cannot execute");
    }

    function test_Cancel_CannotCancelAnExecutedRequest() public {
        VM.prank(AGENT);
        uint256 id = guard.queueBridgeOut(TOKEN, SMALL_AMOUNT, SEL_ETHEREUM, RECIPIENT);
        VM.warp(T0 + SHORT_DELAY);
        VM.prank(AGENT);
        guard.executeBridgeOut(id);
        // You cannot un-burn: cancelling an executed request is NotPending.
        bytes memory call = abi.encodeWithSelector(TimelockGuard.cancelBridgeOut.selector, id);
        VM.prank(OWNER);
        _expectRevert(address(guard), call, TimelockGuard.NotPending.selector, "cannot cancel an executed request");
    }

    function test_Cancel_RevertsForStranger() public {
        VM.prank(AGENT);
        uint256 id = guard.queueBridgeOut(TOKEN, SMALL_AMOUNT, SEL_ETHEREUM, RECIPIENT);
        bytes memory call = abi.encodeWithSelector(TimelockGuard.cancelBridgeOut.selector, id);
        VM.prank(STRANGER);
        _expectRevert(address(guard), call, TimelockGuard.NotAuthorized.selector, "stranger cannot cancel");
    }

    function test_Cancel_RevertsOnUnknownQueueId() public {
        bytes memory call = abi.encodeWithSelector(TimelockGuard.cancelBridgeOut.selector, uint256(42));
        VM.prank(OWNER);
        _expectRevert(address(guard), call, TimelockGuard.UnknownQueueId.selector, "unknown id cannot cancel");
    }

    // --- views / determinism ---------------------------------------------------------------------

    function test_TimeRemaining_CountsDownThenZero() public {
        VM.prank(AGENT);
        uint256 id = guard.queueBridgeOut(TOKEN, SMALL_AMOUNT, SEL_ETHEREUM, RECIPIENT);
        _assertTrue(guard.timeRemaining(id) == SHORT_DELAY, "full delay remains at queue time");
        VM.warp(T0 + SHORT_DELAY - 10);
        _assertTrue(guard.timeRemaining(id) == 10, "ten seconds remain");
        VM.warp(T0 + SHORT_DELAY);
        _assertTrue(guard.timeRemaining(id) == 0, "zero at/after the boundary");
        _assertTrue(guard.isExecutable(id), "executable at the boundary");
    }

    function test_SetTiers_OnlyAffectsFutureRequests() public {
        // A queued request keeps the delay it was recorded with even if the tiers are re-tuned.
        VM.prank(AGENT);
        uint256 id = guard.queueBridgeOut(TOKEN, SMALL_AMOUNT, SEL_ETHEREUM, RECIPIENT);
        (,,,,,, uint256 recordedDelay,,) = guard.requests(id);
        _assertTrue(recordedDelay == SHORT_DELAY, "recorded with the short delay");
        // Re-tune to make the small tier slower.
        VM.prank(OWNER);
        guard.setTiers(THRESHOLD, 12 hours, LONG_DELAY);
        (,,,,,, uint256 stillRecorded,,) = guard.requests(id);
        _assertTrue(stillRecorded == SHORT_DELAY, "existing request's schedule is immutable");
        // A NEW request picks up the new tier.
        VM.prank(AGENT);
        uint256 id2 = guard.queueBridgeOut(TOKEN, SMALL_AMOUNT, SEL_ETHEREUM, RECIPIENT);
        (,,,,,, uint256 newDelay,,) = guard.requests(id2);
        _assertTrue(newDelay == 12 hours, "new request picks up the re-tuned delay");
    }

    function test_SetTiers_RevertsWhenLongShorterThanShort() public {
        bytes memory call =
            abi.encodeWithSelector(TimelockGuard.setTiers.selector, THRESHOLD, LONG_DELAY, SHORT_DELAY);
        VM.prank(OWNER);
        _expectRevert(address(guard), call, TimelockGuard.BadTierConfig.selector, "long must be >= short");
    }

    // --- per-spoke isolated caps (design "2b.3") -- read-throughs to the mandate destCap -------------

    function test_SpokeCap_ReadsThroughToTheMandateDestCapPerSpoke() public {
        // Set DIFFERENT per-destination caps on the (mock) registry keyed by each spoke's sentinel; the
        // guard's spokeCap must read each spoke's OWN isolated cap, never another's.
        mandate.setDestCap(guard.spokeSpender(SEL_ETHEREUM), 700_000);
        mandate.setDestCap(guard.spokeSpender(SEL_ARBITRUM), 250_000);
        _assertTrue(guard.spokeCap(SEL_ETHEREUM) == 700_000, "ethereum spoke reads its own cap");
        _assertTrue(guard.spokeCap(SEL_ARBITRUM) == 250_000, "arbitrum spoke reads its own cap");
        // An unconfigured spoke reads 0 (unset -> no per-spoke tightening), isolated from the others.
        _assertTrue(guard.spokeCap(SEL_BNB) == 0, "an unconfigured spoke has no per-spoke cap");
    }

    function test_SpokeEffectiveCap_ReadsThroughToTheMandateEffectiveCap() public {
        mandate.setEffectiveCap(123_456);
        _assertTrue(
            guard.spokeEffectiveCap(TOKEN, SEL_ETHEREUM) == 123_456,
            "spokeEffectiveCap reads the registry's effective ceiling for the spoke"
        );
    }
}
