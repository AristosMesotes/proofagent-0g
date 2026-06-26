/**
 * breakitCard.ts -- the "Break-it" GAUNTLET card: the interactive, judge/voter-facing version of the Rust
 * `verifier break-it` command. The thesis is the whole point: "You don't trust it -- you try to BREAK it,
 * and watch every attack fail." This is the viral community-vote unit.
 *
 * ## What it does
 *
 * It runs a fixed battery of EIGHT deliberate attacks -- the exact adversarial inputs a dishonest agent /
 * solver / UI would use to FABRICATE a green (a settlement the chain never recorded, a fill that delivered
 * nothing, a cross-chain lock with an empty destination, a repeat liar keeping its mandate, a revoked solver
 * collecting on a later honest fill, an on-chain spend with no record) -- and shows the verifier REFUSING
 * each one. An attack is DEFEATED iff the computed refusal is NOT the attacker's desired pass
 * (`settled` / `RELEASE` / `ACTIVE` / `reconciled`); an attack that ever SUCCEEDED would be a catastrophic
 * honesty defect and the headline reads the LOUD red.
 *
 * ## Faithful mirror of the Rust `run_gauntlet` (verifier/src/breakit.rs) -- compute, never hardcode
 *
 * Every attack's refusal is COMPUTED from the inputs via a PURE mirror of the verifier algebra, in
 * exact-integer BigInt (no float) -- NEVER a hardcoded refusal string. The mirrors reused/added here are the
 * SAME algebras the sibling cards expose:
 *   - #1/#2/#3 -> {@link adjudicateUi} (the settlement band algebra: unverified / hollow / settled / mismatch),
 *   - #4       -> {@link adjudicateFillUi} from `./fillproofCard.js` (the hollow-fill catch -> BLOCK),
 *   - #5       -> {@link combineXchain} folding `adjudicateUi(source)` with `adjudicateFillUi(dest)`,
 *   - #6       -> {@link slashUi} from `./slasherCard.js` (two hollows in a row -> REVOKED),
 *   - #7       -> {@link slashUi} over the PREFIX (the slash bites: the 3rd honest fill is WITHHELD),
 *   - #8       -> {@link reconcileUi} (a transfer with no record -> refuted, never reconciled).
 * The expected honest refusals are byte-identical to the Rust gauntlet's `observed()` strings, so a judge
 * who runs `verifier break-it` sees the SAME 8/8 DEFEATED.
 *
 * ## Honesty + clean-room (design SS3 #2/#3, SS6, SS8)
 *
 * Only a FULL 8/8 defeat is the green headline; every refusal row is the loud red face (the honest verdict
 * grammar -- only settled/RELEASE/ACTIVE/reconciled is green, and those are exactly what the attacker wanted
 * and never got). Pure DOM, NO `innerHTML`, no secret, no proprietary identifier or private path -- generic,
 * verification-domain names only. Offline + deterministic: the inputs ARE on screen, so a judge re-derives
 * every verdict by hand.
 */

import { VERDICT, type Verdict } from "./proofs.js";
import { statusDot } from "./render.js";
import { VERIFIER } from "./spine.js";
import { adjudicateFillUi, FILL_DECISION, type FillDecision } from "./fillproofCard.js";
import { slashUi, MANDATE_STATUS, type MandateStatus } from "./slasherCard.js";

/* ------------------------------------------------------------------------------------------------ *
 * The pure mirrors of the verifier algebra the gauntlet re-uses (computed, never hardcoded).
 * ------------------------------------------------------------------------------------------------ */

/**
 * The SETTLEMENT band algebra, mirroring the Rust `adjudicate` (verifier/src/adjudicate.rs) EXACTLY, in
 * exact-integer BigInt (no float). This is the same band logic {@link adjudicateFillUi} applies on its
 * non-hollow branch, factored out so attacks #1/#2/#3 (and the source leg of #5) re-derive a settlement
 * verdict the same way:
 *   - `observed === null`                 -> `unverified` (no observation -- fail-closed, never fabricate),
 *   - `observed === 0 && claimed > 0`     -> `hollow`     (claimed a positive amount, the chain moved zero),
 *   - `claimed === 0 && observed === 0`   -> `hollow`     (the (0, 0) no-op also resolves to hollow),
 *   - `|claimed - observed| <= floor(|claimed| * num / den)` -> `settled` (chain-confirmed, in-band),
 *   - else                                -> `mismatch`   (a claim that disagrees with the chain).
 */
