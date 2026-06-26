/**
 * fillproofCard.ts -- the "Fill-Proof Oracle" interactive card (the LI.FI-Intents frontier).
 *
 * ProofAgent as the HONEST settlement oracle for cross-chain intents: a solver fronts destination
 * liquidity and the settler releases the solver's funds ONLY after an oracle proves the fill. The open
 * gap is honesty under adversarial fills -- a hash-only oracle releases whatever it is *told* proved. This
 * card makes that visible: it adjudicates the solver's CLAIMED fill against the verifier's INDEPENDENT
 * on-chain observation of the delivered amount, then emits a RELEASE/BLOCK decision.
 *
 * ## Faithful mirror of the Rust `adjudicate_fill` (verifier/src/fillproof.rs)
 *
 * The UI logic in {@link adjudicateFillUi} mirrors the Rust verdict algebra EXACTLY, in exact-integer math
 * (no float), against the same 15/100 band:
 *   - observed === null            -> `unverified` -> BLOCK  (unreadable; fail-closed, never fabricate),
 *   - observed === 0 && claimed > 0 -> `hollow`    -> BLOCK  (the killer: claimed payment, moved nothing),
 *   - |claimed - observed| <= floor(claimed * 15 / 100) -> `settled` -> RELEASE (chain-confirmed, in-band),
 *   - else                         -> `mismatch`  -> BLOCK  (delivered, but the wrong amount).
 * The decision is derived purely from the verdict (RELEASE only on `settled`) so the card can never
 * disagree with the verdict monopoly. The card MINTS no verdict it did not derive from the two amounts.
 *
 * ## Honesty + clean-room (design §3 #2/#3, §6, §8)
 *
 * Only `settled`/RELEASE is green; every BLOCK is the loud red face. Pure DOM, NO `innerHTML`, no secret,
 * no proprietary identifier or private path -- generic, verification-domain names only.
 */

import { VERDICT, type Verdict } from "./proofs.js";
import { statusDot, verdictStateClass } from "./render.js";
import { VERIFIER } from "./spine.js";

/* ------------------------------------------------------------------------------------------------ *
 * The oracle release gate -- derived purely from the verdict (RELEASE only on settled).
 * ------------------------------------------------------------------------------------------------ */

/** The oracle's release gate -- the `efficientRequireProven` decision, made honestly. */
export const FILL_DECISION = {
  /** The chain confirmed a within-band fill -> release the solver's funds. */
  RELEASE: "RELEASE",
  /** The fill is hollow / out-of-band / unreadable -> block release (fail-closed, never fabricate). */
  BLOCK: "BLOCK",
} as const;

/** A release-gate decision string. */
export type FillDecision = (typeof FILL_DECISION)[keyof typeof FILL_DECISION];

/** Derive the oracle decision from a minted verdict: RELEASE only on `settled`, BLOCK otherwise. */
export function fillDecisionFor(verdict: Verdict): FillDecision {
  return verdict === VERDICT.SETTLED ? FILL_DECISION.RELEASE : FILL_DECISION.BLOCK;
}

/** The fill-proof report: the minted verdict, the derived decision, and the two amounts that produced them. */
export interface FillReport {
  /** The verdict minted by the verifier algebra -- one of the SAME four (the monopoly). */
  readonly verdict: Verdict;
  /** The RELEASE/BLOCK decision derived purely from `verdict`. */
  readonly decision: FillDecision;
  /** The solver's claimed delivered amount, in minor units. */
  readonly claimed: bigint;
  /** The verifier's INDEPENDENT observation of the delivered amount; `null` = unreadable. */
  readonly observed: bigint | null;
}

/**
 * Adjudicate a solver's claimed fill against the verifier's independent observation, exactly as the Rust
 * `adjudicate_fill` does -- pure, deterministic, exact-integer (no float). The hollow-fill catch (a positive
 * claimed fill with an independently-observed ZERO delivery) mints `hollow`, structurally distinct from a
 * `mismatch`; every other shape defers to the shared band algebra (which also maps the `(0, 0)` no-op to
 * `hollow`, and an absent observation to `unverified`). The decision is then derived purely from the verdict.
 */
