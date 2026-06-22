/**
 * reconcile.ts -- the reconciliation-badge state machine (design §4 "reconciliation badge", §6 harness, §8).
 *
 * ## What a reconciliation badge IS (and is NOT)
 *
 * Every interactive tile renders a `data-verdict` (the painted verdict) AND a small reconciliation badge.
 * The badge answers ONE question, honestly: *did an INDEPENDENT source confirm the verdict this tile
 * painted?* It is NOT a second copy of the verdict colour -- a tile can paint an amber `UNVERIFIED`
 * headline yet still carry a green `✓ reconciled vs verifier` badge, because the independent re-read AGREED
 * with that amber verdict. Agreement is the badge; the verdict's own honesty colour is separate.
 *
 * ## The iron honesty rule (design §8): the badge NEVER goes green from the UI's own state
 *
 * A badge turns `reconciled` (green) ONLY when an out-of-process, independent re-derivation of the SAME
 * authoritative source (the published verifier rule, or a SECOND read-only RPC read) produces a verdict
 * string equal to the one the tile painted. It is never set green from the tile's painted attribute alone
 * (that would be trusting the UI). If the independent source DISAGREES it is a LOUD `mismatch` (red); if the
 * independent source is UNREACHABLE it is an honest `unavailable` (grey, infra-gated), never faked green.
 * The default, before any independent confirmation arrives, is `reconciling…` (muted) -- an honest not-yet.
 *
 * The BRAIN tile is the canonical demonstration: there is no independent attestation source wired at MVP,
 * so its badge is permanently `awaiting real attestation` (muted) -- it can NEVER reach `reconciled`/green
 * here. Only a real enclave attestation (operator-gated, elsewhere) could ever flip it.
 *
 * ## Clean-room (design §6)
 *
 * Pure DOM + pure logic. No proprietary identifier, private path, or secret. Generic verification-domain
 * names only. No `innerHTML` (the no-injection discipline, preserved).
 */

/* ------------------------------------------------------------------------------------------------ *
 * The badge state machine.
 * ------------------------------------------------------------------------------------------------ */

/**
 * The reconciliation-badge states (design §4 badge state machine). `pending` (idle, before any read) and
 * `checking` (an independent re-read is in flight) are honest not-yets; `reconciled` is the ONLY green
 * state and is reached ONLY from an independent confirmation; `mismatch` is a LOUD red disagreement;
 * `unavailable` is a grey, infra-gated "the independent source could not be reached -- never faked green";
 * `awaiting` is the brain's honest "no independent attestation source is wired yet" (never green here).
 */
export const RECONCILE = {
  /** Idle -- the tile has a verdict but no independent re-read has started yet. Muted. */
  PENDING: "pending",
  /** An independent re-read is in flight. Muted. */
  CHECKING: "checking",
  /** The independent source CONFIRMED the painted verdict -- the ONLY green badge state. */
  RECONCILED: "reconciled",
  /** The independent source DISAGREED with the painted verdict -- a LOUD red anomaly. */
  MISMATCH: "mismatch",
  /** The independent source was UNREACHABLE -- honest grey, infra-gated, never faked green. */
  UNAVAILABLE: "unavailable",
  /** No independent source is wired (the brain at MVP) -- honest muted not-yet, never green here. */
  AWAITING: "awaiting",
} as const;

/** A reconciliation-badge state. */
export type ReconcileState = (typeof RECONCILE)[keyof typeof RECONCILE];

/** The CSS state class + glyph + default label for each badge state (only `reconciled` is green). */
interface BadgeFace {
  readonly cssState: string;
  readonly glyph: string;
  readonly label: string;
}

const BADGE_FACE: Readonly<Record<ReconcileState, BadgeFace>> = {
  [RECONCILE.PENDING]: { cssState: "is-pending", glyph: "⌛", label: "reconciling…" },
  [RECONCILE.CHECKING]: { cssState: "is-pending", glyph: "⌛", label: "reconciling…" },
  [RECONCILE.RECONCILED]: { cssState: "is-settled", glyph: "✓", label: "reconciled" },
  [RECONCILE.MISMATCH]: { cssState: "is-mismatch", glyph: "⚠", label: "unreconciled (mismatch)" },
  [RECONCILE.UNAVAILABLE]: { cssState: "is-read-error", glyph: "○", label: "source unavailable (infra-gated)" },
  [RECONCILE.AWAITING]: { cssState: "is-pending", glyph: "⌛", label: "awaiting real attestation" },
};