export function adjudicateUi(
  claimed: bigint,
  observed: bigint | null,
  num: bigint = BigInt(VERIFIER.toleranceNum),
  den: bigint = BigInt(VERIFIER.toleranceDen),
): Verdict {
  if (den <= 0n || num < 0n) {
    // An ill-formed band has no exact-integer meaning -> refuse to settle (fail loud, never fabricate).
    throw new RangeError(`ill-formed tolerance band ${num.toString()}/${den.toString()}`);
  }
  if (observed === null) {
    return VERDICT.UNVERIFIED;
  }
  if (observed === 0n && claimed > 0n) {
    return VERDICT.HOLLOW;
  }
  if (claimed === 0n && observed === 0n) {
    return VERDICT.HOLLOW;
  }
  const mag = claimed < 0n ? -claimed : claimed;
  const delta0 = claimed - observed;
  const delta = delta0 < 0n ? -delta0 : delta0;
  const band = (mag * num) / den; // exact-integer floor division (den > 0).
  return delta <= band ? VERDICT.SETTLED : VERDICT.MISMATCH;
}

/**
 * Fold a SOURCE-lock verdict and a DESTINATION-fill verdict into ONE cross-chain verdict, mirroring the Rust
 * `combine_xchain` (verifier/src/xchain.rs) EXACTLY -- fail-closed precedence: an UNREADABLE leg dominates
 * (`unverified`), then a HOLLOW leg (the release-critical defect), then a `mismatch`, else both `settled`.
 * The precedence order is `unverified > hollow > mismatch > settled` (the journey can never be confirmed if
 * either leg is worse than settled).
 */
export function combineXchain(source: Verdict, dest: Verdict): Verdict {
  if (source === VERDICT.UNVERIFIED || dest === VERDICT.UNVERIFIED) {
    return VERDICT.UNVERIFIED;
  }
  if (source === VERDICT.HOLLOW || dest === VERDICT.HOLLOW) {
    return VERDICT.HOLLOW;
  }
  if (source === VERDICT.MISMATCH || dest === VERDICT.MISMATCH) {
    return VERDICT.MISMATCH;
  }
  return VERDICT.SETTLED;
}

/** The reconcile verdict alphabet, mirroring the Rust `ReconcileVerdict` (verifier/src/reconciler.rs). */
export const RECONCILE_VERDICT = {
  /** Every transfer paired 1:1 to a recorded, cap-bound spend -- the only honest "all spends bound". */
  RECONCILED: "reconciled",
  /** An orphan (a transfer with no record -- the dangerous unbounded spend) -- LOUD "did NOT bind". */
  REFUTED: "refuted",
  /** Nothing to reconcile (no records AND no transfers) -- the honest absence, never a fabricated pass. */
  UNVERIFIED: "unverified",
} as const;

/** A reconcile verdict string. */
export type ReconcileVerdict = (typeof RECONCILE_VERDICT)[keyof typeof RECONCILE_VERDICT];

/** One on-chain transfer observation (a spend the verifier independently read), keyed by its spend id. */
export interface TransferObs {
  /** The spend id this transfer claims to fulfil (the 1:1 pairing key). */
  readonly spendId: number;
  /** The amount moved, MINOR units (exact-integer). */
  readonly amount: bigint;
}

/** One recorded spend the registry accrued (the agent's CLAIM it is about to spend), keyed by its spend id. */
export interface SpendRec {
  /** The monotonic spend id the registry assigned (the 1:1 pairing key). */
  readonly spendId: number;
  /** The accrued amount, MINOR units (exact-integer). */
  readonly amount: bigint;
}

