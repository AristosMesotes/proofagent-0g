// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.26;

/// @title SettlementOracle -- the HONEST on-chain settlement gate for cross-chain intents.
///
/// @notice The on-chain half of the Filler capstone (the LI.FI-Intents frontier). An intent
///         protocol releases a solver's locked funds ONLY after an oracle proves the destination
///         fill actually delivered. A hash-only oracle pays whatever it is *told* proved -- it pays
///         a HOLLOW fill (a fill the chain says delivered nothing). This oracle does not: an
///         off-chain verifier INDEPENDENTLY reads the destination chain and mints a four-verdict
///         result; this contract is the gate an Input Settler calls before releasing the solver,
///         and it releases ONLY on {Verdict.Settled}.
///
/// @dev    HONESTY DOCTRINE -- four load-bearing invariants, each mirrored from the off-chain
///         verifier's `FillDecision` (RELEASE only on `Settled`):
///           1. FAIL-CLOSED DEFAULT. {Verdict.Unverified} is ordinal 0, so an un-attested fill id
///              defaults to `Unverified`. A fill that nobody attested is NEVER releasable -- the
///              absence of a proof is itself a refusal to release, not a silent pass.
///           2. RELEASE ONLY ON `Settled`. {requireProven} reverts on `Unverified` (default),
///              `Hollow`, and `Mismatch`; only `Settled` passes. THE HOLLOW-FILL BLOCK is the
///              centerpiece: a fill the chain says delivered nothing is attested `Hollow`, so
///              {requireProven} reverts and the settler does NOT pay -- exactly the point where a
///              hash-only oracle would have paid out on a hollow fill.
///           3. WRITE-ONCE-FINAL. The first real attestation for a fill id is final; it can never be
///              overwritten. A `Hollow`/`Mismatch` can NEVER be retroactively flipped to `Settled`,
///              and a `Settled` can never be revoked. This is the structural guarantee that the
///              verdict an honest verifier posts is the verdict that decides the release.
///           4. ATTESTOR MONOPOLY. Only the {attestor} (the verifier operator) may post a verdict;
///              everyone else reverts. The owner may rotate the attestor but cannot itself attest.
///
///         This contract holds NO funds and is non-custodial: it is a pure verdict registry + gate.
///         The settler integration is "release iff {requireProven} does not revert".
contract SettlementOracle {
    // --------------------------------------------------------------------------------------------
    // The verdict -- the exact four-state monopoly the off-chain verifier mints. The ordinal of
    // `Unverified` MUST stay 0: it is the zero-value default for an un-attested fill id, which is
    // what makes the gate fail-closed (invariant 1). Do not reorder.
    // --------------------------------------------------------------------------------------------

    /// @notice The four-verdict settlement result, mirroring the off-chain verifier's `FillDecision`.
    /// @dev    `Unverified` is ordinal 0 (the default for an unset fill id => fail-closed). Only
    ///         `Settled` is releasable; `Hollow` and `Mismatch` are proven-non-deliveries and are
    ///         never releasable.
    enum Verdict {
        /// @dev No real attestation exists yet (the storage default). NEVER releasable -- a fill
        ///      nobody attested must not release the solver. Cannot itself be attested.
        Unverified,
        /// @dev The destination fill was independently proven to have delivered as intended. The
        ///      ONLY releasable verdict -- {requireProven} passes only here.
        Settled,
        /// @dev The fill claimed delivery but the chain says it delivered nothing (a HOLLOW fill).
        ///      Never releasable -- this is exactly where a hash-only oracle would have paid.
        Hollow,
        /// @dev The fill delivered, but not what the intent required (wrong asset/amount/recipient).
        ///      Never releasable.
        Mismatch
    }

    // --------------------------------------------------------------------------------------------
    // State.
    // --------------------------------------------------------------------------------------------

    /// @notice The recorded verdict per fill id (the destination fill tx hash / intent id). An unset
    ///         id reads `Verdict.Unverified` (ordinal 0) -- the fail-closed default. Private: reads go
    ///         through {verdictOf} / {isReleasable} / {requireProven} so the gate semantics are the
    ///         only surface.
    mapping(bytes32 => Verdict) private _verdicts;

    /// @notice The admin. May rotate the {attestor} and transfer ownership; may NOT attest verdicts
    ///         (the attestor monopoly is a separate role, invariant 4).
    address public owner;

    /// @notice The verifier operator authorized to post verdicts -- the only address {attest} accepts.
    address public attestor;

    // --------------------------------------------------------------------------------------------
    // Events -- a full on-chain audit trail (the chain is the independent record the verifier reads).
    // --------------------------------------------------------------------------------------------

    /// @notice Emitted on every successful, final attestation of a fill id.
    /// @param fillId   The destination fill tx hash / intent id that was attested.
    /// @param verdict  The final verdict written (one of Settled / Hollow / Mismatch; never Unverified).
    /// @param attestor The verifier operator that posted it (`msg.sender`).
    event VerdictAttested(bytes32 indexed fillId, Verdict verdict, address indexed attestor);

    /// @notice Emitted when the authorized attestor changes (including the initial set at construction).
    event AttestorRotated(address indexed previous, address indexed current);

    /// @notice Emitted when ownership changes (including the initial set at construction).
    event OwnershipTransferred(address indexed previous, address indexed current);

    // --------------------------------------------------------------------------------------------
    // Errors -- custom errors are cheaper + clearer than revert strings.
    // --------------------------------------------------------------------------------------------

    /// @notice The caller is not the {owner}.
    error NotOwner();
    /// @notice The caller is not the {attestor} (only the verifier operator may attest).
    error NotAttestor();
    /// @notice An attempt to attest the default {Verdict.Unverified} -- you cannot attest the absence
    ///         of a verdict.
    error InvalidVerdict();
    /// @notice The fill id already carries a final verdict -- write-once-final forbids overwriting it
    ///         (no retroactive flip, invariant 3).
    /// @param fillId  The fill id whose verdict is already final.
    error AlreadyFinal(bytes32 fillId);
    /// @notice {requireProven} guard failed -- the fill id is not `Settled` and must not be released.
    /// @param fillId   The fill id that is not releasable.
    /// @param current  Its current verdict (Unverified / Hollow / Mismatch).
    error NotProven(bytes32 fillId, Verdict current);
    /// @notice A zero address was supplied where a non-zero address is required.
    error ZeroAddress();

    // --------------------------------------------------------------------------------------------
    // Modifiers.
    // --------------------------------------------------------------------------------------------

    /// @dev Restricts to the {owner} (admin surface: rotate attestor, transfer ownership).
    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    /// @dev Restricts to the {attestor} (the verifier monopoly on posting verdicts, invariant 4).
    modifier onlyAttestor() {
        if (msg.sender != attestor) revert NotAttestor();
        _;
    }

    /// @notice Deploy the oracle with the verifier operator that will post verdicts.
    /// @dev    Sets the deployer as {owner} and `attestor_` as the {attestor}; emits the initial
    ///         {OwnershipTransferred} and {AttestorRotated} (from the zero address) so the full role
    ///         history is on-chain from genesis.
    /// @param  attestor_  The verifier operator authorized to attest (reverts on the zero address).
    constructor(address attestor_) {
        if (attestor_ == address(0)) revert ZeroAddress();
        owner = msg.sender;
        attestor = attestor_;
        emit OwnershipTransferred(address(0), msg.sender);
        emit AttestorRotated(address(0), attestor_);
    }

    // --------------------------------------------------------------------------------------------
    // The attestation -- the ONLY way a verdict enters the registry (attestor-only, write-once-final).
    // --------------------------------------------------------------------------------------------

    /// @notice Post the final settlement verdict for a fill id. This is how an honest verifier's
    ///         independently-mined result lands on-chain, where the settler can gate on it.
    /// @dev    Three guards enforce the honesty doctrine:
    ///           - {onlyAttestor}: only the verifier operator may attest (invariant 4).
    ///           - `verdict != Unverified`: you cannot attest the absence of a verdict (invariant 1);
    ///             the default state can only arise from NOT having attested, never from an attestation.
    ///           - WRITE-ONCE-FINAL: the current stored verdict must still be the default `Unverified`,
    ///             otherwise {AlreadyFinal} reverts. This is the core honesty guarantee -- a
    ///             `Hollow`/`Mismatch` can never be retroactively flipped to `Settled`, and a `Settled`
    ///             can never be revoked (invariant 3). An in-flight fill that has not been attested yet
    ///             is still `Unverified`, so it can receive its first (and only) real verdict.
    /// @param fillId   The destination fill tx hash / intent id to finalize.
    /// @param verdict  The final verdict (must be Settled / Hollow / Mismatch; Unverified is rejected).
    function attest(bytes32 fillId, Verdict verdict) external onlyAttestor {
        // Cannot "attest" the absence of a verdict -- Unverified is the un-attested default only.
        if (verdict == Verdict.Unverified) revert InvalidVerdict();
        // Write-once-final: the first real verdict is permanent; never overwrite an existing one.
        if (_verdicts[fillId] != Verdict.Unverified) revert AlreadyFinal(fillId);
        _verdicts[fillId] = verdict;
        emit VerdictAttested(fillId, verdict, msg.sender);
    }

    // --------------------------------------------------------------------------------------------
    // The gate -- what the settler calls before releasing the solver (release iff this does NOT revert).
    // --------------------------------------------------------------------------------------------

    /// @notice Revert unless `fillId` is proven `Settled`. THE gate the Input Settler calls before
    ///         releasing the solver's funds -- an `efficientRequireProven`-style guard.
    /// @dev    Fail-closed: reverts {NotProven} on `Unverified` (the un-attested default), `Hollow`
    ///         (the chain says nothing was delivered), and `Mismatch` (wrong delivery). Only `Settled`
    ///         passes. This is the on-chain enforcement of "RELEASE only on `Settled`" -- the exact
    ///         point where a hash-only oracle would have released funds on a hollow fill, and this one
    ///         does not. Returns nothing; it is purely the guard.
    /// @param  fillId  The fill id to gate on.
    function requireProven(bytes32 fillId) external view {
        Verdict current = _verdicts[fillId];
        if (current != Verdict.Settled) revert NotProven(fillId, current);
    }

    /// @notice The non-reverting query form of the gate: `true` iff `fillId` is proven `Settled`.
    /// @dev    Lets an off-chain caller / the web UI ask "is this releasable?" without catching a
    ///         revert. Equivalent in meaning to "{requireProven} would not revert".
    /// @param  fillId  The fill id to query.
    /// @return Whether the fill id is releasable (its verdict is exactly `Settled`).
    function isReleasable(bytes32 fillId) external view returns (bool) {
        return _verdicts[fillId] == Verdict.Settled;
    }

    /// @notice The raw recorded verdict for a fill id (`Unverified` if it was never attested).
    /// @dev    The fail-closed default surfaces directly: an unset id reads `Verdict.Unverified`.
    /// @param  fillId  The fill id to read.
    /// @return The stored {Verdict}.
    function verdictOf(bytes32 fillId) external view returns (Verdict) {
        return _verdicts[fillId];
    }

    // --------------------------------------------------------------------------------------------
    // Admin surface -- owner-gated role management. The owner cannot attest (separate monopoly).
    // --------------------------------------------------------------------------------------------

    /// @notice Rotate the authorized {attestor} to a new verifier operator.
    /// @dev    Owner-only; rejects the zero address. After rotation the OLD attestor can no longer
    ///         attest. Existing final verdicts are immutable (write-once-final), so rotating the
    ///         attestor never reopens a finalized fill id.
    /// @param  newAttestor  The new verifier operator (reverts on the zero address).
    function rotateAttestor(address newAttestor) external onlyOwner {
        if (newAttestor == address(0)) revert ZeroAddress();
        emit AttestorRotated(attestor, newAttestor);
        attestor = newAttestor;
    }

    /// @notice Transfer ownership of the oracle (e.g. to a multisig/timelock after deploy).
    /// @dev    Owner-only; rejects the zero address. Ownership controls only the admin surface
    ///         (attestor rotation + ownership); it grants no power to attest or to alter verdicts.
    /// @param  newOwner  The new owner (reverts on the zero address).
    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }
}
