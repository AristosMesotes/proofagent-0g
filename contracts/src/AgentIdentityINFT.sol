// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.26;

// AgentIdentityINFT -- the CANONICAL ERC-7857 "Agentic ID" iNFT for ProofAgent, AIverse-marketplace conformant.
//
// Design SS9 (Agentic ID): a fully ERC-7857-conformant intelligent-NFT (it returns true for the canonical
// IERC7857 / IERC7857Metadata interface IDs via {supportsInterface}, so an interface-detecting indexer -- e.g.
// the 0G AIverse catalog -- recognises it). It implements the canonical surface verbatim: `verifier()`,
// `iTransferFrom(from, to, tokenId, TransferValidityProof[])`, `delegateAccess`, `getDelegateAccess`,
// `intelligentDatasOf`, and the `Updated` / `PublishedSealedKey` / `DelegateAccess` events -- AND keeps
// ProofAgent's value-add the field lacks: `canSpend` staticcalls a live mandate so the iNFT ENFORCES its
// own spend cap on-chain (over-cap -> OVER_TX_CAP). Clean-room: every interface + struct is declared inline
// (NO OpenZeppelin import), solc 0.8.26, warning-free. The TEE/ZKP cryptographic validation is the off-chain
// oracle's job ({IERC7857DataVerifier.verifyTransferValidity}); the contract enforces that ONLY that oracle's
// validated output can re-seal + move a token's intelligence -- never fabricated (honesty doctrine, SS3 #3).

// ── canonical ERC-7857 interfaces + structs (clean-room; mirrors 0gfoundation/0g-agent-nft) ───────────
interface IERC165 {
    function supportsInterface(bytes4 interfaceId) external view returns (bool);
}

interface IERC721 is IERC165 {
    event Transfer(address indexed from, address indexed to, uint256 indexed tokenId);
    event Approval(address indexed owner, address indexed approved, uint256 indexed tokenId);
    event ApprovalForAll(address indexed owner, address indexed operator, bool approved);

    function balanceOf(address owner) external view returns (uint256);
    function ownerOf(uint256 tokenId) external view returns (address);
    function safeTransferFrom(address from, address to, uint256 tokenId, bytes calldata data) external;
    function safeTransferFrom(address from, address to, uint256 tokenId) external;
    function transferFrom(address from, address to, uint256 tokenId) external;
    function approve(address to, uint256 tokenId) external;
    function setApprovalForAll(address operator, bool approved) external;
    function getApproved(uint256 tokenId) external view returns (address);
    function isApprovedForAll(address owner, address operator) external view returns (bool);
}

interface IERC721Metadata is IERC721 {
    function name() external view returns (string memory);
    function symbol() external view returns (string memory);
    function tokenURI(uint256 tokenId) external view returns (string memory);
}

enum OracleType {
    TEE,
    ZKP
}

struct AccessProof {
    bytes32 dataHash;
    bytes targetPubkey;
    bytes nonce;
    bytes proof;
}

struct OwnershipProof {
    OracleType oracleType;
    bytes32 dataHash;
    bytes sealedKey;
    bytes targetPubkey;
    bytes nonce;
    bytes proof;
}

struct TransferValidityProof {
    AccessProof accessProof;
    OwnershipProof ownershipProof;
}

struct TransferValidityProofOutput {
    bytes32 dataHash;
    bytes sealedKey;
    bytes targetPubkey;
    bytes wantedKey;
    address accessAssistant;
    bytes accessProofNonce;
    bytes ownershipProofNonce;
}

interface IERC7857DataVerifier {
    function verifyTransferValidity(TransferValidityProof[] calldata proofs)
        external
        returns (TransferValidityProofOutput[] memory);
}

struct IntelligentData {
    string dataDescription;
    bytes32 dataHash;
}

interface IERC7857Metadata is IERC721Metadata {
    function intelligentDatasOf(uint256 tokenId) external view returns (IntelligentData[] memory);
}

interface IERC7857 is IERC721, IERC7857Metadata {
    event Updated(uint256 indexed tokenId, IntelligentData[] oldDatas, IntelligentData[] newDatas);
    event PublishedSealedKey(address indexed to, uint256 indexed tokenId, bytes[] sealedKeys);
    event DelegateAccess(address indexed user, address indexed assistant);

    function verifier() external view returns (IERC7857DataVerifier);
    function iTransferFrom(address from, address to, uint256 tokenId, TransferValidityProof[] calldata proofs)
        external;
    function delegateAccess(address assistant) external;
    function getDelegateAccess(address user) external view returns (address);
}

