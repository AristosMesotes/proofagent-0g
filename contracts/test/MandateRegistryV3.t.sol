// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {MandateRegistryV3, IPriceFeed} from "../src/MandateRegistryV3.sol";

/// @dev Minimal inline cheatcode interface -- the repo vendors NO forge-std (clean-room /
///      offline-by-default, design SS6), so the tests declare only the cheatcodes they use:
///      `warp` (drive `block.timestamp` for expiry + the period window) and `prank` (call as a
///      specific sender to exercise the owner gate + the agent-only atomic accrue). The address is
///      Foundry's well-known cheatcode address.
interface IVm {
    function warp(uint256 newTimestamp) external;
    function prank(address sender) external;
}

/// @dev A mock price feed for the Tier-3 USD-cap tests. Returns a settable USD-micros-per-whole-token
///      price; `0` models "unavailable" (the registry must fail closed). `REVERTING` makes the feed
///      revert so the registry's try/catch fail-closed path is exercised.
contract MockPriceFeed is IPriceFeed {
    uint256 public price; // USD micros per ONE whole token (1e6 == $1); 0 == unavailable.
    bool public reverting;

    function set(uint256 p) external {
        price = p;
    }

    function setReverting(bool r) external {
        reverting = r;
    }

    function priceUsdMicros(address) external view override returns (uint256) {
        require(!reverting, "feed down");
        return price;
    }
}

