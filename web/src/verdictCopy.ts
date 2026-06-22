/**
 * verdictCopy.ts -- the VERDICT-CODE DICTIONARY: a raw verifier verdict string -> honest plain-language
 * (design §4.3 "a verdict-code dictionary maps each raw `Verdict` enum string -> headline copy + long
 * 'why'; unmapped -> render the raw code", §8 honesty).
 *
 * ## Why a dictionary (and what it must never do)
 *
 * The playground (and every verdict surface) shows a three-altitude block: a big HEADLINE, a plain-English
 * WHY, and a dim raw-evidence line. A judge reads the headline; a skeptic reads the raw line; the dictionary
 * is the bridge for the MIDDLE -- it turns the verifier's terse enum (`settled` / `unverified` / `hollow` /
 * `mismatch`) into a sentence a stranger understands, WITHOUT changing what the verdict MEANS.
 *
 * The iron rules this module obeys:
 *   - It MINTS no verdict and CHANGES no verdict (the verdict monopoly, design §3 #2). It only LOOKS UP copy
 *     for a verdict string the verifier/`adjudicate` already produced. The `settled`-only-is-green grammar is
 *     decided elsewhere ({@link ./render.ts} `verdictStateClass`); this module never colours anything.
 *   - It NEVER returns blank and NEVER lies. An UNMAPPED code (a future verdict, or any unexpected string)
 *     falls back to the RAW code as the headline plus an honest "unmapped verdict code" why -- so an unknown
 *     verdict is shown verbatim, never silently dropped or coerced to a friendly (possibly wrong) meaning.
 *
 * ## Clean-room (design §6)
 *
 * Pure data + pure lookup. No DOM, no `innerHTML`, no proprietary identifier, private path, or secret.
 * Generic, verification-domain names only.
 */

import { VERDICT, type Verdict } from "./proofs.js";

/** One dictionary entry: the human HEADLINE + the long plain-English WHY for a verdict code. */
export interface VerdictCopy {
  /** The big, plain-language headline a judge reads (e.g. "Settled — the trade really happened"). */
  readonly headline: string;
  /** The long, honest "why this verdict" sentence a skeptic reads to understand the meaning. */
  readonly why: string;
}

/**
 * The verdict-code dictionary -- the FOUR verifier verdicts the playground can surface, each mapped to
 * honest plain language (design §4.3). The meanings mirror the verifier's published `adjudicate` rule
 * (design §3 #5, mirrored in {@link ./onchain.ts}):
 *
 *   - `settled`     -> a real, confirmed on-chain settlement whose value matches the claim within the band.
 *   - `unverified`  -> no observation on record (off-record hash / unreadable body) -> the verifier refuses
 *                      to assert a settlement -- the honest non-claim, NEVER a fabricated success.
 *   - `hollow`      -> the claim AND the observation are both zero -> a claim with nothing behind it.
 *   - `mismatch`    -> the chain disagrees with the claim (a failed tx, or a value outside the band) -> a
 *                      LOUD anomaly, surfaced red, never softened.
 *
 * Keyed by the lower-cased verdict string so a case difference (an enum vs an upper-cased headline) still
 * resolves. Only these four are mapped; anything else falls through to {@link verdictCopyFor}'s raw fallback.
 */
export const VERDICT_COPY: Readonly<Record<Verdict, VerdictCopy>> = {
  [VERDICT.SETTLED]: {
    headline: "Settled — the trade really happened",
    why:
      "The chain confirms a successful transaction (receipt status 0x1) whose native value matches the " +
      "recorded claim within the verifier's exact-integer tolerance band. The verifier read the chain " +
      "itself and the two agree — this is the only verdict that paints green, and only because a real " +
      "on-chain observation backs it.",
  },
  [VERDICT.UNVERIFIED]: {
    headline: "Unverified — nothing on record to confirm",
    why:
      "The verifier found no observation it can stand behind for this hash — the chain has no receipt on " +
      "record, or the body could not be read, so there is nothing confirming a settlement. It stamps " +
      "UNVERIFIED rather than guess: an honest non-claim, never a fabricated SETTLED. It is not " +
      "rubber-stamping; it is reading the chain and finding no proof.",
  },
  [VERDICT.HOLLOW]: {
    headline: "Hollow — a claim with nothing behind it",
    why:
      "Both the recorded claim and the observed on-chain value are zero — the transaction moved no value, " +
      "so there is no real settlement under the claim. The verifier surfaces HOLLOW loudly rather than " +
      "soften an empty claim into a success.",
  },
  [VERDICT.MISMATCH]: {
    headline: "Mismatch — the chain disagrees with the claim",
    why:
      "The chain's own answer contradicts the claim: the transaction failed (receipt status not 0x1), or " +
      "the observed value falls outside the verifier's tolerance band around the claim. This is a LOUD " +
      "anomaly — surfaced red, never softened into a settlement.",
  },
} as const;

/**
 * Resolve the honest copy for a verdict code (design §4.3). A KNOWN verdict string returns its dictionary
 * entry; an UNMAPPED code (a future verdict, an on-chain reason, or any unexpected string) falls back to the
 * RAW code as the headline plus an honest "unmapped verdict code" why -- so the screen shows the unknown
 * code VERBATIM and never blanks it, never lies about it (design §8: never fabricate, claim only what's true).
 *
 * This function makes NO judgement about a verdict's honesty colour (that is `verdictStateClass`'s job); it
 * only supplies the words. It is total: every input resolves to non-empty copy.
 *
 * @param verdict the raw verdict string the verifier/`adjudicate` produced (any case).
 * @returns the headline + why -- a dictionary entry for a known code, or an honest raw-code fallback.
 */
export function verdictCopyFor(verdict: string): VerdictCopy {
  const key = verdict.trim().toLowerCase();
  const mapped = (VERDICT_COPY as Readonly<Record<string, VerdictCopy>>)[key];
  if (mapped !== undefined) {
    return mapped;
  }
  // Unmapped -> show the raw code verbatim; never blank, never a coerced friendly meaning (design §8).
  const raw = verdict.trim().length > 0 ? verdict.trim() : "(empty)";
  return {
    headline: raw.toUpperCase(),
    why:
      `This is an unmapped verdict code, shown verbatim. The dashboard has no plain-language entry for ` +
      `"${raw}", so it renders the raw code rather than invent a meaning — an unknown verdict is never ` +
      `silently dropped or coerced to a friendly label.`,
  };
}