/// @dev ProofAgent's value-add: the mandate the iNFT enforces (the v2-compatible gate of MandateRegistryV4).
interface IMandateGate {
    function checkTransfer(address agent_, address token, uint256 amount)
        external
        view
        returns (bool ok, bytes32 reason);
}

/// @dev ERC-721 receiver hook (for safeTransferFrom); declared locally (clean-room).
interface IERC721Receiver {
    function onERC721Received(address operator, address from, uint256 tokenId, bytes calldata data)
        external
        returns (bytes4);
}

/// @title AgentIdentityINFT -- the canonical, AIverse-conformant ERC-7857 Agentic ID (+ on-chain spend enforcement).
contract AgentIdentityINFT is IERC7857 {
    // --- ERC-721 metadata ---
    string public constant name = "ProofAgent Agentic ID";
    string public constant symbol = "PAID";

    // --- ProofAgent binding (the value-add) ---
    /// @notice The EOA the agent acts from (the spend-governed principal).
    mapping(uint256 => address) public agentOf;
    /// @notice The MandateRegistry that hard-caps this agent's spend (the rails).
    mapping(uint256 => address) public mandateOf;

    // --- ERC-7857 state ---
    /// @notice The contract-level verifier oracle (TEE/ZKP) that validates transfer-validity proofs.
    IERC7857DataVerifier public immutable VERIFIER;
    mapping(uint256 => IntelligentData[]) private _intelligentDatas;
    mapping(address => address) private _delegate;

    // --- ERC-721 storage ---
    mapping(uint256 => address) private _ownerOf;
    mapping(address => uint256) private _balanceOf;
    mapping(uint256 => address) private _tokenApproval;
    mapping(address => mapping(address => bool)) private _operatorApproval;

    /// @notice Sequential token count / next id (from 1).
    uint256 public totalSupply;
    /// @notice The mint authority (the launchpad / deployer).
    address public issuer;

    error NotIssuer();
    error ZeroAddress();
    error NonexistentToken();
    error NotOwnerNorApproved();
    error WrongFrom();
    error UnsafeRecipient();
    error ERC7857InvalidAssistant(address assistant);
    error ERC7857EmptyProof();
    error ERC7857ProofCountMismatch();
    error ERC7857DataHashMismatch();

    /// @notice A new Agentic ID was minted with its binding (mirrors {AgentMinted} on the simple variant).
    event AgentMinted(uint256 indexed tokenId, address indexed to, address agent, address mandate);

    constructor(address issuer_, IERC7857DataVerifier verifier_) {
        if (issuer_ == address(0) || address(verifier_) == address(0)) revert ZeroAddress();
        issuer = issuer_;
        VERIFIER = verifier_;
    }

    modifier onlyIssuer() {
        if (msg.sender != issuer) revert NotIssuer();
        _;
    }

    // --- ERC-165: advertise the canonical ERC-7857 interface IDs (this is what an indexer detects) ---
    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == type(IERC165).interfaceId || interfaceId == type(IERC721).interfaceId
            || interfaceId == type(IERC721Metadata).interfaceId || interfaceId == type(IERC7857Metadata).interfaceId
            || interfaceId == type(IERC7857).interfaceId;
    }

    // --- ERC-7857 surface ---
    /// @inheritdoc IERC7857
    function verifier() external view returns (IERC7857DataVerifier) {
        return VERIFIER;
    }

    /// @inheritdoc IERC7857Metadata
    function intelligentDatasOf(uint256 tokenId) external view returns (IntelligentData[] memory) {
        if (_ownerOf[tokenId] == address(0)) revert NonexistentToken();
        return _intelligentDatas[tokenId];
    }

    /// @notice ERC-7857 secure transfer: move ownership AND re-seal the agent's intelligence, gated by the
    ///         verifier oracle. The oracle's validated outputs (the re-encrypted data hashes for the receiver)
    ///         replace the token's IntelligentData -- the "mind" moves under enclave/ZK-validated re-encryption.
    function iTransferFrom(address from, address to, uint256 tokenId, TransferValidityProof[] calldata proofs)
        external
    {
        if (proofs.length == 0) revert ERC7857EmptyProof();
        IntelligentData[] storage datas = _intelligentDatas[tokenId];
        if (proofs.length != datas.length) revert ERC7857ProofCountMismatch();
        // The oracle validates the proofs (TEE/ZKP) and returns the re-encrypted data for `to`.
        TransferValidityProofOutput[] memory outs = VERIFIER.verifyTransferValidity(proofs);
        if (outs.length != datas.length) revert ERC7857ProofCountMismatch();

        IntelligentData[] memory oldDatas = _intelligentDatas[tokenId];
        bytes[] memory sealedKeys = new bytes[](outs.length);
        for (uint256 i = 0; i < outs.length; ++i) {
            // Each old datum's hash must match the proof's claimed old hash (no swapping a different mind in).
            if (proofs[i].ownershipProof.dataHash != datas[i].dataHash) revert ERC7857DataHashMismatch();
            datas[i].dataHash = outs[i].dataHash; // the re-encrypted handle for the new owner
            sealedKeys[i] = outs[i].sealedKey;
        }
        _transfer(from, to, tokenId); // checks caller auth + from == owner
        emit Updated(tokenId, oldDatas, _intelligentDatas[tokenId]);
        emit PublishedSealedKey(to, tokenId, sealedKeys);
    }

    /// @inheritdoc IERC7857
    function delegateAccess(address assistant) external {
        if (assistant == address(0)) revert ERC7857InvalidAssistant(assistant);
        _delegate[msg.sender] = assistant;
        emit DelegateAccess(msg.sender, assistant);
    }

    /// @inheritdoc IERC7857
    function getDelegateAccess(address user) external view returns (address) {
        return _delegate[user];
    }

    // --- mint (issuer-gated) ---
    /// @notice Mint a new conformant Agentic ID: binds the agent EOA + the MandateRegistry, and seals the
    ///         initial intelligence (the model + the 0G Storage mind handle) as ERC-7857 IntelligentData.
    function mint(
        address to,
        address agent,
        address mandate,
        bytes32 modelHash,
        bytes32 sealedMind,
        string calldata modelDescription
    ) external onlyIssuer returns (uint256 tokenId) {
        if (to == address(0) || agent == address(0) || mandate == address(0)) revert ZeroAddress();
        tokenId = ++totalSupply;
        _ownerOf[tokenId] = to;
        unchecked {
            ++_balanceOf[to];
        }
        agentOf[tokenId] = agent;
        mandateOf[tokenId] = mandate;
        _intelligentDatas[tokenId].push(IntelligentData({dataDescription: modelDescription, dataHash: modelHash}));
        _intelligentDatas[tokenId].push(
            IntelligentData({dataDescription: "sealed mind (0G Storage rootHash)", dataHash: sealedMind})
        );
        emit Transfer(address(0), to, tokenId);
        emit AgentMinted(tokenId, to, agent, mandate);
    }

    // --- the REAL work (ProofAgent's value-add): the iNFT enforces its rails on-chain ---
    /// @notice Whether the agent bound to `tokenId` may spend `amount` of `token` NOW, by staticcalling its
    ///         mandate. Fails CLOSED (no mandate / malformed return -> (false, "NO_MANDATE")); never a fake allow.
    function canSpend(uint256 tokenId, address token, uint256 amount) external view returns (bool ok, bytes32 reason) {
        if (_ownerOf[tokenId] == address(0)) revert NonexistentToken();
        (bool success, bytes memory ret) =
            mandateOf[tokenId].staticcall(abi.encodeWithSelector(IMandateGate.checkTransfer.selector, agentOf[tokenId], token, amount));
        if (!success || ret.length < 64) return (false, "NO_MANDATE");
        return abi.decode(ret, (bool, bytes32));
    }

    // --- ERC-721 views ---
    function ownerOf(uint256 tokenId) public view returns (address owner) {
        owner = _ownerOf[tokenId];
        if (owner == address(0)) revert NonexistentToken();
    }

    function balanceOf(address owner) external view returns (uint256) {
        if (owner == address(0)) revert ZeroAddress();
        return _balanceOf[owner];
    }

    function getApproved(uint256 tokenId) external view returns (address) {
        if (_ownerOf[tokenId] == address(0)) revert NonexistentToken();
        return _tokenApproval[tokenId];
    }

    function isApprovedForAll(address owner, address operator) external view returns (bool) {
        return _operatorApproval[owner][operator];
    }

    function tokenURI(uint256 tokenId) external view returns (string memory) {
        if (_ownerOf[tokenId] == address(0)) revert NonexistentToken();
        // The sealed mind (the 2nd intelligent datum) is a 0G Storage rootHash; the metadata resolves there.
        return string.concat("https://storagescan-galileo.0g.ai/tx/0x", _toHex(_intelligentDatas[tokenId][1].dataHash));
    }

    // --- ERC-721 mutators ---
    function approve(address to, uint256 tokenId) external {
        address owner = ownerOf(tokenId);
        if (msg.sender != owner && !_operatorApproval[owner][msg.sender]) revert NotOwnerNorApproved();
        _tokenApproval[tokenId] = to;
        emit Approval(owner, to, tokenId);
    }

    function setApprovalForAll(address operator, bool approved) external {
        _operatorApproval[msg.sender][operator] = approved;
        emit ApprovalForAll(msg.sender, operator, approved);
    }

    function transferFrom(address from, address to, uint256 tokenId) public {
        _transfer(from, to, tokenId);
    }

    function safeTransferFrom(address from, address to, uint256 tokenId) external {
        safeTransferFrom(from, to, tokenId, "");
    }

    function safeTransferFrom(address from, address to, uint256 tokenId, bytes memory data) public {
        transferFrom(from, to, tokenId);
        if (to.code.length != 0) {
            if (IERC721Receiver(to).onERC721Received(msg.sender, from, tokenId, data) != IERC721Receiver.onERC721Received.selector) {
                revert UnsafeRecipient();
            }
        }
    }

    // --- internals ---
    function _transfer(address from, address to, uint256 tokenId) private {
        if (to == address(0)) revert ZeroAddress();
        address owner = _ownerOf[tokenId];
        if (owner == address(0)) revert NonexistentToken();
        if (owner != from) revert WrongFrom();
        if (msg.sender != owner && msg.sender != _tokenApproval[tokenId] && !_operatorApproval[owner][msg.sender]) {
            revert NotOwnerNorApproved();
        }
        delete _tokenApproval[tokenId];
        unchecked {
            --_balanceOf[from];
            ++_balanceOf[to];
        }
        _ownerOf[tokenId] = to;
        emit Transfer(from, to, tokenId);
    }

    function _toHex(bytes32 value) private pure returns (string memory) {
        bytes16 alphabet = 0x30313233343536373839616263646566;
        bytes memory out = new bytes(64);
        for (uint256 i = 0; i < 32; ++i) {
            uint8 b = uint8(value[i]);
            out[i * 2] = alphabet[b >> 4];
            out[i * 2 + 1] = alphabet[b & 0x0f];
        }
        return string(out);
    }
}