/**
 * RECONCILE a set of recorded spends against a set of on-chain transfers, mirroring the Rust `reconcile`
 * (verifier/src/reconciler.rs) for the gauntlet's purposes -- enough to model attack #8 (a transfer with no
 * matching record). Both empty -> `unverified` (nothing to reconcile -- the honest absence, never a faked
 * pass); ANY orphan (a transfer without a record -- the dangerous unbounded spend -- a record without a
 * transfer, or a paired amount disagreement) -> `refuted`; a perfect 1:1 pairing -> `reconciled`.
 */
export function reconcileUi(records: readonly SpendRec[], transfers: readonly TransferObs[]): ReconcileVerdict {
  if (records.length === 0 && transfers.length === 0) {
    return RECONCILE_VERDICT.UNVERIFIED;
  }
  const recById = new Map<number, bigint>();
  for (const r of records) {
    recById.set(r.spendId, r.amount);
  }
  const txById = new Map<number, bigint>();
  for (const t of transfers) {
    txById.set(t.spendId, t.amount);
  }
  const ids = new Set<number>([...recById.keys(), ...txById.keys()]);
  for (const id of ids) {
    const rec = recById.get(id);
    const tx = txById.get(id);
    if (rec === undefined || tx === undefined || rec !== tx) {
      // An orphan (transfer-without-record / record-without-transfer) or an amount disagreement -> refuted.
      return RECONCILE_VERDICT.REFUTED;
    }
  }
  return RECONCILE_VERDICT.RECONCILED;
}

/* ------------------------------------------------------------------------------------------------ *
 * The attack model -- one row per attack, with its computed (never hardcoded) honest refusal.
 * ------------------------------------------------------------------------------------------------ */

/** One attack on a named honesty guarantee + the verifier's computed refusal + whether it was DEFEATED. */
export interface AttackResult {
  /** 1-based id, for stable display ordering. */
  readonly id: number;
  /** Short name of the attack. */
  readonly name: string;
  /** The honesty guarantee under attack. */
  readonly guarantee: string;
  /** What the attacker tries to do. */
  readonly attempt: string;
  /** The honest refusal we expect (the canonical verdict / decision string the verifier should mint). */
  readonly expectedRefusal: string;
  /** The result the verifier actually computed -- the honest refusal on a defeat (byte-identical to Rust). */
  readonly observed: string;
  /**
   * `true` iff the attack was DEFEATED -- the computed result is NOT the attacker's desired pass
   * (`settled` / `RELEASE` / `ACTIVE` / `reconciled`). `false` would be a catastrophic honesty defect.
   */
  readonly defeated: boolean;
}

/** The canonical band from the spine (`proofagent.toml [verifier.tolerance]`): 15%. */
const NUM = BigInt(VERIFIER.toleranceNum);
const DEN = BigInt(VERIFIER.toleranceDen);
/** The fixed claim every attack uses against the chain (1,000,000 minor units -- the killer headline number). */
const CLAIMED = 1_000_000n;

/** #1 -- fabricate a SETTLED for a tx the chain has no record of. Defeated iff it reads `unverified`. */
function attackFabricatedSettlement(): AttackResult {
  const verdict = adjudicateUi(CLAIMED, null, NUM, DEN); // off-record => no observation => unverified.
  return {
    id: 1,
    name: "Fabricated settlement",
    guarantee: "two-source truth: never fabricate a SETTLED from an unread chain",
    attempt: "Claim a 1,000,000 settlement for a tx the chain has no record of.",
    expectedRefusal: "unverified",
    observed: verdict,
    defeated: verdict !== VERDICT.SETTLED,
  };
}

/** #2 -- claim more than the chain moved. Defeated iff the disagreement reads `mismatch`, never `settled`. */
function attackTamperedAmount(): AttackResult {
  const verdict = adjudicateUi(CLAIMED, 500_000n, NUM, DEN); // |1,000,000 - 500,000| > band -> mismatch.
  return {
    id: 2,
    name: "Tampered amount",
    guarantee: "exact-integer two-source compare: a claim that disagrees with the chain cannot settle",
    attempt: "Claim 1,000,000 settled when the chain shows only 500,000 actually moved.",
    expectedRefusal: "mismatch",
    observed: verdict,
    defeated: verdict !== VERDICT.SETTLED,
  };
}