/**
 * A reconciliation badge bound to one tile. {@link create} builds the pill; {@link set} drives it through
 * the state machine. The badge keeps its OWN `data-reconcile` attribute (parallel to the tile's
 * `data-verdict`) so the same headless harness that reads `data-verdict` can also read the badge state and
 * confirm the page never set it green from the UI's own state.
 */
export class ReconcileBadge {
  private readonly el: HTMLSpanElement;
  private readonly glyphEl: HTMLSpanElement;
  private readonly textEl: HTMLSpanElement;

  /**
   * Build a reconciliation-badge pill. It starts in `pending` ("reconciling…", muted). The optional
   * `sourceLabel` (e.g. `"0G RPC"` / `"verifier"`) is appended to the `reconciled` label so a reviewer
   * sees WHICH independent source confirmed (design §4 -- `✓ reconciled vs 0G RPC`).
   */
  public constructor(private readonly sourceLabel: string) {
    this.el = document.createElement("span");
    this.el.className = "recon-badge pill";
    this.glyphEl = document.createElement("span");
    this.glyphEl.className = "recon-badge__glyph";
    this.glyphEl.setAttribute("aria-hidden", "true");
    this.textEl = document.createElement("span");
    this.textEl.className = "recon-badge__text";
    this.el.appendChild(this.glyphEl);
    this.el.appendChild(this.textEl);
    this.set(RECONCILE.PENDING);
  }

  /** The badge element (append it into a card's verdict block). */
  public element(): HTMLSpanElement {
    return this.el;
  }

  /**
   * Drive the badge to a state. `reconciled` is the ONLY green face and is the caller's responsibility to
   * pass ONLY after an INDEPENDENT confirmation (this method never derives green from UI state -- it just
   * renders the state it is told, and the dashboard's reconcile pass is the single place that decides
   * `reconciled`). An optional `detail` overrides the default label (e.g. the disagreeing verdict).
   */
  public set(state: ReconcileState, detail?: string): void {
    const face = BADGE_FACE[state];
    // Reset the state classes, then apply this state's honest colour class (only is-settled is green).
    this.el.className = `recon-badge pill ${face.cssState}`;
    this.glyphEl.textContent = face.glyph;
    let label = face.label;
    if (state === RECONCILE.RECONCILED) {
      label = `${face.label} vs ${this.sourceLabel}`;
    }
    if (detail !== undefined && detail.length > 0) {
      label = `${label} — ${detail}`;
    }
    this.textEl.textContent = `${label}`;
    // The harness reads this parallel to `data-verdict` -- proof the badge was never auto-greened.
    this.el.setAttribute("data-reconcile", state);
  }
}

/* ------------------------------------------------------------------------------------------------ *
 * The reconcile decision -- compares a painted verdict to an INDEPENDENT re-derivation, honestly.
 * ------------------------------------------------------------------------------------------------ */

/**
 * The outcome of one independent re-derivation: the verdict an out-of-process re-read produced, or a flag
 * that the independent source was unreachable. The dashboard passes BOTH the painted verdict and this
 * independent result to {@link decideReconcile}; the comparison -- not the UI -- decides the badge.
 */
export interface IndependentResult {
  /** The verdict string the INDEPENDENT re-read produced, or `null` if the source was unreachable. */
  readonly verdict: string | null;
}

/**
 * Decide a badge state by COMPARING the tile's painted verdict to an independent re-derivation (design §8 --
 * the UI is never trusted; agreement between two independent reads is the badge).
 *
 *   - independent source unreachable (`independent.verdict === null`) -> `unavailable` (honest grey).
 *   - the independent verdict EQUALS the painted verdict               -> `reconciled` (green -- agreement).
 *   - the independent verdict DIFFERS from the painted verdict         -> `mismatch` (LOUD red).
 *
 * This is the ONLY function that returns `reconciled`, and it does so ONLY on a string match between two
 * independently-produced verdicts -- never from the painted attribute alone. Verdict strings are compared
 * case-insensitively (the on-chain reason `OVER_TX_CAP` vs a lower-cased verifier verdict are normalized).
 */
export function decideReconcile(paintedVerdict: string, independent: IndependentResult): ReconcileState {
  if (independent.verdict === null) {
    return RECONCILE.UNAVAILABLE;
  }
  const a = paintedVerdict.trim().toLowerCase();
  const b = independent.verdict.trim().toLowerCase();
  if (a.length === 0 || b.length === 0) {
    // A missing painted or independent verdict cannot be confirmed -> never green; honest not-yet.
    return RECONCILE.UNAVAILABLE;
  }
  return a === b ? RECONCILE.RECONCILED : RECONCILE.MISMATCH;
}
