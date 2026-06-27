// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.26;

import {AgentIdentity} from "../src/AgentIdentity.sol";

/// @dev Minimal inline cheatcode interface -- the repo vendors NO forge-std (clean-room / offline, design SS6).
///      Declares only what these tests use: `prank` (call as another sender), `addr` + `sign` (derive the
///      verifier oracle address + sign a validity proof). The address is Foundry's well-known cheatcode address.
interface IVm {
    function prank(address sender) external;
    function addr(uint256 privateKey) external pure returns (address);
    function sign(uint256 privateKey, bytes32 digest) external pure returns (uint8 v, bytes32 r, bytes32 s);
}

/// @dev A stand-in for {MandateRegistryV4} exposing only checkTransfer, so {AgentIdentity.canSpend} can be
///      exercised against a controllable verdict (no full mandate needed for the identity's unit tests).
contract MockMandate {
    bool private _ok;
    bytes32 private _reason;

    function set(bool ok_, bytes32 reason_) external {
        _ok = ok_;
        _reason = reason_;
    }

    function checkTransfer(address, address, uint256) external view returns (bool, bytes32) {
        return (_ok, _reason);
    }
}

/// @title AgentIdentityTest -- dependency-free Foundry tests for the ERC-7857 Agentic-ID iNFT.
/// @notice Covers: mint + bindings, the mandate-enforcing canSpend (live verdict / inactive / no-mandate),
///         the verifier-signed re-seal (valid / bad signer / single-use nonce), iTransferFrom (move + reseal),
///         the deactivate-on-plain-transfer honesty invariant, usage delegation, and the issuer mint gate.
contract AgentIdentityTest {
    IVm internal constant VM = IVm(address(uint160(uint256(keccak256("hevm cheat code")))));

    AgentIdentity internal id;
    MockMandate internal mandate;

    address internal constant ISSUER = address(0x15517E5);
    address internal constant OWNER = address(0xA11CE);
    address internal constant BUYER = address(0xB0B);
    address internal constant STRANGER = address(0xBEEF);
    address internal constant AGENT = address(0xA6E47);
    address internal constant TOKEN = address(0x1111111111111111111111111111111111111111);

    uint256 internal constant VERIFIER_PK = 0xA77E57; // the TEE attestation oracle's signing key (test-only)
    uint256 internal constant WRONG_PK = 0xBAD;

    bytes32 internal constant SEAL0 = bytes32(uint256(0x6b51));
    bytes32 internal constant SEAL1 = bytes32(uint256(0x9602));

    uint256 internal tokenId;

    function setUp() public {
        id = new AgentIdentity(ISSUER);
        mandate = new MockMandate();
        address verifier = VM.addr(VERIFIER_PK);
        VM.prank(ISSUER);
        tokenId = id.mint(OWNER, AGENT, address(mandate), verifier, SEAL0, "qwen/qwen2.5-omni-7b");
    }

    // --- assertion helpers (no forge-std) --------------------------------------------------------
    function _t(bool cond, string memory why) internal pure {
        require(cond, why);
    }

    function _sign(uint256 pk, address to, bytes32 newSeal) internal view returns (bytes memory) {
        bytes32 digest = id.proofDigest(tokenId, to, newSeal);
        (uint8 v, bytes32 r, bytes32 s) = VM.sign(pk, digest);
        return abi.encode(v, r, s);
    }

    // --- mint + bindings -------------------------------------------------------------------------
    function testMintBindsTheFullIdentity() public view {
        _t(id.ownerOf(tokenId) == OWNER, "owner");
        _t(id.balanceOf(OWNER) == 1, "balance");
        _t(id.totalSupply() == 1, "supply");
        AgentIdentity.AgentRecord memory r = id.recordOf(tokenId);
        _t(r.agent == AGENT, "agent");
        _t(r.mandate == address(mandate), "mandate");
        _t(r.verifier == VM.addr(VERIFIER_PK), "verifier");
        _t(r.sealedMetadata == SEAL0, "seal");
        _t(r.active, "active");
        _t(r.nonce == 0, "nonce");
    }

    function testMintIsIssuerGated() public {
        VM.prank(STRANGER);
        (bool ok,) = address(id).call(
            abi.encodeWithSelector(id.mint.selector, OWNER, AGENT, address(mandate), VM.addr(VERIFIER_PK), SEAL0, "m")
        );
        _t(!ok, "non-issuer mint must revert");
    }

    // --- the REAL work: canSpend enforces the bound mandate --------------------------------------
    function testCanSpendReflectsLiveMandate() public {
        mandate.set(true, bytes32("OK"));
        (bool ok, bytes32 reason) = id.canSpend(tokenId, TOKEN, 1_000_000);
        _t(ok && reason == bytes32("OK"), "allowed reflects mandate");
        mandate.set(false, bytes32("OVER_TX_CAP"));
        (bool ok2, bytes32 reason2) = id.canSpend(tokenId, TOKEN, 3_000_000);
        _t(!ok2 && reason2 == bytes32("OVER_TX_CAP"), "over-cap reflects mandate");
    }

    function testCanSpendFailsClosedWhenInactive() public {
        mandate.set(true, bytes32("OK"));
        VM.prank(OWNER);
        id.transferFrom(OWNER, BUYER, tokenId); // a plain transfer DEACTIVATES the agent
        (bool ok, bytes32 reason) = id.canSpend(tokenId, TOKEN, 1);
        _t(!ok && reason == bytes32("INACTIVE"), "inactive fails closed regardless of the mandate");
    }

    function testCanSpendFailsClosedWithoutMandate() public {
        // Rebind to a non-contract address: the staticcall returns empty -> NO_MANDATE, never a fabricated allow.
        VM.prank(OWNER);
        id.rebindMandate(tokenId, address(0xDEAD));
        (bool ok, bytes32 reason) = id.canSpend(tokenId, TOKEN, 1);
        _t(!ok && reason == bytes32("NO_MANDATE"), "no mandate fails closed");
    }

    // --- the verifier-gated re-seal (ERC-7857 validity proof) ------------------------------------
    function testRebindMetadataWithValidProof() public {
        bytes memory proof = _sign(VERIFIER_PK, OWNER, SEAL1);
        VM.prank(OWNER);
        id.rebindMetadata(tokenId, SEAL1, proof);
        AgentIdentity.AgentRecord memory r = id.recordOf(tokenId);
        _t(r.sealedMetadata == SEAL1, "mind re-sealed");
        _t(r.nonce == 1, "nonce bumped");
        _t(r.active, "re-activated");
    }

    function testRebindRejectsAWrongSigner() public {
        bytes memory badProof = _sign(WRONG_PK, OWNER, SEAL1);
        VM.prank(OWNER);
        (bool ok,) = address(id).call(abi.encodeWithSelector(id.rebindMetadata.selector, tokenId, SEAL1, badProof));
        _t(!ok, "a non-verifier proof must revert (the oracle alone authorizes a re-seal)");
    }

    function testProofIsSingleUse() public {
        bytes memory proof = _sign(VERIFIER_PK, OWNER, SEAL1);
        VM.prank(OWNER);
        id.rebindMetadata(tokenId, SEAL1, proof); // consumes nonce 0
        VM.prank(OWNER);
        (bool ok,) = address(id).call(abi.encodeWithSelector(id.rebindMetadata.selector, tokenId, SEAL1, proof));
        _t(!ok, "replaying the same proof (now stale nonce) must revert");
    }

    function testITransferFromMovesOwnershipAndReseals() public {
        bytes memory proof = _sign(VERIFIER_PK, BUYER, SEAL1); // proof binds the NEW owner (BUYER)
        VM.prank(OWNER);
        id.iTransferFrom(OWNER, BUYER, tokenId, SEAL1, proof);
        _t(id.ownerOf(tokenId) == BUYER, "ownership moved");
        AgentIdentity.AgentRecord memory r = id.recordOf(tokenId);
        _t(r.sealedMetadata == SEAL1 && r.active && r.nonce == 1, "mind re-sealed atomically + active");
    }

    function testPlainTransferDeactivatesUntilReseal() public {
        VM.prank(OWNER);
        id.transferFrom(OWNER, BUYER, tokenId);
        _t(id.ownerOf(tokenId) == BUYER, "ownership moved");
        _t(!id.recordOf(tokenId).active, "the agent is deactivated until the new owner re-seals");
        // The new owner re-seals under the verifier -> active again.
        bytes memory proof = _sign(VERIFIER_PK, BUYER, SEAL1);
        VM.prank(BUYER);
        id.rebindMetadata(tokenId, SEAL1, proof);
        _t(id.recordOf(tokenId).active, "re-activated after the new owner's verifier-gated re-seal");
    }

    // --- usage delegation + ERC-165 --------------------------------------------------------------
    function testAuthorizeUsage() public {
        VM.prank(OWNER);
        id.authorizeUsage(tokenId, STRANGER, true);
        _t(id.usageAuthorized(tokenId, STRANGER), "usage granted");
        VM.prank(OWNER);
        id.authorizeUsage(tokenId, STRANGER, false);
        _t(!id.usageAuthorized(tokenId, STRANGER), "usage revoked");
    }

    function testUsageRightsAutoExpireOnSale() public {
        VM.prank(OWNER);
        id.authorizeUsage(tokenId, STRANGER, true);
        _t(id.usageAuthorized(tokenId, STRANGER), "granted");
        VM.prank(OWNER);
        id.transferFrom(OWNER, BUYER, tokenId); // a sale bumps the usage epoch
        _t(!id.usageAuthorized(tokenId, STRANGER), "stale usage auto-expires on sale (no rights survive a transfer)");
    }

    function testVerifierRotationInvalidatesOutstandingProofs() public {
        bytes memory proof = _sign(VERIFIER_PK, OWNER, SEAL1); // signed under the original verifier + nonce 0
        VM.prank(OWNER);
        id.rebindVerifier(tokenId, VM.addr(0xC0FFEE)); // rotate the oracle -> bumps nonce + rebinds verifier
        VM.prank(OWNER);
        (bool ok,) = address(id).call(abi.encodeWithSelector(id.rebindMetadata.selector, tokenId, SEAL1, proof));
        _t(!ok, "a proof signed before a verifier rotation is dead (nonce advanced + verifier bound into the digest)");
    }

    function testSupportsErc721Interfaces() public view {
        _t(id.supportsInterface(0x01ffc9a7), "erc165");
        _t(id.supportsInterface(0x80ac58cd), "erc721");
        _t(id.supportsInterface(0x5b5e139f), "erc721-metadata");
        _t(!id.supportsInterface(0xffffffff), "not the invalid id");
    }
}
