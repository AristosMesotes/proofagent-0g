// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.26;

import {TimelockGuard, IMandateGate} from "../src/TimelockGuard.sol";
import {MandateRegistryV3} from "../src/MandateRegistryV3.sol";

/// @dev Minimal inline cheatcode interface -- the repo vendors NO forge-std (clean-room / offline,
///      design SS6). Only `prank` (call as the owner / agent) is used here.
interface IVm {
    function prank(address sender) external;
}

/// @title TimelockSpokeIsolationTest -- the PER-SPOKE ISOLATED CAPS end-to-end proof (design "2b.3").
/// @notice Wires the REAL {MandateRegistryV3} into the REAL {TimelockGuard} (no mock) and proves the
///         load-bearing isolation invariant: a per-spoke cap -- set on the registry via
///         {setDestCap(spokeSpender(selector), cap)} (REUSING V3's per-destination Tier-4 surface) --
///         bounds an outbound queue to THAT spoke ONLY. A weak/over-cap spoke is refused AT QUEUE
///         (MandateRefused, OVER_DEST_CAP), while:
///           - a DIFFERENT spoke (its own, looser cap) is untouched, and
///           - the 0G HUB's own on-hub spend (no spoke / address(0)) is untouched.
///         So a weak-spoke exploit can drain at most that one spoke's cap -- never the hub, never another
///         spoke. The 0G hub stays the security floor (design "2b": hub-and-spoke, not a mesh). No
///         forge-std: assertions are plain `require`. Each `testXxx` is auto-discovered.
contract TimelockSpokeIsolationTest {
    IVm internal constant VM = IVm(address(uint160(uint256(keccak256("hevm cheat code")))));

    MandateRegistryV3 internal reg;
    TimelockGuard internal guard;

    address internal constant OWNER = address(0xA11CE);
    address internal constant AGENT = address(0xA6E47);
    address internal constant TOKEN = address(0x1111111111111111111111111111111111111111);
    address internal constant RECIPIENT = address(0x2222222222222222222222222222222222222222);

    // Public 0G CCIP destination selectors (design WOW Feature 3b) -- two spokes + a third.
    uint64 internal constant SEL_ETHEREUM = 5_009_297_550_715_157_269; // the WEAK spoke (tight cap)
    uint64 internal constant SEL_ARBITRUM = 4_949_039_107_694_359_620; // a healthy spoke (looser cap)
    uint64 internal constant SEL_BNB = 11_344_663_589_394_136_015; // a no-per-spoke-cap spoke

    // The HUB's global ceiling is generous; the per-spoke caps are what tighten each lane.
    uint256 internal constant PER_TX_CAP = 10_000_000; // hub global per-tx cap (high)
    uint256 internal constant ASSET_CAP = 10_000_000; // token sub-cap (high)
    uint256 internal constant NEVER = type(uint256).max;

    // Per-spoke isolated caps (Tier-4 destCap keyed by each spoke's sentinel).
    uint256 internal constant ETH_SPOKE_CAP = 500_000; // the WEAK spoke: a tight 0.5M isolated cap
    uint256 internal constant ARB_SPOKE_CAP = 4_000_000; // a healthy spoke: a looser 4M isolated cap

    // Value tiers (irrelevant to the cap check, but the guard needs them).
    uint256 internal constant THRESHOLD = 1_000_000;
    uint256 internal constant SHORT_DELAY = 1 hours;
    uint256 internal constant LONG_DELAY = 1 days;

    function setUp() public {
        // The real four-tier registry: high global + asset caps so the per-spoke caps are the binding
        // constraint. Spender allowlist is OFF (so address(0) on-hub spends still pass), proving the
        // per-spoke caps -- not the allowlist -- are what isolate the spokes here.
        reg = new MandateRegistryV3(OWNER, AGENT, PER_TX_CAP, NEVER);
        VM.prank(OWNER);
        reg.setAssetCap(TOKEN, ASSET_CAP, true); // allowlist TOKEN with a high sub-cap

        guard = new TimelockGuard(
            OWNER, AGENT, IMandateGate(address(reg)), THRESHOLD, SHORT_DELAY, LONG_DELAY
        );

        // Resolve each spoke's sentinel FIRST (a pure call) so the `prank` below applies to the
        // owner-gated {setDestCap}, not to the sentinel lookup (prank affects only the NEXT call).
        address ethSpoke = guard.spokeSpender(SEL_ETHEREUM);
        address arbSpoke = guard.spokeSpender(SEL_ARBITRUM);

        // Configure the PER-SPOKE isolated caps ON the registry, keyed by each spoke's sentinel. This
        // REUSES V3's per-destination Tier-4 destCap surface.
        VM.prank(OWNER);
        reg.setDestCap(ethSpoke, ETH_SPOKE_CAP); // the weak spoke: 0.5M
        VM.prank(OWNER);
        reg.setDestCap(arbSpoke, ARB_SPOKE_CAP); // a healthy spoke: 4M
        // SEL_BNB intentionally has NO per-spoke cap (destCap unset == 0 == no per-spoke tightening).
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

    // --- the isolation invariant -----------------------------------------------------------------

    function test_WeakSpokeOverItsCap_IsRefusedAtQueue() public {
        // 0.6M > the ethereum spoke's 0.5M isolated cap -> the queue is refused (OVER_DEST_CAP), even
        // though it is FAR under the hub's 10M global cap. The weak spoke cannot exceed its own cap.
        bytes memory call = abi.encodeWithSelector(
            TimelockGuard.queueBridgeOut.selector, TOKEN, uint256(600_000), SEL_ETHEREUM, RECIPIENT
        );
        VM.prank(AGENT);
        _expectRevert(address(guard), call, TimelockGuard.MandateRefused.selector, "weak spoke over its cap is refused");
        _assertTrue(guard.statusOf(1) == TimelockGuard.Status.None, "no request recorded for a refused spoke");
    }

    function test_WeakSpokeWithinItsCap_QueuesFine() public {
        // 0.5M == the ethereum spoke's cap (inclusive) -> queues fine.
        VM.prank(AGENT);
        uint256 id = guard.queueBridgeOut(TOKEN, ETH_SPOKE_CAP, SEL_ETHEREUM, RECIPIENT);
        _assertTrue(guard.statusOf(id) == TimelockGuard.Status.Pending, "weak spoke within its cap queues");
    }

    function test_DifferentSpokeIsUntouchedByAnotherSpokesTightCap() public {
        // The SAME 0.6M that the weak ethereum spoke (0.5M cap) REFUSES is fine on the arbitrum spoke
        // (4M cap) -- the spokes are ISOLATED, one's tight cap never constrains another.
        VM.prank(AGENT);
        uint256 id = guard.queueBridgeOut(TOKEN, uint256(600_000), SEL_ARBITRUM, RECIPIENT);
        _assertTrue(guard.statusOf(id) == TimelockGuard.Status.Pending, "arbitrum spoke is unaffected by ethereum's cap");
    }

    function test_AnUncappedSpokeFallsBackToTheHubCapsNotAnotherSpokes() public {
        // SEL_BNB has NO per-spoke cap -> it inherits the hub's global/asset caps (10M), NOT the weak
        // ethereum spoke's 0.5M. 0.6M (which ethereum refuses) queues fine on the uncapped BNB spoke.
        VM.prank(AGENT);
        uint256 id = guard.queueBridgeOut(TOKEN, uint256(600_000), SEL_BNB, RECIPIENT);
        _assertTrue(guard.statusOf(id) == TimelockGuard.Status.Pending, "an uncapped spoke uses the hub caps, not another spoke's");
        // And it is still bounded by the HUB cap: above 10M is refused on the uncapped spoke too.
        bytes memory call = abi.encodeWithSelector(
            TimelockGuard.queueBridgeOut.selector, TOKEN, uint256(10_000_001), SEL_BNB, RECIPIENT
        );
        VM.prank(AGENT);
        _expectRevert(address(guard), call, TimelockGuard.MandateRefused.selector, "the hub cap still bounds an uncapped spoke");
    }

    function test_TheHubItselfIsUntouchedByAnySpokeCap() public view {
        // The 0G HUB's own on-hub spend (no spoke / address(0) spender) is checked against the hub's
        // global+asset caps ONLY -- a spoke's tight cap NEVER tightens the hub. 0.6M (the weak ethereum
        // spoke refuses it) passes the hub gate directly.
        (bool ok, bytes32 reason) = reg.checkTransfer(AGENT, TOKEN, 600_000);
        _assertTrue(ok, "the hub's own spend is not constrained by any spoke's cap");
        _assertTrue(reason == reg.REASON_OK(), "the hub spend is within mandate");
        // And the hub's full 10M is available on-hub -- the weak spoke's 0.5M never touched it.
        (bool okBig,) = reg.checkTransfer(AGENT, TOKEN, PER_TX_CAP);
        _assertTrue(okBig, "the hub's full global cap is intact regardless of any spoke");
    }

    function test_SpokeCapViewsReflectTheRegistryConfig() public view {
        // The guard's read-through views surface each spoke's OWN isolated cap.
        _assertTrue(guard.spokeCap(SEL_ETHEREUM) == ETH_SPOKE_CAP, "ethereum spoke cap view");
        _assertTrue(guard.spokeCap(SEL_ARBITRUM) == ARB_SPOKE_CAP, "arbitrum spoke cap view");
        _assertTrue(guard.spokeCap(SEL_BNB) == 0, "bnb spoke has no per-spoke cap");
        // The effective ceiling for the weak spoke is min(perTx 10M, asset 10M, spoke 0.5M) == 0.5M.
        _assertTrue(
            guard.spokeEffectiveCap(TOKEN, SEL_ETHEREUM) == ETH_SPOKE_CAP,
            "the weak spoke's effective ceiling is its own tight cap"
        );
        // The uncapped BNB spoke's effective ceiling is the hub's min(perTx, asset) == 10M.
        _assertTrue(
            guard.spokeEffectiveCap(TOKEN, SEL_BNB) == ASSET_CAP,
            "an uncapped spoke's ceiling is the hub cap"
        );
    }
}
