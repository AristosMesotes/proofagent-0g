// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.26;

// AgentIdentity -- the ERC-7857 "Agentic ID" iNFT for ProofAgent (the 5th 0G primitive).
//
// Design SS9 (Agentic ID): a launchpad-mintable intelligent-NFT identity that binds, ON-CHAIN, the four facts
// that make ProofAgent a SOVEREIGN, VERIFIABLE agent -- not a generic launchpad token whose iNFT merely wraps
// encrypted metadata:
//   * agent           -- the EOA the agent acts from;
//   * mandate          -- the MandateRegistry that hard-caps its spend (the rails: "can't overspend");
//   * verifier          -- the 0G Compute TEE attestation oracle that signs transfer-validity proofs ("can't lie");
//   * model            -- the attested model that runs inside the enclave (which-model-ran);
//   * sealedMetadata    -- the 0G Storage rootHash of the agent's ENCRYPTED intelligence (the "mind" lives on 0G
//                          Storage, the launchpad/ERC-7857 model; the owner controls access, the chain holds the handle).
//
// The identity does REAL verification work: {canSpend} staticcalls the bound mandate's checkTransfer, so the iNFT
// IS the spend-governed identity (useless without a valid mandate); and a rebind / iTransfer of the "mind" REQUIRES
// a fresh verifier-signed validity proof (the ERC-7857 oracle), checked on-chain with ecrecover -- a genuine check,
// never faked. The TEE/ZKP validation itself happens off-chain in the oracle (a TEE signature can't be re-verified
// in the EVM); the contract enforces that ONLY the verifier's signature authorizes a re-seal (ERC-7857 "oracle
// abstraction"). A nonce + (this, chainid) domain in the digest make proofs single-use and non-portable.
//
// CLEAN-ROOM / OFFLINE (design SS6): zero imported libraries (no OpenZeppelin, no forge-std) -- a self-contained
// minimal ERC-721 + the ERC-7857 surface, solc 0.8.26, warning-free under `deny = warnings`. Honesty doctrine
// (SS3 #3): the contract never lets the identity claim a capability it cannot prove; a plain ERC-721 transfer
// DEACTIVATES the agent until the new owner re-seals under the verifier (the old owner's sealed mind is not theirs).

/// @dev The minimal slice of {MandateRegistryV4} the identity reads to enforce the rails (v2-compatible gate).
interface IMandateGate {
    function checkTransfer(address agent_, address token, uint256 amount)
        external
        view
        returns (bool ok, bytes32 reason);
}

/// @dev ERC-721 receiver hook (for {safeTransferFrom}); declared locally (clean-room, no import).
interface IERC721Receiver {
    function onERC721Received(address operator, address from, uint256 tokenId, bytes calldata data)
        external
        returns (bytes4);
}