export function adjudicateFillUi(
  claimed: bigint,
  observed: bigint | null,
  num: bigint = BigInt(VERIFIER.toleranceNum),
  den: bigint = BigInt(VERIFIER.toleranceDen),
): FillReport {
  if (den <= 0n || num < 0n) {
    // An ill-formed band has no exact-integer meaning -> refuse to settle (fail loud, never fabricate).
    throw new RangeError(`ill-formed tolerance band ${num.toString()}/${den.toString()}`);
  }
  let verdict: Verdict;
  if (observed === null) {
    // No observation -> unverified -> BLOCK. Fail-closed: a fill the verifier could not read is NEVER paid.
    verdict = VERDICT.UNVERIFIED;
  } else if (observed === 0n && claimed > 0n) {
    // The hollow-fill centerpiece: the solver claims a positive delivery, the chain says ZERO moved.
    verdict = VERDICT.HOLLOW;
  } else if (claimed === 0n && observed === 0n) {
    // The genuine (0, 0) no-op also resolves to hollow (mirrors the shared band algebra's (0,0) case).
    verdict = VERDICT.HOLLOW;
  } else {
    const mag = claimed < 0n ? -claimed : claimed;
    const delta0 = claimed - observed;
    const delta = delta0 < 0n ? -delta0 : delta0;
    const band = (mag * num) / den; // exact-integer floor division (den > 0).
    verdict = delta <= band ? VERDICT.SETTLED : VERDICT.MISMATCH;
  }
  return { verdict, decision: fillDecisionFor(verdict), claimed, observed };
}

/* ------------------------------------------------------------------------------------------------ *
 * The three demo scenarios (the buttons) -- exact-integer amounts the card adjudicates live.
 * ------------------------------------------------------------------------------------------------ */

/** The fixed claimed fill the scenarios check against the chain (1,000,000 minor units). */
const CLAIMED = 1_000_000n;

/** One scenario button -- a claim + the verifier's independent observation (or `null` = unreadable). */
interface FillScenario {
  readonly id: string;
  readonly label: string;
  readonly claimed: bigint;
  readonly observed: bigint | null;
  /** The honest one-line caption shown under the verdict for this scenario. */
  readonly caption: string;
}

/** The three scenarios: the killer hollow-fill (default), the honest fill, and the unreadable fill. */
const SCENARIOS: readonly FillScenario[] = [
  {
    id: "fillproof-hollow",
    label: "Hollow fill",
    claimed: CLAIMED,
    observed: 0n,
    caption:
      "The solver claims payment, the chain says nothing moved — ProofAgent BLOCKS, where a hash-only " +
      "oracle would pay.",
  },
  {
    id: "fillproof-honest",
    label: "Honest fill",
    claimed: CLAIMED,
    observed: CLAIMED,
    caption: "The chain confirms the claimed delivery, within the band — the solver is paid. RELEASE.",
  },
  {
    id: "fillproof-unreadable",
    label: "Unreadable",
    claimed: CLAIMED,
    observed: null,
    caption:
      "The verifier could not read the destination fill — fail-closed: a fill it can't confirm is NEVER " +
      "released. BLOCK.",
  },
];

/* ------------------------------------------------------------------------------------------------ *
 * The card -- pure DOM, mirrors the existing card look (verdict colours, dot grammar, dl rows).
 * ------------------------------------------------------------------------------------------------ */

/** The built Fill-Proof Oracle card (the `root` element the dashboard appends). */
export interface FillProofCard {
  readonly root: HTMLElement;
}

