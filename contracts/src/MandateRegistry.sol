// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.26;

/// @title MandateRegistry -- the on-chain spend mandate ("the agent can't overspend" engine).
/// @author CJ (first author) -- SweePoh (second author / support)
/// @notice The Rails proof of ProofAgent-0G (design SS2). A spend mandate enforced ON-CHAIN: a
///         per-transaction cap, optional per-asset sub-caps, a token allowlist, and a hard expiry.
///         The agent calls {checkTransfer} as a zero-gas `eth_call` BEFORE it broadcasts a swap; a
///         `false` verdict is a kill-switch -- the agent does not execute (design SS4 mandate-gate /
///         kill-switch, design SS5 the loop: "a failing mandate verdict means the agent does not
///         execute -- the cap is a kill-switch, enforced before any broadcast").
/// @dev    Design SS3 principle 5 (exact-integer money): every comparison here is exact `uint256`
///         arithmetic in a token's MINOR units -- there is no floating point on the money path.
///         {checkTransfer} is `view` and never reverts: it returns `(ok, reason)` so the caller can
///         gate honestly off-chain. The mutating admin surface is owner-gated (the deployer holds
///         the mandate); ownership can be handed to a multisig/timelock after deploy.
contract MandateRegistry {
    // --------------------------------------------------------------------------------------------
    // Reason codes -- the second return value of {checkTransfer}. A non-zero reason means NOT ok;
    // `REASON_OK` (the zero word) means the transfer is within the mandate. These are stable, ASCII,
    // human-readable bytes32 tags so an off-chain caller / the web UI can render WHY a spend was
    // blocked without a side lookup (design SS3 principle 4: deterministic, journal-friendly form).
    // --------------------------------------------------------------------------------------------

    /// @notice The transfer is within the mandate (the only `ok == true` reason). Equals `bytes32(0)`.
    bytes32 public constant REASON_OK = bytes32(0);
    /// @notice The mandate has been paused (kill-switch engaged) -- no transfer is permitted.
    bytes32 public constant REASON_PAUSED = "PAUSED";
    /// @notice The mandate's `expiry` timestamp has passed -- the mandate is no longer valid.
    bytes32 public constant REASON_EXPIRED = "EXPIRED";
    /// @notice `agent` is not the mandated agent for this registry.
    bytes32 public constant REASON_NOT_AGENT = "NOT_AGENT";
    /// @notice `token` is not on the allowlist (no sub-cap has been set for it).
    bytes32 public constant REASON_TOKEN_NOT_ALLOWED = "TOKEN_NOT_ALLOWED";
    /// @notice `amount` exceeds the global per-transaction cap.
    bytes32 public constant REASON_OVER_TX_CAP = "OVER_TX_CAP";
    /// @notice `amount` exceeds this token's per-asset sub-cap.
    bytes32 public constant REASON_OVER_ASSET_CAP = "OVER_ASSET_CAP";
    /// @notice `amount` is zero -- a no-op spend is never a valid mandated transfer.
    bytes32 public constant REASON_ZERO_AMOUNT = "ZERO_AMOUNT";

    // --------------------------------------------------------------------------------------------
    // State -- the mandate (design SS2: per-tx cap, per-asset sub-caps, allowlist, expiry).
    // --------------------------------------------------------------------------------------------

    /// @notice The mandate owner / admin. Holds the mutating surface (caps, allowlist, pause, expiry).
    address public owner;

    /// @notice The single agent this mandate authorizes. Only this address passes the agent check.
    address public agent;

    /// @notice The global per-transaction cap, in a token's MINOR units. No single transfer may
    ///         exceed this, regardless of token. `0` means "no transfer permitted" (a hard floor).
    uint256 public perTxCap;

    /// @notice The mandate expiry, a unix timestamp (seconds). At or after this time the mandate is
    ///         expired and every transfer is rejected. `type(uint256).max` means "never expires".
    uint256 public expiry;

    /// @notice The kill-switch. While `true`, {checkTransfer} rejects everything with `REASON_PAUSED`.
    bool public paused;

    /// @notice Per-asset sub-cap, in that token's MINOR units. A token is ALLOWLISTED iff
    ///         `allowed[token] == true`. `assetCap[token]` is its sub-cap; the effective per-tx limit
    ///         for an allowed token is `min(perTxCap, assetCap[token])`.
    mapping(address => uint256) public assetCap;

    /// @notice The token allowlist. A transfer of a non-allowlisted token is always rejected.
    mapping(address => bool) public allowed;

    // --------------------------------------------------------------------------------------------
    // Events -- a full audit trail of every mandate change (design SS3 principle 1: the chain is the
    // independent record the verifier reads; the mandate's history is on-chain, not the app's word).
    // --------------------------------------------------------------------------------------------

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event AgentSet(address indexed previousAgent, address indexed newAgent);
    event PerTxCapSet(uint256 previousCap, uint256 newCap);
    event ExpirySet(uint256 previousExpiry, uint256 newExpiry);
    event PausedSet(bool paused);
    event AssetCapSet(address indexed token, uint256 cap, bool allowed);
    event TokenAllowlistSet(address indexed token, bool allowed);

    // --------------------------------------------------------------------------------------------
    // Errors -- the mutating surface reverts (it changes state); {checkTransfer} never does.
    // --------------------------------------------------------------------------------------------

    error NotOwner();
    error ZeroAddress();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    /// @param initialOwner  The mandate admin (the deployer's chosen owner; reverts on the zero addr).
    /// @param initialAgent  The single agent the mandate authorizes (reverts on the zero addr).
    /// @param initialPerTxCap  The global per-transaction cap in minor units.
    /// @param initialExpiry  The mandate expiry (unix seconds); use `type(uint256).max` for "never".
    constructor(
        address initialOwner,
        address initialAgent,
        uint256 initialPerTxCap,
        uint256 initialExpiry
    ) {
        if (initialOwner == address(0) || initialAgent == address(0)) revert ZeroAddress();
        owner = initialOwner;
        agent = initialAgent;
        perTxCap = initialPerTxCap;
        expiry = initialExpiry;
        emit OwnershipTransferred(address(0), initialOwner);
        emit AgentSet(address(0), initialAgent);
        emit PerTxCapSet(0, initialPerTxCap);
        emit ExpirySet(0, initialExpiry);
    }

    // --------------------------------------------------------------------------------------------
    // The gate -- {checkTransfer}. THE load-bearing function (design SS2 Rails). `view`, never
    // reverts, fully deterministic: same chain state + same args -> same `(ok, reason)`.
    // --------------------------------------------------------------------------------------------

    /// @notice Check whether `agent_` may transfer `amount` of `token` under this mandate, WITHOUT
    ///         mutating any state. The agent calls this as a pre-broadcast `eth_call` (zero gas); a
    ///         `false` verdict is the kill-switch and the agent must not execute (design SS5).
    /// @dev    Checks are ordered cheapest-and-most-global first so the returned `reason` names the
    ///         FIRST failing condition deterministically: pause -> expiry -> agent -> zero-amount ->
    ///         allowlist -> per-tx cap -> per-asset sub-cap. All comparisons are exact `uint256`
    ///         integer arithmetic in minor units (design SS3 principle 5: no floating point).
    /// @param agent_  The address proposing the transfer (must equal {agent}).
    /// @param token   The asset to transfer (must be allowlisted).
    /// @param amount  The transfer amount in `token`'s MINOR units.
    /// @return ok      `true` iff the transfer is within the entire mandate.
    /// @return reason  `REASON_OK` (zero) when `ok`; otherwise the first failing reason code.
    function checkTransfer(address agent_, address token, uint256 amount)
        external
        view
        returns (bool ok, bytes32 reason)
    {
        // (1) Kill-switch first: a paused mandate permits nothing (design SS4 kill-switch).
        if (paused) return (false, REASON_PAUSED);

        // (2) Expiry: at OR after the expiry timestamp the mandate is dead. `>=` makes the expiry
        //     instant itself already-expired (a half-open validity window [start, expiry)). An expiry
        //     mandate intrinsically reads `block.timestamp`; a few-seconds validator skew on a
        //     long-lived window is immaterial, and an over-cap spend is independently blocked below.
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp >= expiry) return (false, REASON_EXPIRED);

        // (3) Agent identity: only the mandated agent may spend.
        if (agent_ != agent) return (false, REASON_NOT_AGENT);

        // (4) Zero amount: a no-op spend is never a valid mandated transfer (and would otherwise
        //     pass every cap trivially).
        if (amount == 0) return (false, REASON_ZERO_AMOUNT);

        // (5) Allowlist: the token must be explicitly allowed.
        if (!allowed[token]) return (false, REASON_TOKEN_NOT_ALLOWED);

        // (6) Global per-transaction cap (design SS2: per-tx cap).
        if (amount > perTxCap) return (false, REASON_OVER_TX_CAP);

        // (7) Per-asset sub-cap (design SS2: per-asset sub-caps). The effective limit for an allowed
        //     token is min(perTxCap, assetCap[token]); we've already cleared perTxCap above.
        if (amount > assetCap[token]) return (false, REASON_OVER_ASSET_CAP);

        // Within the entire mandate.
        return (true, REASON_OK);
    }

    // --------------------------------------------------------------------------------------------
    // Admin surface -- owner-gated mutators. These change state and so revert on misuse; the gate
    // ({checkTransfer}) itself is pure-`view` and never reverts.
    // --------------------------------------------------------------------------------------------

    /// @notice Transfer ownership of the mandate (e.g. to a multisig/timelock after deploy).
    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    /// @notice Set the single mandated agent.
    function setAgent(address newAgent) external onlyOwner {
        if (newAgent == address(0)) revert ZeroAddress();
        emit AgentSet(agent, newAgent);
        agent = newAgent;
    }

    /// @notice Set the global per-transaction cap, in minor units.
    function setPerTxCap(uint256 newCap) external onlyOwner {
        emit PerTxCapSet(perTxCap, newCap);
        perTxCap = newCap;
    }

    /// @notice Set the mandate expiry (unix seconds). `type(uint256).max` == never expires.
    function setExpiry(uint256 newExpiry) external onlyOwner {
        emit ExpirySet(expiry, newExpiry);
        expiry = newExpiry;
    }

    /// @notice Engage or release the kill-switch.
    function setPaused(bool newPaused) external onlyOwner {
        paused = newPaused;
        emit PausedSet(newPaused);
    }

    /// @notice Allowlist `token` and set its per-asset sub-cap in one call. Setting `cap` does NOT
    ///         by itself allow the token -- both the allow flag and the sub-cap are written here so
    ///         an allowlisted token always has a defined sub-cap.
    /// @param token  The asset.
    /// @param cap    Its per-asset sub-cap in minor units.
    /// @param isAllowed  Whether the token is on the allowlist.
    function setAssetCap(address token, uint256 cap, bool isAllowed) external onlyOwner {
        if (token == address(0)) revert ZeroAddress();
        assetCap[token] = cap;
        allowed[token] = isAllowed;
        emit AssetCapSet(token, cap, isAllowed);
    }

    /// @notice Toggle a token's allowlist flag without touching its sub-cap.
    function setAllowed(address token, bool isAllowed) external onlyOwner {
        if (token == address(0)) revert ZeroAddress();
        allowed[token] = isAllowed;
        emit TokenAllowlistSet(token, isAllowed);
    }

    // --------------------------------------------------------------------------------------------
    // Views -- read helpers for the agent / web UI.
    // --------------------------------------------------------------------------------------------

    /// @notice The effective per-transaction limit for `token`: `min(perTxCap, assetCap[token])` if
    ///         the token is allowlisted, else `0`. A convenience read; {checkTransfer} is authoritative.
    function effectiveCap(address token) external view returns (uint256) {
        if (!allowed[token]) return 0;
        uint256 sub = assetCap[token];
        return sub < perTxCap ? sub : perTxCap;
    }

    /// @notice `true` iff the mandate is currently live (not paused and not expired). Independent of
    ///         any specific transfer.
    function isActive() external view returns (bool) {
        // forge-lint: disable-next-line(block-timestamp)
        return !paused && block.timestamp < expiry;
    }
}
