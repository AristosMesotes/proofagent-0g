/**
 * slasherCard.ts -- the "Slashable Mandate" interactive scoreboard (honesty as enforced economics).
 *
 * An honesty scoreboard over the verifier's OWN minted verdicts that AUTO-REVOKES the mandate after N
 * consecutive DISHONEST verdicts. It converts honesty into enforced economics -- the reputation gap the
 * cross-chain intents market leaves open (a dishonest solver keeps its mandate); ProofAgent slashes it.
 *
 * ## Faithful mirror of the Rust `slash` (verifier/src/slasher.rs)
 *
 * {@link slashUi} mirrors the Rust projection EXACTLY: the slash streak is the TRAILING run of consecutive
 * dishonest verdicts (`hollow` | `mismatch`); a `settled` (demonstrated honesty) OR an `unverified`
 * (undetermined -- the verifier could not read it) BREAKS the run. With `revoke_after = 2`, the mandate is
 * REVOKED iff the trailing streak reached 2, else ACTIVE -- a structural, never-softened decision. Pure +
 * deterministic: same sequence + same threshold => same standing (no clock, no float).
 *
 * ## Honesty + clean-room (design §3 #1/#3, §6, §8)
 *
 * Only ACTIVE is the green face; REVOKED is the loud red face. The sequence renders as colour-coded chips
 * (settled green, hollow/mismatch red, unverified amber) -- the same honest verdict grammar as every card.
 * Pure DOM, NO `innerHTML`, no secret, no proprietary identifier -- generic, verification-domain names only.
 */

import { VERDICT, type Verdict } from "./proofs.js";
import { statusDot, verdictStateClass } from "./render.js";

/* ------------------------------------------------------------------------------------------------ *
 * The mandate standing -- derived purely from the trailing dishonest streak vs the threshold.
 * ------------------------------------------------------------------------------------------------ */

/** The mandate's standing under the slasher. */
export const MANDATE_STATUS = {
  /** The mandate stands -- the trailing dishonest streak is below the revoke threshold. */
  ACTIVE: "ACTIVE",
  /** The mandate is AUTO-REVOKED -- the trailing dishonest streak reached the threshold. Loud. */
  REVOKED: "REVOKED",
} as const;

/** A mandate-standing string. */
export type MandateStatus = (typeof MANDATE_STATUS)[keyof typeof MANDATE_STATUS];

/** How many consecutive dishonest verdicts (`hollow` | `mismatch`) revoke the mandate (the design default). */
export const REVOKE_AFTER = 2;

/** The slasher's report over a verdict sequence: the standing, the trailing streak, and the per-verdict counts. */
export interface SlashReport {
  /** The mandate standing (ACTIVE / REVOKED). */
  readonly status: MandateStatus;
  /** The trailing run of consecutive dishonest verdicts (`hollow` | `mismatch`). */
  readonly consecutiveDishonest: number;
  /** The configured revoke threshold. */
  readonly revokeAfter: number;
  /** Total verdicts in the sequence. */
  readonly total: number;
  /** Count of `settled` verdicts (demonstrated honesty). */
  readonly settled: number;
  /** Count of `hollow` verdicts (demonstrated dishonesty). */
  readonly hollow: number;
  /** Count of `mismatch` verdicts (demonstrated dishonesty). */
  readonly mismatch: number;
  /** Count of `unverified` verdicts (undetermined). */
  readonly unverified: number;
}

/** `true` iff this verdict is demonstrated DISHONESTY (the chain disagrees with the claim). */
function isDishonest(verdict: Verdict): boolean {
  return verdict === VERDICT.HOLLOW || verdict === VERDICT.MISMATCH;
}

/**
 * Project a verdict sequence into a mandate standing, exactly as the Rust `slash` does: REVOKE after
 * `revokeAfter` consecutive dishonest verdicts (`hollow` | `mismatch`). Pure, deterministic. The trailing
 * dishonest streak counts BACKWARD from the most recent verdict: a `hollow`/`mismatch` increments it; ANY
 * other verdict (`settled` proving honesty, or `unverified` -- undetermined) BREAKS it. REVOKED iff the
 * streak reached the threshold.
 */
