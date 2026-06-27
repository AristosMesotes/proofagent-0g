// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.26;

import {
    AgentIdentityINFT,
    TEEDataVerifier,
    IERC165,
    IERC721,
    IERC721Metadata,
    IERC7857,
    IERC7857Metadata,
    IERC7857DataVerifier,
    IntelligentData,
    TransferValidityProof,
    AccessProof,
    OwnershipProof,
    OracleType
} from "../src/AgentIdentityINFT.sol";

interface IVm {
    function prank(address sender) external;
}

/// @dev controllable MandateRegistry stand-in for the canSpend value-add (distinct name from the simple test).
contract MockGate {
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

/// @title AgentIdentityINFTTest -- the canonical ERC-7857 conformance + the canSpend value-add (no forge-std).
contract AgentIdentityINFTTest {
    IVm internal constant VM = IVm(address(uint160(uint256(keccak256("hevm cheat code")))));

    AgentIdentityINFT internal id;
    TEEDataVerifier internal oracle;
    MockGate internal mandate;

    address internal constant ISSUER = address(0x15517E5);
    address internal constant OWNER = address(0xA11CE);
    address internal constant BUYER = address(0xB0B);
    address internal constant AGENT = address(0xA6E47);

    bytes32 internal constant MODEL_HASH = keccak256("qwen/qwen2.5-omni-7b");
    bytes32 internal constant SEAL = bytes32(uint256(0x6b51));

    uint256 internal tokenId;

    function setUp() public {
        oracle = new TEEDataVerifier();
        mandate = new MockGate();
        id = new AgentIdentityINFT(ISSUER, oracle);
        VM.prank(ISSUER);
        tokenId = id.mint(OWNER, AGENT, address(mandate), MODEL_HASH, SEAL, "0G Compute model");
    }

    function _t(bool c, string memory w) internal pure {
        require(c, w);
    }

    // --- the headline: ERC-7857 interface conformance (what an AIverse-style indexer detects) ---
    function testAdvertisesCanonicalErc7857Interfaces() public view {
        _t(id.supportsInterface(type(IERC165).interfaceId), "ERC165");
        _t(id.supportsInterface(type(IERC721).interfaceId), "ERC721");
        _t(id.supportsInterface(type(IERC721Metadata).interfaceId), "ERC721Metadata");
        _t(id.supportsInterface(type(IERC7857Metadata).interfaceId), "ERC7857Metadata");
        _t(id.supportsInterface(type(IERC7857).interfaceId), "ERC7857 (the canonical Agentic-ID interface)");
        _t(!id.supportsInterface(0xffffffff), "not the invalid id");
    }

    function testMintSealsTheIntelligentDatas() public view {
        _t(id.ownerOf(tokenId) == OWNER, "owner");
        _t(id.agentOf(tokenId) == AGENT, "agent bound");
        _t(id.mandateOf(tokenId) == address(mandate), "mandate bound");
        IntelligentData[] memory d = id.intelligentDatasOf(tokenId);
        _t(d.length == 2, "two intelligent datas (model + sealed mind)");
        _t(d[0].dataHash == MODEL_HASH, "model hash");
        _t(d[1].dataHash == SEAL, "sealed-mind hash");
        _t(address(id.verifier()) == address(oracle), "verifier() oracle");
    }

    // --- the value-add: canSpend enforces the rails on-chain ---
    function testCanSpendEnforcesTheMandate() public {
        mandate.set(false, bytes32("OVER_TX_CAP"));
        (bool ok, bytes32 reason) = id.canSpend(tokenId, address(0x1), 3_000_000);
        _t(!ok && reason == bytes32("OVER_TX_CAP"), "over-cap blocked");
        mandate.set(true, bytes32("OK"));
        (bool ok2,) = id.canSpend(tokenId, address(0x1), 1_000_000);
        _t(ok2, "in-cap allowed");
    }

    // --- the canonical secure transfer: iTransferFrom validated by the oracle, re-seals the intelligence ---
    function testITransferFromReSealsViaTheOracle() public {
        TransferValidityProof[] memory proofs = _proofsFor(tokenId);
        VM.prank(OWNER);
        id.iTransferFrom(OWNER, BUYER, tokenId, proofs);
        _t(id.ownerOf(tokenId) == BUYER, "ownership moved");
        IntelligentData[] memory d = id.intelligentDatasOf(tokenId);
        // each datum's hash is now the oracle's re-encrypted handle keccak(oldHash, targetPubkey) -- not the old hash
        _t(d[0].dataHash == keccak256(abi.encodePacked(MODEL_HASH, bytes(hex"01"))), "model re-sealed");
        _t(d[1].dataHash == keccak256(abi.encodePacked(SEAL, bytes(hex"01"))), "mind re-sealed");
    }

    function testITransferFromRejectsEmptyProof() public {
        TransferValidityProof[] memory none = new TransferValidityProof[](0);
        VM.prank(OWNER);
        (bool ok,) = address(id).call(abi.encodeWithSelector(id.iTransferFrom.selector, OWNER, BUYER, tokenId, none));
        _t(!ok, "empty proof must revert");
    }

    function testDelegateAccess() public {
        VM.prank(OWNER);
        id.delegateAccess(BUYER);
        _t(id.getDelegateAccess(OWNER) == BUYER, "assistant delegated");
    }

    function _proofsFor(uint256 t) internal view returns (TransferValidityProof[] memory p) {
        IntelligentData[] memory d = id.intelligentDatasOf(t);
        p = new TransferValidityProof[](d.length);
        for (uint256 i = 0; i < d.length; ++i) {
            p[i] = TransferValidityProof({
                accessProof: AccessProof({dataHash: d[i].dataHash, targetPubkey: hex"01", nonce: hex"02", proof: hex"03"}),
                ownershipProof: OwnershipProof({
                    oracleType: OracleType.TEE,
                    dataHash: d[i].dataHash,
                    sealedKey: hex"04",
                    targetPubkey: hex"01",
                    nonce: hex"05",
                    proof: hex"06"
                })
            });
        }
    }
}