/** #3 -- call a no-op a settlement. Defeated iff `(0 -> 0)` reads `hollow`, never `settled`. */
function attackPhantomSettlement(): AttackResult {
  const verdict = adjudicateUi(0n, 0n, NUM, DEN); // the (0, 0) no-op resolves to hollow.
  return {
    id: 3,
    name: "Phantom settlement",
    guarantee: "a no-op (nothing moved) can never read as a real settlement",
    attempt: "Settle a transaction where the chain says nothing moved (0 → 0).",
    expectedRefusal: "hollow",
    observed: verdict,
    defeated: verdict !== VERDICT.SETTLED,
  };
}

/** #4 -- claim a fill the chain says delivered nothing. Defeated iff the oracle BLOCKs (never RELEASE). */
function attackHollowFill(): AttackResult {
  const report = adjudicateFillUi(CLAIMED, 0n, NUM, DEN); // claimed payment, moved nothing -> hollow -> BLOCK.
  return {
    id: 4,
    name: "Hollow fill",
    guarantee: "the fill-proof oracle releases a solver ONLY on a chain-confirmed delivery",
    attempt: "Claim a 1,000,000 fill the chain says delivered nothing, to collect the solver's funds.",
    expectedRefusal: "hollow / BLOCK",
    observed: `${report.verdict} / ${report.decision}`,
    defeated: report.decision !== FILL_DECISION.RELEASE,
  };
}

/** #5 -- lock on the source, deliver nothing on the destination. Defeated iff the cross-chain fill BLOCKs. */
function attackCrossChainHollow(): AttackResult {
  // The source genuinely locked 1,000,000 (settled); the destination delivered ZERO (hollow). The fold is
  // fail-closed: hollow has precedence over the source's settled -> the cross-chain fill is hollow -> BLOCK.
  const source = adjudicateUi(CLAIMED, 1_000_000n, NUM, DEN); // settled
  const dest = adjudicateFillUi(CLAIMED, 0n, NUM, DEN).verdict; // hollow
  const verdict = combineXchain(source, dest);
  const decision: FillDecision =
    verdict === VERDICT.SETTLED ? FILL_DECISION.RELEASE : FILL_DECISION.BLOCK;
  return {
    id: 5,
    name: "Cross-chain hollow fill",
    guarantee: "both legs read independently: a source lock with an empty destination cannot release",
    attempt: "Lock 1,000,000 on the source, deliver NOTHING on the destination, claim the cross-chain fill.",
    expectedRefusal: "hollow / BLOCK",
    observed: `${verdict} / ${decision}`,
    defeated: decision !== FILL_DECISION.RELEASE,
  };
}

/** #6 -- lie twice in a row and try to keep spending. Defeated iff the mandate auto-REVOKES. */
function attackRepeatLiar(): AttackResult {
  const status: MandateStatus = slashUi([VERDICT.HOLLOW, VERDICT.HOLLOW]).status; // 2 in a row -> REVOKED.
  return {
    id: 6,
    name: "Repeat liar keeps spending",
    guarantee: "the slasher auto-revokes a solver after consecutive dishonest verdicts",
    attempt: "Lie twice in a row (two hollow fills) and keep the mandate alive.",
    expectedRefusal: "REVOKED",
    observed: status,
    defeated: status !== MANDATE_STATUS.ACTIVE,
  };
}