/// @title AgentIdentity -- ERC-7857 Agentic-ID iNFT binding the agent's rails + enclave-attested mind on 0G.
/// @notice One token == one sovereign ProofAgent identity. ERC-721-compatible (marketplace/launchpad mintable);
///         extended with the ERC-7857 verifier-gated re-seal so the encrypted "mind" (on 0G Storage) only moves
///         under a validity proof signed by the bound 0G Compute attestation oracle.
contract AgentIdentity {
    // --- ERC-721 metadata (constant; clean-room) -------------------------------------------------
    /// @notice The collection name.
    string public constant name = "ProofAgent Agentic ID";
    /// @notice The collection symbol.
    string public constant symbol = "PAID";

    // --- the bound identity record (the iNFT's "intelligence") -----------------------------------
    /// @param agent          The EOA the agent acts from.
    /// @param mandate        The MandateRegistry that hard-caps this agent's spend (the rails).
    /// @param verifier       The ERC-7857 verifier oracle = the 0G Compute TEE attestation authority (signs proofs).
    /// @param sealedMetadata The 0G Storage rootHash of the agent's encrypted intelligence (the "mind").
    /// @param model          The attested model that runs inside the enclave (e.g. "qwen/qwen2.5-omni-7b").
    /// @param nonce          Monotonic per-token counter; each re-seal/transfer consumes the current nonce.
    /// @param active         True while the current owner's mind is sealed; a plain transfer sets it false.
    struct AgentRecord {
        address agent;
        address mandate;
        address verifier;
        bytes32 sealedMetadata;
        string model;
        uint64 nonce;
        bool active;
    }

    // --- ERC-721 + identity state ----------------------------------------------------------------
    mapping(uint256 => address) private _ownerOf;
    mapping(address => uint256) private _balanceOf;
    mapping(uint256 => address) private _tokenApproval;
    mapping(address => mapping(address => bool)) private _operatorApproval;
    mapping(uint256 => AgentRecord) private _records;
    /// @dev tokenId => user => grant marker (the usage-epoch+1 at which granted; 0 = none). ERC-7857 usage
    ///      rights, granted WITHOUT ownership/metadata access, and AUTO-EXPIRED on any ownership change.
    mapping(uint256 => mapping(address => uint64)) private _usage;
    /// @dev tokenId => current usage epoch; bumped on every ownership change so stale grants self-expire.
    mapping(uint256 => uint64) private _usageEpoch;

    /// @notice The number of identities minted (also the next tokenId; ids are sequential from 1).
    uint256 public totalSupply;
    /// @notice The issuer authorized to mint identities (the launchpad/deployer). Two-step transferable.
    address public issuer;
    /// @notice A pending issuer that must {acceptIssuer} (two-step handover; no key-loss footgun).
    address public pendingIssuer;

    // --- events ----------------------------------------------------------------------------------
    /// @notice ERC-721 Transfer.
    event Transfer(address indexed from, address indexed to, uint256 indexed tokenId);
    /// @notice ERC-721 Approval.
    event Approval(address indexed owner, address indexed approved, uint256 indexed tokenId);
    /// @notice ERC-721 ApprovalForAll.
    event ApprovalForAll(address indexed owner, address indexed operator, bool approved);
    /// @notice A new Agentic ID was minted with its full binding.
    event AgentMinted(uint256 indexed tokenId, address indexed to, address agent, address mandate, address verifier);
    /// @notice The encrypted mind was re-sealed (mint, rebind, or verifier-gated transfer) -- the new 0G Storage handle.
    event MetadataResealed(uint256 indexed tokenId, bytes32 sealedMetadata, uint64 nonce);
    /// @notice A plain ERC-721 transfer deactivated the agent until the new owner re-seals under the verifier.
    event AgentDeactivated(uint256 indexed tokenId, address indexed newOwner);
    /// @notice The bound mandate (rails) was rotated by the owner.
    event MandateRebound(uint256 indexed tokenId, address indexed mandate);
    /// @notice The verifier oracle (TEE attestation authority) was rotated by the owner.
    event VerifierRebound(uint256 indexed tokenId, address indexed verifier);
    /// @notice ERC-7857 usage rights granted/revoked (no ownership, no metadata access).
    event UsageAuthorized(uint256 indexed tokenId, address indexed user, bool allowed);
    /// @notice Issuer handover (two-step).
    event IssuerTransferStarted(address indexed from, address indexed to);
    event IssuerTransferred(address indexed from, address indexed to);

    // --- errors ----------------------------------------------------------------------------------
    error NotIssuer();
    error NotPendingIssuer();
    error ZeroAddress();
    error NonexistentToken();
    error NotOwnerNorApproved();
    error WrongFrom();
    error AlreadyMinted();
    error BadProof();
    error InactiveAgent();
    error UnsafeRecipient();

    // --- constructor -----------------------------------------------------------------------------
    /// @param issuer_ The address authorized to mint identities (the launchpad/deployer). Non-zero.
    constructor(address issuer_) {
        if (issuer_ == address(0)) revert ZeroAddress();
        issuer = issuer_;
    }

    modifier onlyIssuer() {
        if (msg.sender != issuer) revert NotIssuer();
        _;
    }

    // --- ERC-165 ---------------------------------------------------------------------------------
    /// @notice ERC-165: ERC-721 (0x80ac58cd), ERC-721 Metadata (0x5b5e139f), ERC-165 (0x01ffc9a7).
    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == 0x01ffc9a7 || interfaceId == 0x80ac58cd || interfaceId == 0x5b5e139f;
    }

    // --- ERC-721 views ---------------------------------------------------------------------------
    /// @notice The owner of `tokenId` (reverts if it does not exist).
    function ownerOf(uint256 tokenId) public view returns (address owner) {
        owner = _ownerOf[tokenId];
        if (owner == address(0)) revert NonexistentToken();
    }

    /// @notice The number of identities held by `owner`.
    function balanceOf(address owner) external view returns (uint256) {
        if (owner == address(0)) revert ZeroAddress();
        return _balanceOf[owner];
    }

    /// @notice The single-token approval for `tokenId`.
    function getApproved(uint256 tokenId) external view returns (address) {
        if (_ownerOf[tokenId] == address(0)) revert NonexistentToken();
        return _tokenApproval[tokenId];
    }

    /// @notice Whether `operator` is an approved operator for all of `owner`'s tokens.
    function isApprovedForAll(address owner, address operator) external view returns (bool) {
        return _operatorApproval[owner][operator];
    }

    /// @notice The metadata URI -- a 0G Storage reference to the sealed mind (the launchpad resolves it).
    function tokenURI(uint256 tokenId) external view returns (string memory) {
        AgentRecord storage r = _records[tokenId];
        if (_ownerOf[tokenId] == address(0)) revert NonexistentToken();
        return string.concat("https://storagescan-galileo.0g.ai/tx/0x", _toHex(r.sealedMetadata));
    }

    // --- ERC-721 approvals -----------------------------------------------------------------------
    /// @notice Approve `to` to transfer `tokenId` (owner or operator only).
    function approve(address to, uint256 tokenId) external {
        address owner = ownerOf(tokenId);
        if (msg.sender != owner && !_operatorApproval[owner][msg.sender]) revert NotOwnerNorApproved();
        _tokenApproval[tokenId] = to;
        emit Approval(owner, to, tokenId);
    }

    /// @notice Grant/revoke `operator` over all of the caller's tokens.
    function setApprovalForAll(address operator, bool approved) external {
        _operatorApproval[msg.sender][operator] = approved;
        emit ApprovalForAll(msg.sender, operator, approved);
    }

    // --- ERC-721 transfers (marketplace-compatible; CEI, no reentrancy surface) ------------------
    /// @notice Standard ERC-721 transfer. It moves OWNERSHIP but DEACTIVATES the agent: the old owner's sealed
    ///         mind is not the new owner's, so {active} goes false until the new owner re-seals under the
    ///         verifier via {rebindMetadata} (or uses {iTransferFrom} to transfer + re-seal atomically). Honest
    ///         by construction -- the identity never claims a live, owned mind it cannot prove (design SS3 #3).
    function transferFrom(address from, address to, uint256 tokenId) public {
        _transfer(from, to, tokenId);
        AgentRecord storage r = _records[tokenId];
        if (r.active) {
            r.active = false;
            emit AgentDeactivated(tokenId, to);
        }
    }

    /// @notice {transferFrom} + the ERC-721 receiver check.
    function safeTransferFrom(address from, address to, uint256 tokenId) external {
        safeTransferFrom(from, to, tokenId, "");
    }

    /// @notice {transferFrom} + the ERC-721 receiver check, with `data`.
    function safeTransferFrom(address from, address to, uint256 tokenId, bytes memory data) public {
        transferFrom(from, to, tokenId); // effects first (CEI)
        _checkReceiver(from, to, tokenId, data);
    }

    // --- ERC-7857: the verifier-gated mind transfer / re-seal ------------------------------------
    /// @notice ERC-7857 transfer: move ownership AND re-seal the mind to `newSealedMetadata` ATOMICALLY, gated by
    ///         a fresh validity `proof` signed by the token's verifier oracle (the 0G Compute attestation
    ///         authority). The new owner ends ACTIVE with their own sealed mind. `proof` = abi.encode(v, r, s)
    ///         over the EIP-191 digest of (this, chainid, tokenId, to, newSealedMetadata, nonce) -- single-use.
    function iTransferFrom(
        address from,
        address to,
        uint256 tokenId,
        bytes32 newSealedMetadata,
        bytes calldata proof
    ) external {
        _verifyProof(tokenId, to, newSealedMetadata, proof);
        _transfer(from, to, tokenId);
        _reseal(tokenId, newSealedMetadata);
    }

    /// @notice Re-seal the mind of a token you own to `newSealedMetadata` (after a plain transfer, or to rotate
    ///         the mind), gated by a fresh verifier-signed `proof`. Re-activates the agent. The proof binds `to`
    ///         = the current owner (the re-encryption target), so a stale proof cannot be replayed.
    function rebindMetadata(uint256 tokenId, bytes32 newSealedMetadata, bytes calldata proof) external {
        address owner = ownerOf(tokenId);
        if (msg.sender != owner) revert NotOwnerNorApproved();
        _verifyProof(tokenId, owner, newSealedMetadata, proof);
        _reseal(tokenId, newSealedMetadata);
    }

    /// @notice ERC-7857 usage delegation: grant/revoke `user` the right to USE the agent (off-chain) without
    ///         transferring ownership or exposing the sealed metadata. Owner-only.
    function authorizeUsage(uint256 tokenId, address user, bool allowed) external {
        if (msg.sender != ownerOf(tokenId)) revert NotOwnerNorApproved();
        // Tie the grant to the CURRENT usage epoch (epoch+1; 0 = none), so any later sale auto-expires it.
        _usage[tokenId][user] = allowed ? _usageEpoch[tokenId] + 1 : 0;
        emit UsageAuthorized(tokenId, user, allowed);
    }

    // --- mint (issuer-gated) ---------------------------------------------------------------------
    /// @notice Mint a new Agentic ID with its full binding. Issuer-only (the launchpad/deployer vouches for the
    ///         initial mind). The first real verifier-gated re-seal can rotate the mind later.
    /// @return tokenId The freshly-minted identity id (sequential from 1).
    function mint(
        address to,
        address agent,
        address mandate,
        address verifier,
        bytes32 sealedMetadata,
        string calldata model
    ) external onlyIssuer returns (uint256 tokenId) {
        if (to == address(0) || agent == address(0) || mandate == address(0) || verifier == address(0)) {
            revert ZeroAddress();
        }
        tokenId = ++totalSupply;
        _ownerOf[tokenId] = to;
        unchecked {
            ++_balanceOf[to];
        }
        _records[tokenId] = AgentRecord({
            agent: agent,
            mandate: mandate,
            verifier: verifier,
            sealedMetadata: sealedMetadata,
            model: model,
            nonce: 0,
            active: true
        });
        emit Transfer(address(0), to, tokenId);
        emit AgentMinted(tokenId, to, agent, mandate, verifier);
        emit MetadataResealed(tokenId, sealedMetadata, 0);
    }

    // --- owner identity-field rotations ----------------------------------------------------------
    /// @notice Rotate the bound mandate (rails) for a token you own -- e.g. upgrade to a hardened MandateRegistry.
    ///         Owner sovereignty: a viewer reads WHICH mandate is bound via {recordOf}; {canSpend} always reflects
    ///         the live bound mandate (never a fabricated allow), so a weaker mandate is visible, not hidden.
    function rebindMandate(uint256 tokenId, address mandate) external {
        if (msg.sender != ownerOf(tokenId)) revert NotOwnerNorApproved();
        if (mandate == address(0)) revert ZeroAddress();
        _records[tokenId].mandate = mandate;
        emit MandateRebound(tokenId, mandate);
    }

    /// @notice Rotate the verifier oracle (TEE attestation authority) for a token you own. Owner sovereignty: a
    ///         viewer must re-check {verifierOf} after a transfer. Advancing the nonce here INVALIDATES every proof
    ///         signed under the old verifier -- no withheld proof survives a rotation.
    function rebindVerifier(uint256 tokenId, address verifier) external {
        if (msg.sender != ownerOf(tokenId)) revert NotOwnerNorApproved();
        if (verifier == address(0)) revert ZeroAddress();
        AgentRecord storage r = _records[tokenId];
        r.verifier = verifier;
        unchecked {
            ++r.nonce; // any outstanding proof (bound to the old verifier + old nonce) is now dead
        }
        emit VerifierRebound(tokenId, verifier);
    }

    // --- the REAL work: the identity enforces its rails ------------------------------------------
    /// @notice Ask the iNFT whether its agent may spend `amount` of `token` RIGHT NOW, by staticcalling the
    ///         bound mandate's checkTransfer. This is what makes the identity do real work: it IS the
    ///         spend-governed agent. Fails CLOSED -- an inactive agent, a missing/again-reverting mandate, or
    ///         a malformed return all yield `(false, reason)`, never a fabricated allow (design SS3 #3).
    /// @return ok     True only if the agent is active AND the live mandate permits the spend.
    /// @return reason A mandate reason code, or a local code (INACTIVE / NO_MANDATE) when it fails closed.
    function canSpend(uint256 tokenId, address token, uint256 amount)
        external
        view
        returns (bool ok, bytes32 reason)
    {
        AgentRecord storage r = _records[tokenId];
        if (_ownerOf[tokenId] == address(0)) revert NonexistentToken();
        if (!r.active) return (false, "INACTIVE");
        (bool success, bytes memory ret) = r.mandate.staticcall(
            abi.encodeWithSelector(IMandateGate.checkTransfer.selector, r.agent, token, amount)
        );
        if (!success || ret.length < 64) return (false, "NO_MANDATE");
        return abi.decode(ret, (bool, bytes32));
    }

    // --- identity getters ------------------------------------------------------------------------
    /// @notice The full bound record for `tokenId`.
    function recordOf(uint256 tokenId) external view returns (AgentRecord memory) {
        if (_ownerOf[tokenId] == address(0)) revert NonexistentToken();
        return _records[tokenId];
    }

    /// @notice ERC-7857 verifier(): the oracle (0G Compute attestation authority) for `tokenId`.
    function verifierOf(uint256 tokenId) external view returns (address) {
        if (_ownerOf[tokenId] == address(0)) revert NonexistentToken();
        return _records[tokenId].verifier;
    }

    /// @notice Whether `user` has been granted off-chain usage rights for `tokenId`.
    function usageAuthorized(uint256 tokenId, address user) external view returns (bool) {
        // A grant is live only at the token's CURRENT usage epoch -- a sale bumps the epoch + voids old grants.
        return _usage[tokenId][user] == _usageEpoch[tokenId] + 1;
    }

    /// @notice The next single-use proof nonce a verifier must sign over for `tokenId` (re-seal / iTransfer).
    function nonceOf(uint256 tokenId) external view returns (uint64) {
        if (_ownerOf[tokenId] == address(0)) revert NonexistentToken();
        return _records[tokenId].nonce;
    }

    /// @notice The EIP-191 digest a verifier signs to authorize re-sealing `tokenId` to `to`/`newSealedMetadata`
    ///         at the current nonce. Exposed so the off-chain oracle signs EXACTLY what the contract checks.
    function proofDigest(uint256 tokenId, address to, bytes32 newSealedMetadata) public view returns (bytes32) {
        AgentRecord storage r = _records[tokenId];
        // Bind the VERIFIER into the digest (so rotating the oracle invalidates outstanding proofs) alongside the
        // (this, chainid) domain, the tokenId, the target owner, the new handle, and the single-use nonce.
        bytes32 inner =
            keccak256(abi.encode(address(this), block.chainid, tokenId, r.verifier, to, newSealedMetadata, r.nonce));
        return keccak256(abi.encodePacked("\x19Ethereum Signed Message\n32", inner));
    }

    // --- issuer handover (two-step) --------------------------------------------------------------
    /// @notice Begin transferring the mint authority to `newIssuer` (it must {acceptIssuer}).
    function transferIssuer(address newIssuer) external onlyIssuer {
        if (newIssuer == address(0)) revert ZeroAddress();
        pendingIssuer = newIssuer;
        emit IssuerTransferStarted(issuer, newIssuer);
    }

    /// @notice Complete the issuer handover (only the pending issuer, proving liveness).
    function acceptIssuer() external {
        if (msg.sender != pendingIssuer) revert NotPendingIssuer();
        address prev = issuer;
        issuer = pendingIssuer;
        pendingIssuer = address(0);
        emit IssuerTransferred(prev, msg.sender);
    }

    // --- internals -------------------------------------------------------------------------------
    /// @dev Core ERC-721 ownership move: checks existence, `from`, and caller authorization; updates balances.
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
            ++_usageEpoch[tokenId]; // void all prior usage grants on any ownership change (the sold mind isn't theirs)
        }
        _ownerOf[tokenId] = to;
        emit Transfer(from, to, tokenId);
    }

    /// @dev Apply a re-seal: bump the (single-use) nonce, store the new 0G Storage handle, re-activate.
    function _reseal(uint256 tokenId, bytes32 newSealedMetadata) private {
        AgentRecord storage r = _records[tokenId];
        unchecked {
            ++r.nonce;
        }
        r.sealedMetadata = newSealedMetadata;
        r.active = true;
        emit MetadataResealed(tokenId, newSealedMetadata, r.nonce);
    }

    /// @dev Verify a validity `proof` is a verifier signature over the current digest. ecrecover with the
    ///      low-s + v∈{27,28} guards (no malleability); the nonce + (this, chainid) domain make it single-use.
    function _verifyProof(uint256 tokenId, address to, bytes32 newSealedMetadata, bytes calldata proof) private view {
        address verifier = _records[tokenId].verifier;
        if (verifier == address(0)) revert NonexistentToken();
        if (proof.length != 96) revert BadProof();
        (uint8 v, bytes32 r, bytes32 s) = abi.decode(proof, (uint8, bytes32, bytes32));
        if (uint256(s) > 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0) revert BadProof();
        if (v != 27 && v != 28) revert BadProof();
        address signer = ecrecover(proofDigest(tokenId, to, newSealedMetadata), v, r, s);
        if (signer == address(0) || signer != verifier) revert BadProof();
    }

    /// @dev ERC-721 safe-receiver check (after the ownership effects -- CEI). EOAs are always safe.
    function _checkReceiver(address from, address to, uint256 tokenId, bytes memory data) private {
        if (to.code.length == 0) return;
        bytes4 ret = IERC721Receiver(to).onERC721Received(msg.sender, from, tokenId, data);
        if (ret != IERC721Receiver.onERC721Received.selector) revert UnsafeRecipient();
    }

    /// @dev Lower-case hex of a bytes32 (for {tokenURI}); self-contained (clean-room, no library).
    function _toHex(bytes32 value) private pure returns (string memory) {
        bytes16 alphabet = 0x30313233343536373839616263646566; // "0123456789abcdef"
        bytes memory out = new bytes(64);
        for (uint256 i = 0; i < 32; ++i) {
            uint8 b = uint8(value[i]);
            out[i * 2] = alphabet[b >> 4];
            out[i * 2 + 1] = alphabet[b & 0x0f];
        }
        return string(out);
    }
}