export function slashUi(sequence: readonly Verdict[], revokeAfter: number = REVOKE_AFTER): SlashReport {
  if (!Number.isInteger(revokeAfter) || revokeAfter < 1) {
    // A zero/negative threshold would revoke with NO demonstrated dishonesty -- a misconfiguration, not a slash.
    throw new RangeError(`revokeAfter must be a positive integer, got ${String(revokeAfter)}`);
  }
  let settled = 0;
  let hollow = 0;
  let mismatch = 0;
  let unverified = 0;
  for (const v of sequence) {
    switch (v) {
      case VERDICT.SETTLED:
        settled += 1;
        break;
      case VERDICT.HOLLOW:
        hollow += 1;
        break;
      case VERDICT.MISMATCH:
        mismatch += 1;
        break;
      case VERDICT.UNVERIFIED:
        unverified += 1;
        break;
      default:
        break;
    }
  }
  // The trailing run of consecutive dishonest verdicts: count backward, stop at the first non-dishonest one.
  let streak = 0;
  for (let i = sequence.length - 1; i >= 0; i--) {
    const v = sequence[i];
    if (v !== undefined && isDishonest(v)) {
      streak += 1;
    } else {
      break;
    }
  }
  const status: MandateStatus = streak >= revokeAfter ? MANDATE_STATUS.REVOKED : MANDATE_STATUS.ACTIVE;
  return {
    status,
    consecutiveDishonest: streak,
    revokeAfter,
    total: sequence.length,
    settled,
    hollow,
    mismatch,
    unverified,
  };
}

/* ------------------------------------------------------------------------------------------------ *
 * The card -- pure DOM, mirrors the existing card look (verdict colours, dot grammar, chips).
 * ------------------------------------------------------------------------------------------------ */

/** The built Slashable Mandate card (the `root` element the dashboard appends). */
export interface SlasherCard {
  readonly root: HTMLElement;
}

/** The caption shown under the standing when the mandate is auto-revoked. */
const REVOKED_CAPTION =
  "Two dishonest verdicts in a row → the mandate is auto-revoked; the agent can no longer spend.";
/** The caption shown while the mandate still stands. */
const ACTIVE_CAPTION =
  "Honesty as enforced economics: an honest settlement (or an unreadable gap) keeps the mandate alive; " +
  "two dishonest verdicts in a row revoke it.";

/**
 * Build the Slashable Mandate card. Buttons append a verdict to a live sequence (`+ settled`, `+ hollow`,
 * `+ mismatch`) plus a `Reset`; each change re-projects the sequence through {@link slashUi} and repaints
 * the standing (ACTIVE green / REVOKED red), the streak `n/2`, the verdict sequence as colour-coded chips,
 * and the honest caption. Pure + offline (the sequence IS the input), so a judge re-derives the standing by
 * hand. Starts EMPTY -> ACTIVE (an honest "nothing dishonest yet"), never a faked standing.
 */