/** #7 -- a revoked solver tries to collect on a later, genuinely-honest fill. Defeated iff it is WITHHELD. */
function attackSlashBites(): AttackResult {
  // The filler bite: a 3-fill sequence [hollow, hollow, settled]. The mandate standing BEFORE the 3rd fill
  // is the slash projection over the PREFIX [hollow, hollow] -> REVOKED. A revoked mandate withholds even a
  // chain-confirmed (settled) fill -- so the 3rd fill is WITHHELD (the slash bites), never released.
  const sequence: readonly Verdict[] = [VERDICT.HOLLOW, VERDICT.HOLLOW, VERDICT.SETTLED];
  const prefix = sequence.slice(0, 2); // the journal BEFORE the 3rd fill is gated.
  const mandateBefore: MandateStatus = slashUi(prefix).status; // REVOKED
  const thirdFill = adjudicateFillUi(CLAIMED, 1_000_000n, NUM, DEN); // the 3rd fill is genuinely settled.
  // The oracle ALONE would release the 3rd fill; it is released IFF the mandate was active before it.
  const released = thirdFill.decision === FILL_DECISION.RELEASE && mandateBefore === MANDATE_STATUS.ACTIVE;
  const observed = released
    ? `RELEASED (${thirdFill.verdict})`
    : `WITHHELD (${mandateBefore === MANDATE_STATUS.ACTIVE ? "oracle blocked" : "mandate revoked"})`;
  return {
    id: 7,
    name: "Revoked solver collects anyway",
    guarantee: "a revoked mandate withholds even a chain-confirmed fill (the slash bites)",
    attempt: "After being revoked for two lies, deliver one honest fill and try to collect on it.",
    expectedRefusal: "WITHHELD",
    observed,
    // Defeated iff the honest fill was NOT released AND the mandate was actually revoked before it.
    defeated: !released && mandateBefore !== MANDATE_STATUS.ACTIVE,
  };
}

/** #8 -- move value on-chain with no recorded, cap-bound spend. Defeated iff reconciliation REFUTES it. */
function attackUnboundedSpend(): AttackResult {
  // An on-chain transfer with NO matching spend record -- the dangerous unbounded spend the advisory cap did
  // not bind. Reconciliation must refuse it (a transfer-without-record orphan), never `reconciled`.
  const verdict = reconcileUi([], [{ spendId: 1, amount: CLAIMED }]);
  return {
    id: 8,
    name: "Unbounded spend",
    guarantee: "every on-chain transfer must reconcile 1:1 to a recorded, cap-bound spend",
    attempt: "Move 1,000,000 on-chain with NO matching spend record (bypass the advisory cap).",
    expectedRefusal: "refuted",
    observed: verdict,
    defeated: verdict !== RECONCILE_VERDICT.RECONCILED,
  };
}

/**
 * Run the whole break-it gauntlet: construct every adversarial input and compute the verifier's refusal.
 * Returns the per-attack results (in id order) + `allDefeated` -- the only honest pass. Pure, deterministic,
 * offline: the same gauntlet yields the same report every time (mirrors the Rust `run_gauntlet`).
 */
export function runGauntletUi(): { results: AttackResult[]; allDefeated: boolean } {
  const results: AttackResult[] = [
    attackFabricatedSettlement(),
    attackTamperedAmount(),
    attackPhantomSettlement(),
    attackHollowFill(),
    attackCrossChainHollow(),
    attackRepeatLiar(),
    attackSlashBites(),
    attackUnboundedSpend(),
  ];
  return { results, allDefeated: results.every((r) => r.defeated) };
}

/* ------------------------------------------------------------------------------------------------ *
 * The card -- pure DOM, mirrors the existing frontier-card look (dot grammar, lead, button, rows).
 * ------------------------------------------------------------------------------------------------ */

/** The built Break-it gauntlet card (the `root` element the dashboard appends). */
export interface BreakitCard {
  readonly root: HTMLElement;
}

/**
 * Build the Break-it gauntlet card. A "▶ Run the gauntlet" button (and auto-run on first paint) computes all
 * eight attacks through {@link runGauntletUi} and paints one row per attack -- the attempt + the loud red
 * refusal (in the honest colour grammar; every block/refusal is red, exactly the pass the attacker wanted and
 * never got), each tagged "✗ DEFEATED". A big headline reads "8/8 DEFEATED -- every honesty guarantee held",
 * green ONLY when ALL eight are defeated; if any attack ever SUCCEEDED it flips to the loud red defect line.
 * Pure DOM, no innerHTML, key-free, offline, clean-room (generic verification-domain names only).
 */