/**
 * Build the Fill-Proof Oracle card. Three scenario buttons drive {@link adjudicateFillUi}; the output is the
 * verdict + the RELEASE/BLOCK decision (green on RELEASE, red on BLOCK) + an honest one-line caption + a mono
 * raw-evidence line echoing the two amounts. Default-loads the HOLLOW scenario (the killer moment). The card
 * is offline + pure (no network): the two amounts ARE the input, so a judge re-derives every verdict by hand.
 */
export function buildFillProofCard(): FillProofCard {
  const root = document.createElement("section");
  root.className = "frontier-card";
  root.id = "card-fillproof";
  root.setAttribute("aria-label", "Fill-Proof Oracle — release a solver only on a chain-confirmed fill");

  const head = document.createElement("div");
  head.className = "frontier-card__head";
  head.appendChild(statusDot("is-mismatch"));
  const h = document.createElement("h2");
  h.className = "frontier-card__title";
  h.textContent = "Fill-Proof Oracle";
  head.appendChild(h);
  root.appendChild(head);

  const lead = document.createElement("p");
  lead.className = "frontier-card__lead";
  lead.textContent =
    "The honest settlement oracle for cross-chain intents: a solver is paid ONLY when an independent read of " +
    "the chain confirms it actually delivered. Pick a scenario — the verifier checks the solver's claim " +
    "against what really moved, and RELEASES or BLOCKS.";
  root.appendChild(lead);

  const row = document.createElement("div");
  row.className = "frontier-card__row";
  root.appendChild(row);

  const out = document.createElement("div");
  out.className = "frontier-card__output";
  out.setAttribute("role", "status");
  out.setAttribute("aria-live", "polite");

  const render = (scenario: FillScenario): void => {
    const report = adjudicateFillUi(scenario.claimed, scenario.observed);
    const observedTxt = report.observed === null ? "∅ (unreadable)" : `${report.observed.toString()}`;

    out.replaceChildren();

    // Altitude 1 -- the big verdict + the RELEASE/BLOCK decision badge (green on RELEASE, red on BLOCK).
    const verdictRow = document.createElement("p");
    verdictRow.className = `verdict-headline ${verdictStateClass(report.verdict)}`;
    verdictRow.textContent = report.verdict.toUpperCase();
    out.appendChild(verdictRow);

    const decision = document.createElement("p");
    const decisionClass = report.decision === FILL_DECISION.RELEASE ? "is-settled" : "is-mismatch";
    decision.className = `frontier-card__decision ${decisionClass}`;
    decision.textContent = `→ ${report.decision}`;
    out.appendChild(decision);

    // Altitude 2 -- the honest plain-English caption for the scenario.
    const why = document.createElement("p");
    why.className = "verdict-why";
    why.textContent = scenario.caption;
    out.appendChild(why);

    // Altitude 3 -- the dim, mono raw-evidence line echoing the literal adjudication (re-derivable by hand).
    const raw = document.createElement("p");
    raw.className = "verdict-raw mono-num";
    raw.textContent =
      `adjudicate_fill(claimed=${report.claimed.toString()}, observed=${observedTxt}, ` +
      `${VERIFIER.toleranceNum}/${VERIFIER.toleranceDen}) → ${report.verdict} → ${report.decision}`;
    out.appendChild(raw);

    out.setAttribute("data-verdict", report.verdict);
    out.setAttribute("data-decision", report.decision);
  };

  for (const scenario of SCENARIOS) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.id = scenario.id;
    btn.className = "frontier-card__btn";
    btn.textContent = scenario.label;
    btn.addEventListener("click", () => {
      render(scenario);
    });
    row.appendChild(btn);
  }

  root.appendChild(out);

  // Default-load the HOLLOW scenario (the killer moment) so first paint shows the BLOCK that a hash-only
  // oracle would have paid -- the honest centerpiece, with zero clicks and zero network round-trip.
  const defaultScenario = SCENARIOS[0];
  if (defaultScenario !== undefined) {
    render(defaultScenario);
  }

  return { root };
}
