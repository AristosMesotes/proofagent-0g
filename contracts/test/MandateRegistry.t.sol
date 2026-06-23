// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.26;

import {MandateRegistry} from "../src/MandateRegistry.sol";

/// @dev Minimal inline cheatcode interface -- the repo vendors NO forge-std (clean-room /
///      offline-by-default, design SS6), so the tests declare only the cheatcodes they use:
///      `warp` (drive `block.timestamp` for the expiry case) and `prank` (call as a non-owner to
///      check the owner gate). The address is Foundry's well-known cheatcode address.
interface IVm {
    function warp(uint256 newTimestamp) external;
    function prank(address sender) external;
}

/// @title MandateRegistryTest -- dependency-free Foundry tests for {MandateRegistry}.
/// @notice Covers the build-spec's three mandated cases (cap-pass, over-cap-reject, expiry-reject)
///         plus the rest of the mandate surface (allowlist, per-asset sub-cap, agent, kill-switch,
///         zero-amount, owner gate). No forge-std: assertions are plain `require`, so `forge test`
///         runs offline with zero submodules. Each `testXxx` is auto-discovered by the runner.
contract MandateRegistryTest {
    IVm internal constant VM = IVm(address(uint160(uint256(keccak256("hevm cheat code")))));

    MandateRegistry internal reg;

    // Fixed actors / token (deterministic; design SS3 principle 4).
    address internal constant OWNER = address(0xA11CE);
    address internal constant AGENT = address(0xA6E47);
    address internal constant STRANGER = address(0xBEEF);
    address internal constant TOKEN = address(0x1111111111111111111111111111111111111111);
    address internal constant OTHER_TOKEN = address(0x2222222222222222222222222222222222222222);

    // Caps, in MINOR units (e.g. a $2 cap on a 6-decimal USDC.e == 2_000_000). Sub-cap < per-tx cap
    // so the per-asset rung is independently exercised.
    uint256 internal constant PER_TX_CAP = 2_000_000; // global per-tx limit
    uint256 internal constant ASSET_CAP = 1_500_000; // token sub-cap (tighter than per-tx)
    uint256 internal constant NEVER = type(uint256).max;

    // A non-zero start time so `block.timestamp` arithmetic around expiry is meaningful.
    uint256 internal constant T0 = 1_000_000;
    uint256 internal constant EXPIRY = T0 + 1 days;

    function setUp() public {
        VM.warp(T0);
        reg = new MandateRegistry(OWNER, AGENT, PER_TX_CAP, EXPIRY);
        // Allowlist TOKEN with a tighter sub-cap; OTHER_TOKEN stays off the allowlist.
        VM.prank(OWNER);
        reg.setAssetCap(TOKEN, ASSET_CAP, true);
    }

    // --- internal assertion helpers (no forge-std) ----------------------------------------------

    function _assertTrue(bool cond, string memory why) internal pure {
        require(cond, why);
    }

    function _assertEqB32(bytes32 a, bytes32 b, string memory why) internal pure {
        require(a == b, why);
    }

    // --------------------------------------------------------------------------------------------
    // SPEC CASE 1 / 3 -- cap-pass: a within-cap, allowlisted transfer by the agent returns ok.
    // --------------------------------------------------------------------------------------------

    function test_CapPass_WithinAllCaps() public view {
        // amount <= assetCap (1.5M) <= perTxCap (2M), allowlisted token, mandated agent, live mandate.
        (bool ok, bytes32 reason) = reg.checkTransfer(AGENT, TOKEN, ASSET_CAP);
        _assertTrue(ok, "within-cap transfer must be ok");
        _assertEqB32(reason, reg.REASON_OK(), "ok transfer reason must be REASON_OK (zero)");
    }

    function test_CapPass_AtExactPerAssetCapBoundary() public view {
        // The cap is INCLUSIVE: amount == assetCap must pass (`amount > cap` is the reject edge).
        (bool ok,) = reg.checkTransfer(AGENT, TOKEN, ASSET_CAP);
        _assertTrue(ok, "amount exactly at the per-asset cap must pass (inclusive bound)");
    }

    // --------------------------------------------------------------------------------------------
    // SPEC CASE 2 / 3 -- over-cap-reject: a transfer over the cap is rejected with the right reason.
    // --------------------------------------------------------------------------------------------

    function test_OverCapReject_OverPerAssetSubCap() public view {
        // assetCap < amount <= perTxCap -> clears per-tx, fails the per-asset sub-cap.
        (bool ok, bytes32 reason) = reg.checkTransfer(AGENT, TOKEN, ASSET_CAP + 1);
        _assertTrue(!ok, "over the per-asset sub-cap must be rejected");
        _assertEqB32(reason, reg.REASON_OVER_ASSET_CAP(), "reason must be OVER_ASSET_CAP");
    }

    function test_OverCapReject_OverGlobalPerTxCap() public {
        // Give TOKEN a sub-cap >= per-tx cap so the GLOBAL per-tx rung is the binding one, then go over.
        VM.prank(OWNER);
        reg.setAssetCap(TOKEN, NEVER, true); // sub-cap effectively unlimited
        (bool ok, bytes32 reason) = reg.checkTransfer(AGENT, TOKEN, PER_TX_CAP + 1);
        _assertTrue(!ok, "over the global per-tx cap must be rejected");
        _assertEqB32(reason, reg.REASON_OVER_TX_CAP(), "reason must be OVER_TX_CAP");
    }

    // --------------------------------------------------------------------------------------------
    // SPEC CASE 3 / 3 -- expiry-reject: at/after expiry every transfer is rejected.
    // --------------------------------------------------------------------------------------------

    function test_ExpiryReject_AtExpiryInstant() public {
        // `>=` makes the expiry instant itself already-expired (half-open window [start, expiry)).
        VM.warp(EXPIRY);
        (bool ok, bytes32 reason) = reg.checkTransfer(AGENT, TOKEN, ASSET_CAP);
        _assertTrue(!ok, "a transfer AT the expiry instant must be rejected");
        _assertEqB32(reason, reg.REASON_EXPIRED(), "reason must be EXPIRED");
    }

    function test_ExpiryReject_AfterExpiry() public {
        VM.warp(EXPIRY + 1 days);
        (bool ok, bytes32 reason) = reg.checkTransfer(AGENT, TOKEN, ASSET_CAP);
        _assertTrue(!ok, "a transfer after expiry must be rejected");
        _assertEqB32(reason, reg.REASON_EXPIRED(), "reason must be EXPIRED");
    }

    function test_JustBeforeExpiry_StillPasses() public {
        VM.warp(EXPIRY - 1);
        (bool ok,) = reg.checkTransfer(AGENT, TOKEN, ASSET_CAP);
        _assertTrue(ok, "one second before expiry the mandate is still live");
    }

    // --------------------------------------------------------------------------------------------
    // Allowlist (design SS2: allowlist) -- a non-allowlisted token is always rejected.
    // --------------------------------------------------------------------------------------------

    function test_AllowlistReject_TokenNotAllowed() public view {
        (bool ok, bytes32 reason) = reg.checkTransfer(AGENT, OTHER_TOKEN, 1);
        _assertTrue(!ok, "a non-allowlisted token must be rejected");
        _assertEqB32(reason, reg.REASON_TOKEN_NOT_ALLOWED(), "reason must be TOKEN_NOT_ALLOWED");
    }

    function test_Allowlist_RemovedTokenRejected() public {
        VM.prank(OWNER);
        reg.setAllowed(TOKEN, false); // de-allowlist without touching the sub-cap
        (bool ok, bytes32 reason) = reg.checkTransfer(AGENT, TOKEN, 1);
        _assertTrue(!ok, "a de-allowlisted token must be rejected");
        _assertEqB32(reason, reg.REASON_TOKEN_NOT_ALLOWED(), "reason must be TOKEN_NOT_ALLOWED");
    }

    // --------------------------------------------------------------------------------------------
    // Agent identity -- only the mandated agent may spend.
    // --------------------------------------------------------------------------------------------

    function test_AgentReject_WrongAgent() public view {
        (bool ok, bytes32 reason) = reg.checkTransfer(STRANGER, TOKEN, ASSET_CAP);
        _assertTrue(!ok, "a non-mandated agent must be rejected");
        _assertEqB32(reason, reg.REASON_NOT_AGENT(), "reason must be NOT_AGENT");
    }

    // --------------------------------------------------------------------------------------------
    // Kill-switch (design SS4) -- a paused mandate permits nothing, and pause out-ranks every check.
    // --------------------------------------------------------------------------------------------

    function test_KillSwitch_PausedRejectsEverything() public {
        VM.prank(OWNER);
        reg.setPaused(true);
        (bool ok, bytes32 reason) = reg.checkTransfer(AGENT, TOKEN, ASSET_CAP);
        _assertTrue(!ok, "a paused mandate must reject a would-be-valid transfer");
        _assertEqB32(reason, reg.REASON_PAUSED(), "reason must be PAUSED");
    }

    function test_KillSwitch_UnpauseRestores() public {
        VM.prank(OWNER);
        reg.setPaused(true);
        VM.prank(OWNER);
        reg.setPaused(false);
        (bool ok,) = reg.checkTransfer(AGENT, TOKEN, ASSET_CAP);
        _assertTrue(ok, "un-pausing restores the mandate");
    }

    // --------------------------------------------------------------------------------------------
    // Zero amount -- a no-op spend is never valid.
    // --------------------------------------------------------------------------------------------

    function test_ZeroAmountReject() public view {
        (bool ok, bytes32 reason) = reg.checkTransfer(AGENT, TOKEN, 0);
        _assertTrue(!ok, "a zero-amount transfer must be rejected");
        _assertEqB32(reason, reg.REASON_ZERO_AMOUNT(), "reason must be ZERO_AMOUNT");
    }

    // --------------------------------------------------------------------------------------------
    // Reason ordering -- pause out-ranks expiry (the most-global check wins, deterministically).
    // --------------------------------------------------------------------------------------------

    function test_ReasonOrdering_PausedOutranksExpired() public {
        VM.warp(EXPIRY + 1); // also expired
        VM.prank(OWNER);
        reg.setPaused(true);
        (, bytes32 reason) = reg.checkTransfer(AGENT, TOKEN, ASSET_CAP);
        _assertEqB32(reason, reg.REASON_PAUSED(), "pause must out-rank expiry in the reason order");
    }

    // --------------------------------------------------------------------------------------------
    // Views.
    // --------------------------------------------------------------------------------------------

    function test_EffectiveCap_IsMinOfPerTxAndAsset() public view {
        // min(perTxCap 2M, assetCap 1.5M) == 1.5M for the allowlisted token.
        _assertTrue(reg.effectiveCap(TOKEN) == ASSET_CAP, "effective cap must be the tighter sub-cap");
        // Non-allowlisted token -> 0.
        _assertTrue(reg.effectiveCap(OTHER_TOKEN) == 0, "effective cap of a non-allowed token is 0");
    }

    function test_IsActive_TracksPauseAndExpiry() public {
        _assertTrue(reg.isActive(), "a fresh, live mandate is active");
        VM.warp(EXPIRY);
        _assertTrue(!reg.isActive(), "an expired mandate is not active");
    }

    // --------------------------------------------------------------------------------------------
    // Owner gate -- the mutating surface is owner-only; a stranger reverts.
    // --------------------------------------------------------------------------------------------

    function test_OwnerGate_StrangerCannotSetCap() public {
        VM.prank(STRANGER);
        (bool success,) =
            address(reg).call(abi.encodeWithSelector(MandateRegistry.setPerTxCap.selector, uint256(1)));
        _assertTrue(!success, "a non-owner must not be able to change the cap");
    }

    function test_OwnerCanSetCap() public {
        VM.prank(OWNER);
        reg.setPerTxCap(123);
        _assertTrue(reg.perTxCap() == 123, "the owner can change the per-tx cap");
    }

    // --------------------------------------------------------------------------------------------
    // Constructor guards.
    // --------------------------------------------------------------------------------------------

    function test_Constructor_RejectsZeroOwner() public {
        (bool success,) = address(this).call(
            abi.encodeWithSelector(this.deployRegistry.selector, address(0), AGENT)
        );
        _assertTrue(!success, "constructing with a zero owner must revert");
    }

    function test_Constructor_RejectsZeroAgent() public {
        (bool success,) = address(this).call(
            abi.encodeWithSelector(this.deployRegistry.selector, OWNER, address(0))
        );
        _assertTrue(!success, "constructing with a zero agent must revert");
    }

    /// @dev External helper so the zero-address constructor reverts can be caught via a low-level call.
    function deployRegistry(address o, address a) external returns (address) {
        return address(new MandateRegistry(o, a, PER_TX_CAP, EXPIRY));
    }
}