/// @title MandateRegistryV3Test -- dependency-free Foundry tests for the four-tier spend gate.
/// @notice Covers EACH tier (period-cap-blocks-looping, expiry, spender-allowlist, sub-caps, pause,
///         USD-cap, bounded-list, atomic gate+accrue) PLUS the fixed reason-code order and the
///         v2-compatible {checkTransfer} shape. No forge-std: assertions are plain `require`, so
///         `forge test` runs offline with zero submodules. Each `testXxx` is auto-discovered.
contract MandateRegistryV3Test {
    IVm internal constant VM = IVm(address(uint160(uint256(keccak256("hevm cheat code")))));

    MandateRegistryV3 internal reg;
    MockPriceFeed internal feed;

    // Fixed actors / tokens (deterministic; design SS3 principle 4).
    address internal constant OWNER = address(0xA11CE);
    address internal constant AGENT = address(0xA6E47);
    address internal constant STRANGER = address(0xBEEF);
    address internal constant TOKEN = address(0x1111111111111111111111111111111111111111);
    address internal constant OTHER_TOKEN = address(0x2222222222222222222222222222222222222222);
    address internal constant ROUTER = address(0x3333333333333333333333333333333333333333);
    address internal constant EVIL_ROUTER = address(0x4444444444444444444444444444444444444444);

    // Caps, MINOR units. Sub-cap < per-tx cap so the per-asset rung is independently exercised.
    uint256 internal constant PER_TX_CAP = 2_000_000; // global per-tx limit
    uint256 internal constant ASSET_CAP = 1_500_000; // token sub-cap (tighter than per-tx)
    uint256 internal constant NEVER = type(uint256).max;

    uint256 internal constant T0 = 1_000_000;
    uint256 internal constant EXPIRY = T0 + 1 days;

    function setUp() public {
        VM.warp(T0);
        reg = new MandateRegistryV3(OWNER, AGENT, PER_TX_CAP, EXPIRY);
        VM.prank(OWNER);
        reg.setAssetCap(TOKEN, ASSET_CAP, true); // allowlist TOKEN, sub-cap 1.5M
        feed = new MockPriceFeed();
    }

    // --- internal assertion helpers (no forge-std) ----------------------------------------------

    function _assertTrue(bool cond, string memory why) internal pure {
        require(cond, why);
    }

    function _assertEqB32(bytes32 a, bytes32 b, string memory why) internal pure {
        require(a == b, why);
    }

    function _assertEqU(uint256 a, uint256 b, string memory why) internal pure {
        require(a == b, why);
    }

    // ============================================================================================
    // v2-COMPATIBLE shape -- the same checkTransfer(agent, token, amount) gate still passes / rejects.
    // ============================================================================================

    function test_V2Compatible_CapPass_WithinAllCaps() public view {
        (bool ok, bytes32 reason) = reg.checkTransfer(AGENT, TOKEN, ASSET_CAP);
        _assertTrue(ok, "within-cap transfer must be ok");
        _assertEqB32(reason, reg.REASON_OK(), "ok reason must be REASON_OK (zero)");
    }

    function test_V2Compatible_OverAssetSubCapReject() public view {
        (bool ok, bytes32 reason) = reg.checkTransfer(AGENT, TOKEN, ASSET_CAP + 1);
        _assertTrue(!ok, "over the per-asset sub-cap must be rejected");
        _assertEqB32(reason, reg.REASON_OVER_ASSET_CAP(), "reason must be OVER_ASSET_CAP");
    }

    function test_V2Compatible_OverGlobalPerTxCapReject() public {
        VM.prank(OWNER);
        reg.setAssetCap(TOKEN, NEVER, true); // sub-cap effectively unlimited -> per-tx is binding
        (bool ok, bytes32 reason) = reg.checkTransfer(AGENT, TOKEN, PER_TX_CAP + 1);
        _assertTrue(!ok, "over the global per-tx cap must be rejected");
        _assertEqB32(reason, reg.REASON_OVER_TX_CAP(), "reason must be OVER_TX_CAP");
    }

    function test_V2Compatible_TokenNotAllowedReject() public view {
        (bool ok, bytes32 reason) = reg.checkTransfer(AGENT, OTHER_TOKEN, 1);
        _assertTrue(!ok, "a non-allowlisted token must be rejected");
        _assertEqB32(reason, reg.REASON_TOKEN_NOT_ALLOWED(), "reason must be TOKEN_NOT_ALLOWED");
    }

    function test_V2Compatible_WrongAgentReject() public view {
        (bool ok, bytes32 reason) = reg.checkTransfer(STRANGER, TOKEN, ASSET_CAP);
        _assertTrue(!ok, "a non-mandated agent must be rejected");
        _assertEqB32(reason, reg.REASON_NOT_AGENT(), "reason must be NOT_AGENT");
    }

    function test_V2Compatible_ZeroAmountReject() public view {
        (bool ok, bytes32 reason) = reg.checkTransfer(AGENT, TOKEN, 0);
        _assertTrue(!ok, "a zero-amount transfer must be rejected");
        _assertEqB32(reason, reg.REASON_ZERO_AMOUNT(), "reason must be ZERO_AMOUNT");
    }

    // ============================================================================================
    // TIER 1 -- cumulative per-PERIOD cap. THE HEADLINE: a LOOPING sequence the per-tx cap would pass
    // is BLOCKED by the window accumulator (looping-drain closed).
    // ============================================================================================

    function test_Tier1_PeriodCapBlocksLoopingSequence() public {
        // Per-tx cap 2M, asset cap 2M; a single 1M spend passes the per-tx gate trivially. But the
        // PERIOD cap is 1.5M per hour: two 1M loops (=2M) would drain past it. The accumulator catches
        // the SECOND loop even though each leg passes the per-tx ceiling -- the looping-drain close.
        VM.prank(OWNER);
        reg.setAssetCap(TOKEN, PER_TX_CAP, true); // asset cap == per-tx so the period tier is the binding one
        VM.prank(OWNER);
        reg.setPeriodConfig(1 hours, 1_500_000); // period cap 1.5M / hour

        // Loop 1: 1M -- within the per-tx cap AND within the fresh window. Atomically accrue it.
        VM.prank(AGENT);
        (bool ok1, bytes32 r1) = reg.gateAndRecord(AGENT, TOKEN, 1_000_000, address(0));
        _assertTrue(ok1, "loop 1 (1M) must pass and accrue");
        _assertEqB32(r1, reg.REASON_OK(), "loop 1 reason OK");
        _assertEqU(reg.accruedInWindow(), 1_000_000, "1M accrued after loop 1");

        // Loop 2: another 1M -- STILL within the per-tx cap (the gate the basic mandate offers), but
        // 1M + 1M = 2M > 1.5M period cap. The accumulator BLOCKS it. THIS is the headline.
        (bool okView, bytes32 rView) = reg.checkTransfer(AGENT, TOKEN, 1_000_000);
        _assertTrue(!okView, "loop 2 must be BLOCKED by the period cap (looping-drain closed)");
        _assertEqB32(rView, reg.REASON_OVER_PERIOD_CAP(), "loop 2 reason must be OVER_PERIOD_CAP");

        // And the atomic accrue likewise fails closed -- nothing extra is accrued.
        VM.prank(AGENT);
        (bool ok2,) = reg.gateAndRecord(AGENT, TOKEN, 1_000_000, address(0));
        _assertTrue(!ok2, "loop 2 atomic accrue must fail closed");
        _assertEqU(reg.accruedInWindow(), 1_000_000, "no extra accrued after the blocked loop 2");
    }

    function test_Tier1_WindowRolloverRestoresHeadroom() public {
        VM.prank(OWNER);
        reg.setAssetCap(TOKEN, PER_TX_CAP, true);
        VM.prank(OWNER);
        reg.setPeriodConfig(1 hours, 1_500_000);

        // Fill the window to 1.5M.
        VM.prank(AGENT);
        reg.gateAndRecord(AGENT, TOKEN, 1_500_000, address(0));
        _assertEqU(reg.periodHeadroom(), 0, "window is full");
        (bool okFull,) = reg.checkTransfer(AGENT, TOKEN, 1);
        _assertTrue(!okFull, "a full window blocks even 1 more minor unit");

        // Advance past the period -> the window rolls -> headroom restored (PURE read sees the roll).
        VM.warp(T0 + 1 hours + 1);
        _assertEqU(reg.accruedInWindow(), 0, "the rolled window starts empty");
        _assertEqU(reg.periodHeadroom(), 1_500_000, "headroom restored after rollover");
        (bool okAfter,) = reg.checkTransfer(AGENT, TOKEN, 1_000_000);
        _assertTrue(okAfter, "a spend in the fresh window passes again");
    }

    function test_Tier1_DisabledWhenPeriodZero() public view {
        // No period config -> the period tier is inert; headroom is unbounded.
        _assertEqU(reg.periodHeadroom(), type(uint256).max, "no period cap -> unbounded headroom");
        _assertEqU(reg.accruedInWindow(), 0, "no period cap -> zero accrued");
    }

    // ============================================================================================
    // TIER 2 -- enforced expiry + spender/router allowlist.
    // ============================================================================================

    function test_Tier2_ExpiryRejectAtInstant() public {
        VM.warp(EXPIRY); // `>=` -> the expiry instant is already expired
        (bool ok, bytes32 reason) = reg.checkTransfer(AGENT, TOKEN, ASSET_CAP);
        _assertTrue(!ok, "a transfer AT the expiry instant must be rejected");
        _assertEqB32(reason, reg.REASON_EXPIRED(), "reason must be EXPIRED");
    }

    function test_Tier2_JustBeforeExpiryPasses() public {
        VM.warp(EXPIRY - 1);
        (bool ok,) = reg.checkTransfer(AGENT, TOKEN, ASSET_CAP);
        _assertTrue(ok, "one second before expiry the mandate is still live");
    }

    function test_Tier2_SpenderAllowlistBlocksUnlistedRouter() public {
        VM.prank(OWNER);
        reg.setSpenderAllowlistEnabled(true);
        VM.prank(OWNER);
        reg.setSpenderAllowed(ROUTER, true); // ROUTER allowed, EVIL_ROUTER not

        // Allowed router passes.
        (bool okGood, bytes32 rGood) = reg.checkTransferTo(AGENT, TOKEN, ASSET_CAP, ROUTER);
        _assertTrue(okGood, "an allowlisted router must pass");
        _assertEqB32(rGood, reg.REASON_OK(), "allowed router reason OK");

        // Un-allowlisted router blocked.
        (bool okEvil, bytes32 rEvil) = reg.checkTransferTo(AGENT, TOKEN, ASSET_CAP, EVIL_ROUTER);
        _assertTrue(!okEvil, "a non-allowlisted router must be blocked");
        _assertEqB32(rEvil, reg.REASON_SPENDER_NOT_ALLOWED(), "reason must be SPENDER_NOT_ALLOWED");
    }

    function test_Tier2_EnabledAllowlistFailsClosedForV2ShapeCall() public {
        // With the spender allowlist ENABLED, a v2-shape checkTransfer (no spender == address(0)) fails
        // closed: address(0) is never allowlisted, so a destination-less call cannot slip through.
        VM.prank(OWNER);
        reg.setSpenderAllowlistEnabled(true);
        (bool ok, bytes32 reason) = reg.checkTransfer(AGENT, TOKEN, ASSET_CAP);
        _assertTrue(!ok, "a v2-shape call under an enabled allowlist must fail closed");
        _assertEqB32(reason, reg.REASON_SPENDER_NOT_ALLOWED(), "reason must be SPENDER_NOT_ALLOWED");
    }

    function test_Tier2_DisabledAllowlistIgnoresSpender() public view {
        // Default (allowlist disabled): any spender passes the spender rung (Tier 2 off).
        (bool ok,) = reg.checkTransferTo(AGENT, TOKEN, ASSET_CAP, EVIL_ROUTER);
        _assertTrue(ok, "with the allowlist disabled, any spender passes");
    }

    // ============================================================================================
    // TIER 3 -- per-asset sub-caps + pause (global + per-agent) + USD cap + bounded lists.
    // ============================================================================================

    function test_Tier3_GlobalPauseRejectsEverything() public {
        VM.prank(OWNER);
        reg.setPaused(true);
        (bool ok, bytes32 reason) = reg.checkTransfer(AGENT, TOKEN, ASSET_CAP);
        _assertTrue(!ok, "a globally-paused mandate must reject a would-be-valid transfer");
        _assertEqB32(reason, reg.REASON_PAUSED(), "reason must be PAUSED");
    }

    function test_Tier3_PerAgentPauseRejects() public {
        VM.prank(OWNER);
        reg.setAgentPaused(AGENT, true);
        (bool ok, bytes32 reason) = reg.checkTransfer(AGENT, TOKEN, ASSET_CAP);
        _assertTrue(!ok, "a paused agent must be blocked");
        _assertEqB32(reason, reg.REASON_AGENT_PAUSED(), "reason must be AGENT_PAUSED");
    }

    function test_Tier3_UsdCapBlocksOverpricedSpend() public {
        // Price TOKEN at $2 per whole token; TOKEN has 6 decimals. A spend of 1_500_000 minor units ==
        // 1.5 whole tokens == $3.00 == 3_000_000 USD micros. A USD cap of $2.00 (2_000_000) blocks it.
        VM.prank(OWNER);
        reg.setTokenDecimals(TOKEN, 6);
        feed.set(2_000_000); // $2.00 per whole token (USD micros)
        VM.prank(OWNER);
        reg.setPriceFeed(IPriceFeed(address(feed)), 2_000_000); // USD cap $2.00

        // 1.5 tokens * $2 = $3.00 > $2.00 cap -> blocked on the USD tier.
        (bool ok, bytes32 reason) = reg.checkTransfer(AGENT, TOKEN, 1_500_000);
        _assertTrue(!ok, "an over-the-USD-cap spend must be blocked");
        _assertEqB32(reason, reg.REASON_OVER_USD_CAP(), "reason must be OVER_USD_CAP");

        // A 1.0-token spend == $2.00 == exactly at the cap -> passes (inclusive).
        (bool okAt,) = reg.checkTransfer(AGENT, TOKEN, 1_000_000);
        _assertTrue(okAt, "a spend exactly at the USD cap passes (inclusive)");
    }

    function test_Tier3_UsdCapFailsClosedWhenPriceUnavailable() public {
        VM.prank(OWNER);
        reg.setTokenDecimals(TOKEN, 6);
        feed.set(0); // unavailable price
        VM.prank(OWNER);
        reg.setPriceFeed(IPriceFeed(address(feed)), 2_000_000);
        (bool ok, bytes32 reason) = reg.checkTransfer(AGENT, TOKEN, 1_000_000);
        _assertTrue(!ok, "an unavailable price must fail closed");
        _assertEqB32(reason, reg.REASON_PRICE_UNAVAILABLE(), "reason must be PRICE_UNAVAILABLE");
    }

    function test_Tier3_UsdCapFailsClosedWhenFeedReverts() public {
        VM.prank(OWNER);
        reg.setTokenDecimals(TOKEN, 6);
        feed.set(2_000_000);
        feed.setReverting(true); // the feed reverts
        VM.prank(OWNER);
        reg.setPriceFeed(IPriceFeed(address(feed)), 2_000_000);
        (bool ok, bytes32 reason) = reg.checkTransfer(AGENT, TOKEN, 1_000_000);
        _assertTrue(!ok, "a reverting feed must fail closed, never revert the view");
        _assertEqB32(reason, reg.REASON_PRICE_UNAVAILABLE(), "reason must be PRICE_UNAVAILABLE");
    }

    function test_Tier3_UsdCapFailsClosedWhenDecimalsUnset() public {
        // A USD cap is set but TOKEN's decimals were never set -> can't convert -> fail closed.
        feed.set(2_000_000);
        VM.prank(OWNER);
        reg.setPriceFeed(IPriceFeed(address(feed)), 2_000_000);
        (bool ok, bytes32 reason) = reg.checkTransfer(AGENT, TOKEN, 1_000_000);
        _assertTrue(!ok, "unset decimals under an active USD cap must fail closed");
        _assertEqB32(reason, reg.REASON_PRICE_UNAVAILABLE(), "reason must be PRICE_UNAVAILABLE");
    }

    function test_Tier3_BoundedTokenListRevertsWhenFull() public {
        // MAX_LIST == 16. TOKEN is already allowlisted (1). Fill to 16, then the 17th reverts ListFull.
        uint256 max = reg.MAX_LIST();
        for (uint256 i = reg.allowedTokenCount(); i < max; i++) {
            VM.prank(OWNER);
            // casting to 'uint160' is safe because 0x10000 + i (i < MAX_LIST == 16) is a tiny literal
            // far below 2^160 -- a distinct, deterministic dummy token address per iteration.
            // forge-lint: disable-next-line(unsafe-typecast)
            reg.setAllowed(address(uint160(0x10000 + i)), true);
        }
        _assertEqU(reg.allowedTokenCount(), max, "list filled to MAX_LIST");
        VM.prank(OWNER);
        (bool success,) = address(reg)
            .call(abi.encodeWithSelector(MandateRegistryV3.setAllowed.selector, address(0x999999), true));
        _assertTrue(!success, "allowlisting a 17th token must revert ListFull (bounded-list guard)");
    }

    function test_Tier3_BoundedSpenderListRevertsWhenFull() public {
        uint256 max = reg.MAX_LIST();
        for (uint256 i = 0; i < max; i++) {
            VM.prank(OWNER);
            // casting to 'uint160' is safe because 0x20000 + i (i < MAX_LIST == 16) is a tiny literal
            // far below 2^160 -- a distinct, deterministic dummy spender address per iteration.
            // forge-lint: disable-next-line(unsafe-typecast)
            reg.setSpenderAllowed(address(uint160(0x20000 + i)), true);
        }
        _assertEqU(reg.spenderCount(), max, "spender list filled to MAX_LIST");
        VM.prank(OWNER);
        (bool success,) = address(reg)
            .call(
                abi.encodeWithSelector(MandateRegistryV3.setSpenderAllowed.selector, address(0x888888), true)
            );
        _assertTrue(!success, "allowlisting a 17th spender must revert ListFull");
    }

    function test_Tier3_DeAllowlistDecrementsCount() public {
        _assertEqU(reg.allowedTokenCount(), 1, "TOKEN counted");
        VM.prank(OWNER);
        reg.setAllowed(TOKEN, false);
        _assertEqU(reg.allowedTokenCount(), 0, "de-allowlisting decrements the count");
    }

    // ============================================================================================
    // TIER 4 -- per-destination sandbox caps + ATOMIC gateAndRecord (TOCTOU close).
    // ============================================================================================

    function test_Tier4_DestCapTightensForLowTrustRouter() public {
        // EVIL_ROUTER gets a sandbox cap of 500k -- tighter than the 1.5M asset cap. A 1M spend passes
        // the asset cap but is blocked by the per-destination cap (low-trust destination tightened).
        VM.prank(OWNER);
        reg.setDestCap(EVIL_ROUTER, 500_000);
        (bool ok, bytes32 reason) = reg.checkTransferTo(AGENT, TOKEN, 1_000_000, EVIL_ROUTER);
        _assertTrue(!ok, "a spend over the destination sandbox cap must be blocked");
        _assertEqB32(reason, reg.REASON_OVER_DEST_CAP(), "reason must be OVER_DEST_CAP");

        // The same amount to a router with NO sandbox cap (ROUTER) passes (only the asset cap binds).
        (bool okOpen,) = reg.checkTransferTo(AGENT, TOKEN, 1_000_000, ROUTER);
        _assertTrue(okOpen, "a router with no sandbox cap is bounded only by the asset cap");

        // And within the sandbox cap, the low-trust router passes.
        (bool okWithin,) = reg.checkTransferTo(AGENT, TOKEN, 500_000, EVIL_ROUTER);
        _assertTrue(okWithin, "within the sandbox cap, the low-trust router passes");
    }

    function test_Tier4_AtomicGateAndAccrueRecordsOnlyOnPass() public {
        VM.prank(OWNER);
        reg.setPeriodConfig(1 hours, 1_500_000);

        // A passing gate+accrue moves the accumulator.
        VM.prank(AGENT);
        (bool ok,) = reg.gateAndRecord(AGENT, TOKEN, 1_000_000, address(0));
        _assertTrue(ok, "a within-cap gateAndRecord passes");
        _assertEqU(reg.accruedInWindow(), 1_000_000, "the spend was accrued atomically");

        // A FAILING gate+accrue (over the per-asset cap) accrues NOTHING (fail-closed, no state change).
        VM.prank(AGENT);
        (bool ok2, bytes32 r2) = reg.gateAndRecord(AGENT, TOKEN, ASSET_CAP + 1, address(0));
        _assertTrue(!ok2, "an over-cap gateAndRecord fails");
        _assertEqB32(r2, reg.REASON_OVER_ASSET_CAP(), "the failing reason is surfaced");
        _assertEqU(reg.accruedInWindow(), 1_000_000, "a failed gate accrues nothing (fail-closed)");
    }

    function test_Tier4_AtomicAccrue_TOCTOU_SecondSpendCannotDoubleSpend() public {
        // The TOCTOU close: with an ATOMIC gate+accrue, two sequential in-cap spends cannot both land
        // when their SUM exceeds the period cap -- the first atomically consumes headroom, so the
        // second sees the updated accumulator and is rejected. (The advisory recordSpend gap was that a
        // gate could pass twice before either accrual landed; here gate AND accrue are one call.)
        VM.prank(OWNER);
        reg.setAssetCap(TOKEN, PER_TX_CAP, true);
        VM.prank(OWNER);
        reg.setPeriodConfig(1 hours, 1_500_000); // period cap 1.5M

        VM.prank(AGENT);
        (bool ok1,) = reg.gateAndRecord(AGENT, TOKEN, 1_000_000, address(0)); // consumes 1M atomically
        _assertTrue(ok1, "first atomic spend lands");

        VM.prank(AGENT);
        (bool ok2, bytes32 r2) = reg.gateAndRecord(AGENT, TOKEN, 1_000_000, address(0)); // 2M > 1.5M
        _assertTrue(!ok2, "the second spend cannot double-spend the period cap");
        _assertEqB32(r2, reg.REASON_OVER_PERIOD_CAP(), "the second spend is OVER_PERIOD_CAP");
        _assertEqU(reg.accruedInWindow(), 1_000_000, "only the first spend was accrued");
    }

    function test_Tier1_AdvisoryRecordSpendAccruesButRevertsOverCap() public {
        // The advisory recordSpend (the legacy, NON-atomic accrue) records into the window but still
        // cannot over-accrue: a record that would exceed the period cap reverts.
        VM.prank(OWNER);
        reg.setPeriodConfig(1 hours, 1_500_000);

        VM.prank(AGENT);
        reg.recordSpend(TOKEN, 1_000_000, address(0));
        _assertEqU(reg.accruedInWindow(), 1_000_000, "advisory recordSpend accrues into the window");

        // A second advisory record that would push the window over the cap reverts (1M + 600k > 1.5M).
        VM.prank(AGENT);
        (bool success,) = address(reg)
            .call(
                abi.encodeWithSelector(
                    MandateRegistryV3.recordSpend.selector, TOKEN, uint256(600_000), address(0)
                )
            );
        _assertTrue(
            !success, "an over-cap advisory record must revert (even the advisory path can't over-accrue)"
        );

        // A stranger cannot record either.
        VM.prank(STRANGER);
        (bool strangerOk,) = address(reg)
            .call(
                abi.encodeWithSelector(MandateRegistryV3.recordSpend.selector, TOKEN, uint256(1), address(0))
            );
        _assertTrue(!strangerOk, "a stranger cannot advisory-record a spend");
    }

    function test_Tier4_AtomicAccrue_OnlyAgentOrOwner() public {
        VM.prank(OWNER);
        reg.setPeriodConfig(1 hours, 1_500_000);
        // A stranger cannot move the accumulator -- fail-closed NOT_AGENT, never a revert.
        VM.prank(STRANGER);
        (bool ok, bytes32 reason) = reg.gateAndRecord(AGENT, TOKEN, 1_000_000, address(0));
        _assertTrue(!ok, "a stranger cannot accrue");
        _assertEqB32(reason, reg.REASON_NOT_AGENT(), "a stranger caller is fail-closed NOT_AGENT");
        _assertEqU(reg.accruedInWindow(), 0, "nothing accrued by a stranger");
    }

    function test_Tier4_AtomicAccrue_RollsWindowAcrossPeriods() public {
        VM.prank(OWNER);
        reg.setAssetCap(TOKEN, PER_TX_CAP, true);
        VM.prank(OWNER);
        reg.setPeriodConfig(1 hours, 1_500_000);

        VM.prank(AGENT);
        reg.gateAndRecord(AGENT, TOKEN, 1_500_000, address(0)); // fill the window
        _assertEqU(reg.accruedInWindow(), 1_500_000, "window full");

        // Next period: the atomic accrue must ROLL the window before accruing, restoring full headroom.
        VM.warp(T0 + 1 hours + 5);
        VM.prank(AGENT);
        (bool ok,) = reg.gateAndRecord(AGENT, TOKEN, 1_000_000, address(0));
        _assertTrue(ok, "a fresh window admits a new spend");
        _assertEqU(reg.accruedInWindow(), 1_000_000, "the rolled window accrues from zero");
    }

    // ============================================================================================
    // THE FIXED REASON-CODE ORDER -- the documented precedence. Each pair sets up TWO failing
    // conditions and asserts the HIGHER-precedence one wins, deterministically.
    // ============================================================================================

    function test_ReasonOrder_PausedOutranksAgentPaused() public {
        VM.prank(OWNER);
        reg.setPaused(true);
        VM.prank(OWNER);
        reg.setAgentPaused(AGENT, true);
        (, bytes32 reason) = reg.checkTransfer(AGENT, TOKEN, ASSET_CAP);
        _assertEqB32(reason, reg.REASON_PAUSED(), "global pause out-ranks agent pause");
    }

    function test_ReasonOrder_AgentPausedOutranksExpired() public {
        VM.warp(EXPIRY + 1); // also expired
        VM.prank(OWNER);
        reg.setAgentPaused(AGENT, true);
        (, bytes32 reason) = reg.checkTransfer(AGENT, TOKEN, ASSET_CAP);
        _assertEqB32(reason, reg.REASON_AGENT_PAUSED(), "agent pause out-ranks expiry");
    }

    function test_ReasonOrder_ExpiredOutranksNotAgent() public {
        VM.warp(EXPIRY + 1); // expired
        (, bytes32 reason) = reg.checkTransfer(STRANGER, TOKEN, ASSET_CAP); // also wrong agent
        _assertEqB32(reason, reg.REASON_EXPIRED(), "expiry out-ranks the agent check");
    }

    function test_ReasonOrder_NotAgentOutranksZeroAmount() public view {
        (, bytes32 reason) = reg.checkTransfer(STRANGER, TOKEN, 0); // wrong agent AND zero amount
        _assertEqB32(reason, reg.REASON_NOT_AGENT(), "agent check out-ranks zero-amount");
    }

    function test_ReasonOrder_ZeroAmountOutranksTokenNotAllowed() public view {
        (, bytes32 reason) = reg.checkTransfer(AGENT, OTHER_TOKEN, 0); // zero AND not-allowed token
        _assertEqB32(reason, reg.REASON_ZERO_AMOUNT(), "zero-amount out-ranks the token allowlist");
    }

    function test_ReasonOrder_TokenNotAllowedOutranksSpender() public {
        VM.prank(OWNER);
        reg.setSpenderAllowlistEnabled(true); // spender check active
        // OTHER_TOKEN not allowed AND no spender -> token rung (6) out-ranks spender rung (7).
        (, bytes32 reason) = reg.checkTransferTo(AGENT, OTHER_TOKEN, 1, EVIL_ROUTER);
        _assertEqB32(reason, reg.REASON_TOKEN_NOT_ALLOWED(), "token allowlist out-ranks the spender rung");
    }

    function test_ReasonOrder_SpenderOutranksOverTxCap() public {
        VM.prank(OWNER);
        reg.setAssetCap(TOKEN, NEVER, true); // raise asset cap so per-tx is the cap rung
        VM.prank(OWNER);
        reg.setSpenderAllowlistEnabled(true);
        // Over the per-tx cap AND a non-allowlisted spender -> spender rung (7) out-ranks cap rung (8).
        (, bytes32 reason) = reg.checkTransferTo(AGENT, TOKEN, PER_TX_CAP + 1, EVIL_ROUTER);
        _assertEqB32(reason, reg.REASON_SPENDER_NOT_ALLOWED(), "spender rung out-ranks the per-tx cap");
    }

    function test_ReasonOrder_OverTxCapOutranksOverAssetCap() public view {
        // amount over BOTH the per-tx cap and the asset sub-cap -> per-tx (8) out-ranks asset (9).
        (, bytes32 reason) = reg.checkTransfer(AGENT, TOKEN, PER_TX_CAP + 1);
        _assertEqB32(reason, reg.REASON_OVER_TX_CAP(), "per-tx cap out-ranks the per-asset sub-cap");
    }

    function test_ReasonOrder_OverAssetCapOutranksOverDestCap() public {
        VM.prank(OWNER);
        reg.setDestCap(EVIL_ROUTER, 100); // tiny dest cap
        // amount over the asset cap (1.5M) AND over the dest cap (100) -> asset (9) out-ranks dest (10).
        (, bytes32 reason) = reg.checkTransferTo(AGENT, TOKEN, ASSET_CAP + 1, EVIL_ROUTER);
        _assertEqB32(reason, reg.REASON_OVER_ASSET_CAP(), "per-asset cap out-ranks the per-destination cap");
    }

    function test_ReasonOrder_OverDestCapOutranksOverPeriodCap() public {
        VM.prank(OWNER);
        reg.setDestCap(EVIL_ROUTER, 100); // tiny dest cap (within the asset cap so asset passes)
        VM.prank(OWNER);
        reg.setPeriodConfig(1 hours, 50); // tiny period cap (the spend also exceeds it)
        // amount 1000 <= asset 1.5M, > dest 100, > period 50 -> dest (10) out-ranks period (11).
        (, bytes32 reason) = reg.checkTransferTo(AGENT, TOKEN, 1_000, EVIL_ROUTER);
        _assertEqB32(reason, reg.REASON_OVER_DEST_CAP(), "per-destination cap out-ranks the period cap");
    }

    function test_ReasonOrder_OverPeriodCapOutranksOverUsdCap() public {
        // Set up: amount passes the raw caps, exceeds BOTH the period cap and the USD cap. The period
        // tier (11) is checked before the USD tier (12), so OVER_PERIOD_CAP wins.
        VM.prank(OWNER);
        reg.setTokenDecimals(TOKEN, 6);
        feed.set(1_000_000); // $1 per whole token
        VM.prank(OWNER);
        reg.setPriceFeed(IPriceFeed(address(feed)), 100); // $0.0001 USD cap -> any real spend exceeds it
        VM.prank(OWNER);
        reg.setPeriodConfig(1 hours, 100); // 100-minor period cap -> the spend also exceeds it
        (, bytes32 reason) = reg.checkTransfer(AGENT, TOKEN, 1_000); // > period 100 AND > USD cap
        _assertEqB32(reason, reg.REASON_OVER_PERIOD_CAP(), "the period cap out-ranks the USD cap");
    }

    // ============================================================================================
    // Owner gate + constructor guards (carried from the MVP; the admin surface is owner-only).
    // ============================================================================================

    function test_OwnerGate_StrangerCannotSetCap() public {
        VM.prank(STRANGER);
        (bool success,) =
            address(reg).call(abi.encodeWithSelector(MandateRegistryV3.setPerTxCap.selector, uint256(1)));
        _assertTrue(!success, "a non-owner must not change the cap");
    }

    function test_OwnerGate_StrangerCannotPause() public {
        VM.prank(STRANGER);
        (bool success,) =
            address(reg).call(abi.encodeWithSelector(MandateRegistryV3.setPaused.selector, true));
        _assertTrue(!success, "a non-owner must not engage the kill-switch");
    }

    function test_BadPeriodConfig_NonzeroPeriodNeedsNonzeroCap() public {
        VM.prank(OWNER);
        (bool success,) = address(reg)
            .call(
                abi.encodeWithSelector(
                    MandateRegistryV3.setPeriodConfig.selector, uint256(1 hours), uint256(0)
                )
            );
        _assertTrue(!success, "a nonzero period with a zero cap must revert BadPeriodConfig");
    }

    function test_Constructor_RejectsZeroOwner() public {
        (bool success,) = address(this).call(abi.encodeWithSelector(this.deploy.selector, address(0), AGENT));
        _assertTrue(!success, "constructing with a zero owner must revert");
    }

    function test_Constructor_RejectsZeroAgent() public {
        (bool success,) = address(this).call(abi.encodeWithSelector(this.deploy.selector, OWNER, address(0)));
        _assertTrue(!success, "constructing with a zero agent must revert");
    }

    /// @dev External helper so the zero-address constructor reverts can be caught via a low-level call.
    function deploy(address o, address a) external returns (address) {
        return address(new MandateRegistryV3(o, a, PER_TX_CAP, EXPIRY));
    }

    // ============================================================================================
    // Views.
    // ============================================================================================

    function test_EffectiveCap_IsMinAcrossTiers() public {
        // min(perTx 2M, asset 1.5M) == 1.5M; with a 500k dest cap for EVIL_ROUTER it tightens to 500k.
        _assertEqU(reg.effectiveCap(TOKEN, address(0)), ASSET_CAP, "no dest -> min(perTx, asset)");
        VM.prank(OWNER);
        reg.setDestCap(EVIL_ROUTER, 500_000);
        _assertEqU(reg.effectiveCap(TOKEN, EVIL_ROUTER), 500_000, "dest cap tightens the effective cap");
        _assertEqU(reg.effectiveCap(OTHER_TOKEN, address(0)), 0, "non-allowlisted token -> 0");
    }

    function test_IsActive_TracksPauseExpiryAndAgentPause() public {
        _assertTrue(reg.isActive(AGENT), "a fresh, live mandate is active for the agent");
        VM.prank(OWNER);
        reg.setAgentPaused(AGENT, true);
        _assertTrue(!reg.isActive(AGENT), "an agent-paused mandate is not active for that agent");
    }

    function test_UsdValueMicros_ExactIntegerConversion() public {
        // 1.5 tokens (6 dec) at $2 -> $3.00 == 3_000_000 micros, exact-integer floor.
        VM.prank(OWNER);
        reg.setTokenDecimals(TOKEN, 6);
        feed.set(2_000_000);
        VM.prank(OWNER);
        reg.setPriceFeed(IPriceFeed(address(feed)), NEVER); // cap high so only the conversion is tested
        (bool priced, uint256 micros) = reg.usdValueMicros(TOKEN, 1_500_000);
        _assertTrue(priced, "the value must be priced");
        _assertEqU(micros, 3_000_000, "1.5 tokens at $2 == $3.00 (3_000_000 micros)");
    }
}