export function buildSlasherCard(): SlasherCard {
  const root = document.createElement("section");
  root.className = "frontier-card";
  root.id = "card-slasher";
  root.setAttribute("aria-label", "Slashable Mandate — auto-revoke after two dishonest verdicts in a row");

  const head = document.createElement("div");
  head.className = "frontier-card__head";
  const dot = statusDot("is-settled");
  head.appendChild(dot);
  const h = document.createElement("h2");
  h.className = "frontier-card__title";
  h.textContent = "Slashable Mandate";
  head.appendChild(h);
  root.appendChild(head);

  const lead = document.createElement("p");
  lead.className = "frontier-card__lead";
  lead.textContent =
    "An honesty scoreboard over the verifier's own verdicts. Append verdicts — two DISHONEST ones in a row " +
    "(hollow or mismatch) auto-revoke the mandate; an honest settlement (or an unreadable gap) breaks the run.";
  root.appendChild(lead);

  const row = document.createElement("div");
  row.className = "frontier-card__row";
  root.appendChild(row);

  const chipsRow = document.createElement("div");
  chipsRow.className = "frontier-card__chips";
  chipsRow.setAttribute("aria-label", "the verdict sequence");

  const out = document.createElement("div");
  out.className = "frontier-card__output";
  out.setAttribute("role", "status");
  out.setAttribute("aria-live", "polite");

  const sequence: Verdict[] = [];

  /** Append a colour-coded chip for one verdict to the sequence row (settled green, hollow/mismatch red). */
  const chipFor = (verdict: Verdict): HTMLElement => {
    const chip = document.createElement("span");
    chip.className = `frontier-card__chip ${verdictStateClass(verdict)}`;
    chip.appendChild(statusDot(verdictStateClass(verdict)));
    const label = document.createElement("span");
    label.textContent = verdict;
    chip.appendChild(label);
    return chip;
  };

  const render = (): void => {
    const report = slashUi(sequence);

    // The header dot tracks the standing (green ACTIVE / red REVOKED) -- the honest dot grammar.
    dot.className = `status-dot ${report.status === MANDATE_STATUS.REVOKED ? "is-mismatch" : "is-settled"}`;

    // The chips -- the verdict sequence, each in its honest colour. Empty sequence = an honest placeholder.
    chipsRow.replaceChildren();
    if (sequence.length === 0) {
      const placeholder = document.createElement("span");
      placeholder.className = "frontier-card__chip-empty";
      placeholder.textContent = "(no verdicts yet — append some)";
      chipsRow.appendChild(placeholder);
    } else {
      for (const v of sequence) {
        chipsRow.appendChild(chipFor(v));
      }
    }

    out.replaceChildren();

    // Altitude 1 -- the big standing + the streak n/2.
    const standing = document.createElement("p");
    const standingClass = report.status === MANDATE_STATUS.REVOKED ? "is-mismatch" : "is-settled";
    standing.className = `verdict-headline ${standingClass}`;
    standing.textContent = report.status;
    out.appendChild(standing);

    const streak = document.createElement("p");
    streak.className = "frontier-card__streak mono-num";
    streak.textContent = `dishonest streak: ${report.consecutiveDishonest}/${report.revokeAfter}`;
    out.appendChild(streak);

    // Altitude 2 -- the honest caption (the killer line when revoked).
    const why = document.createElement("p");
    why.className = "verdict-why";
    why.textContent = report.status === MANDATE_STATUS.REVOKED ? REVOKED_CAPTION : ACTIVE_CAPTION;
    out.appendChild(why);

    // Altitude 3 -- the dim, mono scoreboard line (re-derivable by counting the chips).
    const raw = document.createElement("p");
    raw.className = "verdict-raw mono-num";
    raw.textContent =
      `slash(streak=${report.consecutiveDishonest}/${report.revokeAfter}) → ${report.status} ` +
      `(settled=${report.settled} hollow=${report.hollow} mismatch=${report.mismatch} ` +
      `unverified=${report.unverified} over ${report.total} verdicts)`;
    out.appendChild(raw);

    out.setAttribute("data-status", report.status);
    out.setAttribute("data-streak", String(report.consecutiveDishonest));
  };

  const appendBtn = (id: string, label: string, verdict: Verdict): void => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.id = id;
    btn.className = "frontier-card__btn";
    btn.textContent = label;
    btn.addEventListener("click", () => {
      sequence.push(verdict);
      render();
    });
    row.appendChild(btn);
  };

  appendBtn("slasher-add-settled", "+ settled", VERDICT.SETTLED);
  appendBtn("slasher-add-hollow", "+ hollow", VERDICT.HOLLOW);
  appendBtn("slasher-add-mismatch", "+ mismatch", VERDICT.MISMATCH);

  const reset = document.createElement("button");
  reset.type = "button";
  reset.id = "slasher-reset";
  reset.className = "frontier-card__btn frontier-card__btn--ghost";
  reset.textContent = "Reset";
  reset.addEventListener("click", () => {
    sequence.length = 0;
    render();
  });
  row.appendChild(reset);

  root.appendChild(chipsRow);
  root.appendChild(out);

  // First paint: an EMPTY sequence -> ACTIVE (the honest "nothing dishonest yet"), never a faked standing.
  render();

  return { root };
}
