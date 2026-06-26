// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.26;

import {SettlementOracle} from "../src/SettlementOracle.sol";

/// @dev Minimal inline cheatcode interface -- the repo vendors NO forge-std (clean-room /
///      offline-by-default), so the tests declare only the cheatcodes they use: `prank` (call as a
///      non-attestor / non-owner to exercise the role gates). The address is Foundry's well-known
///      cheatcode address, derived (no hardcoded magic literal) the same way as the other tests.
interface IVm {
    function prank(address sender) external;
}

/// @title SettlementOracleTest -- dependency-free Foundry tests for {SettlementOracle}.
/// @notice Covers the honesty doctrine end to end: the fail-closed default (Unverified), RELEASE
///         only on Settled, the HOLLOW-fill block (never released), write-once-final (no retroactive
///         flip), the attestor monopoly, owner-gated rotation/ownership, and fill-id independence.
///         No forge-std: assertions are plain `require`, and revert-expectations use a low-level
///         `address(c).call(...)` returning `success == false`, exactly as `MandateRegistry.t.sol`
///         does it, so `forge test` runs offline with zero submodules.
contract SettlementOracleTest {
    IVm internal constant VM = IVm(address(uint160(uint256(keccak256("hevm cheat code")))));

    SettlementOracle internal oracle;

    // Fixed actors (deterministic). OWNER is `address(this)` -- the test contract deploys the oracle,
    // so it is the owner -- which lets the owner-gated calls run without a prank.
    address internal constant ATTESTOR = address(0xA77E5);
    address internal constant NEW_ATTESTOR = address(0xB077E);
    address internal constant STRANGER = address(0xBEEF);
    address internal constant NEW_OWNER = address(0xC0FFEE);

    // Fixed fill ids (the destination fill tx hash / intent id). Distinct so independence is testable.
    bytes32 internal constant FILL_A = keccak256("fill-a");
    bytes32 internal constant FILL_B = keccak256("fill-b");
    bytes32 internal constant FILL_C = keccak256("fill-c");

    function setUp() public {
        // The test contract is the deployer => the owner. ATTESTOR is the verifier operator.
        oracle = new SettlementOracle(ATTESTOR);
    }

    // --- internal assertion helpers (no forge-std) ----------------------------------------------

    function _assertTrue(bool cond, string memory why) internal pure {
        require(cond, why);
    }

    function _assertEqVerdict(SettlementOracle.Verdict a, SettlementOracle.Verdict b, string memory why)
        internal
        pure
    {
        require(a == b, why);
    }

    /// @dev Attest `verdict` for `fillId` as the authorized ATTESTOR (the common happy path).
    function _attestAs(address who, bytes32 fillId, SettlementOracle.Verdict verdict) internal {
        VM.prank(who);
        oracle.attest(fillId, verdict);
    }

    // --------------------------------------------------------------------------------------------
    // Fail-closed default -- an un-attested fill id is Unverified, not releasable, and the gate reverts.
    // --------------------------------------------------------------------------------------------

    function test_Default_UnattestedIsUnverifiedAndNotReleasable() public view {
        _assertEqVerdict(
            oracle.verdictOf(FILL_A),
            SettlementOracle.Verdict.Unverified,
            "an un-attested fill defaults to Unverified (ordinal 0)"
        );
        _assertTrue(!oracle.isReleasable(FILL_A), "an un-attested fill is NOT releasable (fail-closed)");
    }

    function test_Default_RequireProvenRevertsForUnattested() public view {
        // requireProven is the gate -- it MUST revert for a fill nobody attested (fail-closed).
        (bool success,) =
            address(oracle).staticcall(abi.encodeWithSelector(SettlementOracle.requireProven.selector, FILL_A));
        _assertTrue(!success, "requireProven must revert for an un-attested (Unverified) fill");
    }

    // --------------------------------------------------------------------------------------------
    // RELEASE only on Settled -- the single releasable verdict.
    // --------------------------------------------------------------------------------------------

    function test_Settled_RequireProvenPassesAndReleasable() public {
        _attestAs(ATTESTOR, FILL_A, SettlementOracle.Verdict.Settled);
        // The gate must NOT revert for a Settled fill.
        (bool success,) =
            address(oracle).staticcall(abi.encodeWithSelector(SettlementOracle.requireProven.selector, FILL_A));
        _assertTrue(success, "requireProven must NOT revert for a Settled fill");
        _assertTrue(oracle.isReleasable(FILL_A), "a Settled fill is releasable");
        _assertEqVerdict(
            oracle.verdictOf(FILL_A), SettlementOracle.Verdict.Settled, "stored verdict must be Settled"
        );
    }

    // --------------------------------------------------------------------------------------------
    // THE KILLER -- a HOLLOW fill is never released (where a hash-only oracle would have paid).
    // --------------------------------------------------------------------------------------------

    function test_Hollow_NeverReleased() public {
        _attestAs(ATTESTOR, FILL_A, SettlementOracle.Verdict.Hollow);
        (bool success,) =
            address(oracle).staticcall(abi.encodeWithSelector(SettlementOracle.requireProven.selector, FILL_A));
        _assertTrue(!success, "requireProven MUST revert for a Hollow fill (never release a hollow fill)");
        _assertTrue(!oracle.isReleasable(FILL_A), "a Hollow fill is NOT releasable");
        _assertEqVerdict(
            oracle.verdictOf(FILL_A), SettlementOracle.Verdict.Hollow, "stored verdict must be Hollow"
        );
    }

    // --------------------------------------------------------------------------------------------
    // Mismatch -- the wrong-delivery verdict is also never released.
    // --------------------------------------------------------------------------------------------

    function test_Mismatch_NeverReleased() public {
        _attestAs(ATTESTOR, FILL_A, SettlementOracle.Verdict.Mismatch);
        (bool success,) =
            address(oracle).staticcall(abi.encodeWithSelector(SettlementOracle.requireProven.selector, FILL_A));
        _assertTrue(!success, "requireProven MUST revert for a Mismatch fill");
        _assertTrue(!oracle.isReleasable(FILL_A), "a Mismatch fill is NOT releasable");
    }

    // --------------------------------------------------------------------------------------------
    // Write-once-final -- the core honesty guarantee: a final verdict can NEVER be flipped.
    // --------------------------------------------------------------------------------------------

    function test_WriteOnceFinal_HollowCannotBeFlippedToSettled() public {
        _attestAs(ATTESTOR, FILL_A, SettlementOracle.Verdict.Hollow);
        // A second attestation (even by the legitimate attestor) MUST revert AlreadyFinal.
        VM.prank(ATTESTOR);
        (bool success,) = address(oracle).call(
            abi.encodeWithSelector(
                SettlementOracle.attest.selector, FILL_A, SettlementOracle.Verdict.Settled
            )
        );
        _assertTrue(!success, "a Hollow verdict must NOT be retroactively flippable to Settled");
        // ...and the stored verdict is unchanged -- still Hollow, still not releasable.
        _assertEqVerdict(
            oracle.verdictOf(FILL_A),
            SettlementOracle.Verdict.Hollow,
            "the verdict after a blocked flip is still Hollow"
        );
        _assertTrue(!oracle.isReleasable(FILL_A), "the fill is still not releasable after a blocked flip");
    }

    function test_WriteOnceFinal_SettledCannotBeRevoked() public {
        _attestAs(ATTESTOR, FILL_A, SettlementOracle.Verdict.Settled);
        // Re-attesting a different verdict over a Settled fill MUST revert (no revoke).
        VM.prank(ATTESTOR);
        (bool success,) = address(oracle).call(
            abi.encodeWithSelector(
                SettlementOracle.attest.selector, FILL_A, SettlementOracle.Verdict.Hollow
            )
        );
        _assertTrue(!success, "a Settled verdict must NOT be revocable");
        _assertEqVerdict(
            oracle.verdictOf(FILL_A), SettlementOracle.Verdict.Settled, "a Settled verdict stays Settled"
        );
    }

    function test_WriteOnceFinal_SameVerdictReattestAlsoReverts() public {
        // Even re-attesting the SAME verdict is a write to an already-final id -> reverts AlreadyFinal.
        _attestAs(ATTESTOR, FILL_A, SettlementOracle.Verdict.Settled);
        VM.prank(ATTESTOR);
        (bool success,) = address(oracle).call(
            abi.encodeWithSelector(
                SettlementOracle.attest.selector, FILL_A, SettlementOracle.Verdict.Settled
            )
        );
        _assertTrue(!success, "re-attesting an already-final id must revert even with the same verdict");
    }

    // --------------------------------------------------------------------------------------------
    // Invalid verdict -- you cannot attest the Unverified default (the absence of a verdict).
    // --------------------------------------------------------------------------------------------

    function test_Attest_UnverifiedReverts() public {
        VM.prank(ATTESTOR);
        (bool success,) = address(oracle).call(
            abi.encodeWithSelector(
                SettlementOracle.attest.selector, FILL_A, SettlementOracle.Verdict.Unverified
            )
        );
        _assertTrue(!success, "attesting the Unverified default must revert (cannot attest no-verdict)");
        // And nothing was written -- the fill is still the default.
        _assertEqVerdict(
            oracle.verdictOf(FILL_A),
            SettlementOracle.Verdict.Unverified,
            "a rejected Unverified attest writes nothing"
        );
    }

    // --------------------------------------------------------------------------------------------
    // Attestor monopoly -- only the attestor may attest.
    // --------------------------------------------------------------------------------------------

    function test_OnlyAttestor_StrangerCannotAttest() public {
        VM.prank(STRANGER);
        (bool success,) = address(oracle).call(
            abi.encodeWithSelector(
                SettlementOracle.attest.selector, FILL_A, SettlementOracle.Verdict.Settled
            )
        );
        _assertTrue(!success, "a non-attestor must not be able to attest");
        _assertTrue(!oracle.isReleasable(FILL_A), "a blocked attest leaves the fill not releasable");
    }

    function test_OnlyAttestor_OwnerCannotAttest() public {
        // The owner (this test contract) is NOT the attestor -- the roles are separate. A direct call
        // (no prank) is from `address(this)` == owner, which is not the attestor -> must revert.
        (bool success,) = address(oracle).call(
            abi.encodeWithSelector(
                SettlementOracle.attest.selector, FILL_A, SettlementOracle.Verdict.Settled
            )
        );
        _assertTrue(!success, "the owner is not the attestor and must not be able to attest");
    }

    // --------------------------------------------------------------------------------------------
    // Attestor rotation -- owner-gated; old attestor loses the power, new one gains it.
    // --------------------------------------------------------------------------------------------

    function test_RotateAttestor_OwnerRotatesAndNewAttestorWorks() public {
        // Owner (this contract) rotates the attestor.
        oracle.rotateAttestor(NEW_ATTESTOR);
        _assertTrue(oracle.attestor() == NEW_ATTESTOR, "the attestor was rotated");
        // The NEW attestor can attest.
        _attestAs(NEW_ATTESTOR, FILL_A, SettlementOracle.Verdict.Settled);
        _assertTrue(oracle.isReleasable(FILL_A), "the new attestor can post a releasable verdict");
    }

    function test_RotateAttestor_OldAttestorCanNoLongerAttest() public {
        oracle.rotateAttestor(NEW_ATTESTOR);
        // The OLD attestor must now be rejected.
        VM.prank(ATTESTOR);
        (bool success,) = address(oracle).call(
            abi.encodeWithSelector(
                SettlementOracle.attest.selector, FILL_B, SettlementOracle.Verdict.Settled
            )
        );
        _assertTrue(!success, "the old attestor must no longer be able to attest after rotation");
    }

    function test_RotateAttestor_NonOwnerReverts() public {
        VM.prank(STRANGER);
        (bool success,) = address(oracle).call(
            abi.encodeWithSelector(SettlementOracle.rotateAttestor.selector, NEW_ATTESTOR)
        );
        _assertTrue(!success, "a non-owner must not be able to rotate the attestor");
        _assertTrue(oracle.attestor() == ATTESTOR, "a blocked rotation leaves the attestor unchanged");
    }

    function test_RotateAttestor_ZeroAddressReverts() public {
        (bool success,) = address(oracle).call(
            abi.encodeWithSelector(SettlementOracle.rotateAttestor.selector, address(0))
        );
        _assertTrue(!success, "rotating to the zero address must revert");
    }

    // --------------------------------------------------------------------------------------------
    // Ownership -- owner-gated transfer + zero-address guard.
    // --------------------------------------------------------------------------------------------

    function test_TransferOwnership_Works() public {
        oracle.transferOwnership(NEW_OWNER);
        _assertTrue(oracle.owner() == NEW_OWNER, "ownership was transferred");
        // The OLD owner (this contract) can no longer rotate the attestor.
        (bool success,) = address(oracle).call(
            abi.encodeWithSelector(SettlementOracle.rotateAttestor.selector, NEW_ATTESTOR)
        );
        _assertTrue(!success, "the old owner loses the admin surface after transfer");
    }

    function test_TransferOwnership_ZeroAddressReverts() public {
        (bool success,) = address(oracle).call(
            abi.encodeWithSelector(SettlementOracle.transferOwnership.selector, address(0))
        );
        _assertTrue(!success, "transferring ownership to the zero address must revert");
    }

    function test_TransferOwnership_NonOwnerReverts() public {
        VM.prank(STRANGER);
        (bool success,) = address(oracle).call(
            abi.encodeWithSelector(SettlementOracle.transferOwnership.selector, NEW_OWNER)
        );
        _assertTrue(!success, "a non-owner must not be able to transfer ownership");
    }

    // --------------------------------------------------------------------------------------------
    // Constructor guard.
    // --------------------------------------------------------------------------------------------

    function test_Constructor_RejectsZeroAttestor() public {
        (bool success,) =
            address(this).call(abi.encodeWithSelector(this.deployOracle.selector, address(0)));
        _assertTrue(!success, "constructing with a zero attestor must revert");
    }

    /// @dev External helper so the zero-address constructor revert can be caught via a low-level call.
    function deployOracle(address attestor_) external returns (address) {
        return address(new SettlementOracle(attestor_));
    }

    // --------------------------------------------------------------------------------------------
    // Independence / determinism -- distinct fill ids never interfere with one another.
    // --------------------------------------------------------------------------------------------

    function test_Independence_DistinctFillsDoNotInterfere() public {
        _attestAs(ATTESTOR, FILL_A, SettlementOracle.Verdict.Settled);
        _attestAs(ATTESTOR, FILL_B, SettlementOracle.Verdict.Hollow);
        // FILL_C is left un-attested.
        _assertTrue(oracle.isReleasable(FILL_A), "FILL_A (Settled) is releasable");
        _assertTrue(!oracle.isReleasable(FILL_B), "FILL_B (Hollow) is not releasable");
        _assertTrue(!oracle.isReleasable(FILL_C), "FILL_C (un-attested) is not releasable");
        _assertEqVerdict(
            oracle.verdictOf(FILL_B), SettlementOracle.Verdict.Hollow, "FILL_B verdict is independently Hollow"
        );
        _assertEqVerdict(
            oracle.verdictOf(FILL_C),
            SettlementOracle.Verdict.Unverified,
            "FILL_C stays the Unverified default"
        );
    }
}