export function buildBreakitCard(): BreakitCard {
  const root = document.createElement("section");
  root.className = "frontier-card breakit-card";
  root.id = "card-breakit";
  root.setAttribute("aria-label", "Break-it gauntlet — try to make it lie, and watch every attack fail");

  const head = document.createElement("div");
  head.className = "frontier-card__head";
  const dot = statusDot("is-mismatch");
  head.appendChild(dot);
  const h = document.createElement("h2");
  h.className = "frontier-card__title";
  h.textContent = "Break-it — try to make it lie";
  head.appendChild(h);
  root.appendChild(head);

  const lead = document.createElement("p");
  lead.className = "frontier-card__lead";
  lead.textContent =
    "You don't trust it — you try to break it. Run every attack a dishonest agent would, and watch each one " +
    "refused. An attack is DEFEATED only when the verifier returns its honest refusal — never the lie the " +
    "attacker wanted.";
  root.appendChild(lead);

  const row = document.createElement("div");
  row.className = "frontier-card__row";
  root.appendChild(row);

  // The big headline (green only on a FULL 8/8 defeat; the loud red defect line if any attack ever succeeds).
  const headline = document.createElement("p");
  headline.className = "verdict-headline breakit-card__headline";
  root.appendChild(headline);

  // The per-attack list (one row per attack: the attempt + the loud refusal, tagged ✗ DEFEATED).
  const list = document.createElement("ol");
  list.className = "breakit-card__list";
  list.setAttribute("role", "list");
  root.appendChild(list);

  const render = (): void => {
    const report = runGauntletUi();
    const defeatedCount = report.results.filter((r) => r.defeated).length;
    const total = report.results.length;

    // The header dot + big headline track the aggregate honesty: green ONLY on a full defeat, else loud red.
    dot.className = `status-dot ${report.allDefeated ? "is-settled" : "is-mismatch"}`;
    headline.className = `verdict-headline breakit-card__headline ${report.allDefeated ? "is-settled" : "is-mismatch"}`;
    headline.textContent = report.allDefeated
      ? `${defeatedCount}/${total} DEFEATED — every honesty guarantee held`
      : `!!! ${total - defeatedCount}/${total} ATTACK(S) SUCCEEDED — an honesty guarantee was broken`;

    list.replaceChildren();
    for (const attack of report.results) {
      const li = document.createElement("li");
      li.className = "breakit-card__attack";
      li.setAttribute("data-attack", String(attack.id));
      li.setAttribute("data-defeated", String(attack.defeated));

      // The attempt -- what the attacker tried (the dishonest move).
      const attempt = document.createElement("p");
      attempt.className = "breakit-card__attempt";
      const name = document.createElement("span");
      name.className = "breakit-card__name";
      name.textContent = `${attack.id}. ${attack.name}`;
      attempt.appendChild(name);
      attempt.appendChild(document.createTextNode(` — ${attack.attempt}`));
      li.appendChild(attempt);

      // The refusal -- the loud red verdict the verifier computed (the honest refusal on a defeat), with the
      // ✗ DEFEATED tag (green tag on a defeat -- the guarantee HELD; a loud red SUCCEEDED tag is a defect).
      const refusal = document.createElement("p");
      const refusalClass = attack.defeated ? "is-mismatch" : "is-settled";
      refusal.className = `breakit-card__refusal ${refusalClass}`;
      const tag = document.createElement("span");
      tag.className = `breakit-card__tag ${attack.defeated ? "is-defeated" : "is-succeeded"}`;
      tag.textContent = attack.defeated ? "✗ DEFEATED" : "‼ SUCCEEDED";
      refusal.appendChild(tag);
      const verdictText = document.createElement("span");
      verdictText.className = "breakit-card__verdict mono-num";
      verdictText.textContent = ` → ${attack.observed}`;
      refusal.appendChild(verdictText);
      li.appendChild(refusal);

      list.appendChild(li);
    }

    root.setAttribute("data-defeated", String(defeatedCount));
    root.setAttribute("data-total", String(total));
    root.setAttribute("data-all-defeated", String(report.allDefeated));
  };

  const runBtn = document.createElement("button");
  runBtn.type = "button";
  runBtn.id = "breakit-run";
  runBtn.className = "frontier-card__btn";
  runBtn.textContent = "▶ Run the gauntlet";
  runBtn.addEventListener("click", () => {
    render();
  });
  row.appendChild(runBtn);

  // Auto-run on first paint: the gauntlet is pure + offline, so the card shows 8/8 DEFEATED with zero clicks
  // and zero network round-trip -- the honest centerpiece a judge can re-derive by hand.
  render();

  return { root };
}