/// @title TEEDataVerifier -- a minimal on-chain IERC7857DataVerifier (the TEE/ZKP oracle's on-chain relay).
/// @notice The heavy cryptographic validation (TEE attestation / ZK proof) happens OFF-CHAIN; this on-chain
///         oracle structurally checks each proof (non-empty, well-formed) and returns the validated output the
///         iNFT applies. A real deployment points {AgentIdentityINFT.VERIFIER} at the production 0G oracle; this
///         clean-room verifier makes the conformant flow runnable + testable end-to-end without external deps.
contract TEEDataVerifier is IERC7857DataVerifier {
    error EmptyProof();
    error MalformedProof();

    function verifyTransferValidity(TransferValidityProof[] calldata proofs)
        external
        pure
        returns (TransferValidityProofOutput[] memory outs)
    {
        if (proofs.length == 0) revert EmptyProof();
        outs = new TransferValidityProofOutput[](proofs.length);
        for (uint256 i = 0; i < proofs.length; ++i) {
            OwnershipProof calldata op = proofs[i].ownershipProof;
            AccessProof calldata ap = proofs[i].accessProof;
            // Structural validity: a real proof + sealed key + the receiver's target pubkey must be present, and
            // the access proof must reference the same data. (The cryptographic check is the off-chain oracle's.)
            if (op.proof.length == 0 || op.sealedKey.length == 0 || ap.targetPubkey.length == 0) revert MalformedProof();
            if (ap.dataHash != op.dataHash) revert MalformedProof();
            outs[i] = TransferValidityProofOutput({
                dataHash: keccak256(abi.encodePacked(op.dataHash, ap.targetPubkey)), // the re-encrypted handle for the receiver
                sealedKey: op.sealedKey,
                targetPubkey: ap.targetPubkey,
                wantedKey: ap.targetPubkey,
                accessAssistant: address(0),
                accessProofNonce: ap.nonce,
                ownershipProofNonce: op.nonce
            });
        }
    }
}
