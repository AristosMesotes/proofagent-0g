/**
 * dryrunView.ts -- the DOM half of the "Run the agent (dry-run)" affordance (design §3, §4, §5, §6, §8).
 *
 * Mounts ONE card on the console: a "Run the agent (dry-run)" button that walks the full agent function
 * READ-ONLY (NO wallet, NO broadcast) and paints, per leg: the planned intent, the PER-ASSET mandate gate
 * decision (a real read-only `checkTransfer`, reconciled vs an independent re-read), the settlement verdict
 * that would settle, and -- as the RESULT -- the RUN LEDGER in the verifier's OWN journal/ledger format.
 *
 * ## What it REUSES (does not reinvent -- design §7)
 *   - the pure dry-run engine {@link ./dryrun.ts} (`runDryRun`, the per-asset gate + the ledger projection),
 *   - the read-only {@link ./onchain.ts} `RpcTransport` seam (no signing surface by construction) +
 *     `runMandateCheck` for the independent reconciliation re-read,
 *   - the {@link ./render.ts} primitives (the `Card` chrome, three-altitude block, status dot -- pure DOM),
 *   - the {@link ./reconcile.ts} badge + `decideReconcile` (the badge greens ONLY from an INDEPENDENT re-read).
 *
 * ## Honesty (design §8) -- the whole point
 *   - The card is LABELLED a dry-run: nothing is signed or broadcast; the only chain access is the read-only
 *     `checkTransfer` eth_call. Each leg's mandate decision is reconciled against an INDEPENDENT re-read of the
 *     same gate; a gate read failure is a LOUD read-error (fail-closed: NOT executed), never a faked allow.
 *   - The settlement verdict is the verifier's `unverified` (a dry-run broadcasts nothing → nothing settled);
 *     the RUN LEDGER's status line reads `DEFECTS … unverified` honestly (an all-`unverified` dry-run is NOT
 *     GREEN), exactly as `verifier ledger` would project it. The Brain stamp stays PENDING (operator-gated).
 *
 * ## Clean-room (design §6)
 * Pure DOM, NO `innerHTML`. No proprietary identifier, private path, or secret -- only the read-only public
 * 0G RPC + the public spine constants. Generic, verification-domain names only.
 */

import { card, statusDot, shortHash, renderThreeAltitude } from "./render.js";
import {
  runMandateCheck,
  type RpcTransport,
} from "./onchain.js";
import {
  ReconcileBadge,
  decideReconcile,
  type IndependentResult,
  type ReconcileState,
} from "./reconcile.js";
import {
  runDryRun,
  DRY_RUN_AGENT,
  DRY_RUN_REGISTRY,
  MANDATE_DECISION,
  type DryRunLeg,
  type DryRunResult,
  type RunLedgerRow,
} from "./dryrun.js";

/** What the host wires so a dry-run leg can stamp a feed row + record evidence (optional). */
export interface DryRunListeners {
  /** Called once per leg with its mandate decision + reconcile state (for the live feed / evidence). */
  readonly onLeg?: (leg: DryRunLeg, reconcile: ReconcileState) => void;
  /** Called once after the whole run with the projected RUN LEDGER (for the evidence drawer). */
  readonly onLedger?: (result: DryRunResult) => void;
}

/** The built dry-run card (its root element to append to the page). */
export interface BuiltDryRun {
  readonly root: HTMLElement;
}

/** A short, human label for a mandate-decision family (the per-asset enforcement, in plain words). */
function decisionLabel(decision: string): string {
  switch (decision) {
    case MANDATE_DECISION.ALLOWED:
      return "ALLOWED — within the per-asset cap";
    case MANDATE_DECISION.OVER_ASSET_CAP:
      return "BLOCKED — over the asset's cap";
    case MANDATE_DECISION.NOT_ALLOWLISTED:
      return "BLOCKED — asset not on the allowlist";
    case MANDATE_DECISION.BLOCKED_OTHER:
      return "BLOCKED — mandate refused";
    default:
      return "READ-ERROR — gate unreadable (fail-closed)";
  }
}

/** The honesty colour-state class for a mandate decision (ALLOWED is green; a block is amber; read-error grey). */
function decisionStateClass(decision: string): string {
  switch (decision) {
    case MANDATE_DECISION.ALLOWED:
      return "is-settled";
    case MANDATE_DECISION.READ_ERROR:
      return "is-read-error";
    default:
      // Every BLOCK family (over-cap / not-allowlisted / other) is the honest amber "the system worked" face.
      return "is-pending";
  }
}

/**
 * Build the "Run the agent (dry-run)" card. The button runs the full READ-ONLY dry-run: plan → per-asset
 * mandate gate (reconciled) → the settlement verdict that would settle → the RUN LEDGER. First paint shows
 * the honest "not run yet" state with ZERO network round-trip.
 *
 * @param transport the read-only RPC seam (a live browser reader, or a test double).
 * @param listeners optional hooks so the host stamps a feed row per leg + records the ledger evidence.
 */
export function buildDryRun(transport: RpcTransport, listeners?: DryRunListeners): BuiltDryRun {
  const { root, body } = card({ title: "Run the agent (dry-run) — plan → mandate-by-asset → verifier verdict", id: "dryrun" });
  root.classList.add("dryrun");
  root.setAttribute("data-surface", "dryrun");

  // The honest, prominent dry-run label.
  const lead = document.createElement("p");
  lead.className = "dryrun__lead";
  lead.textContent =
    "Walk the full agent function READ-ONLY: NO wallet, NO signing, NOTHING broadcast. The only chain access " +
    "is the same key-less, zero-gas checkTransfer eth_call behind the RAILS proof. Each leg's gate decision is " +
    "reconciled against an independent re-read; the result is a RUN LEDGER in the verifier's own format.";
  body.appendChild(lead);

  // The plan facts (agent + registry the gate reads), shown up front so the reader sees exactly what is gated.
  const facts = document.createElement("dl");
  facts.className = "dryrun__facts";
  const fact = (term: string, value: string, mono: boolean): void => {
    const dt = document.createElement("dt");
    dt.textContent = term;
    const dd = document.createElement("dd");
    if (mono) {
      dd.className = "mono-num";
    }
    dd.textContent = value;
    facts.appendChild(dt);
    facts.appendChild(dd);
  };
  fact("agent", shortHash(DRY_RUN_AGENT), true);
  fact("registry", shortHash(DRY_RUN_REGISTRY), true);
  body.appendChild(facts);

  // The run button.
  const button = document.createElement("button");
  button.type = "button";
  button.className = "proof-card__button dryrun__button";
  button.textContent = "Run the agent (dry-run) → gate 3 intents, project the run ledger";
  body.appendChild(button);

  // An honest brain-mode caption: this OFFLINE console plans deterministically (there is no key in the
  // browser); the live agent runs a CONFIGURABLE hosted-LLM brain -- a CLAIM the on-chain verifier checks,
  // never trusted. It never claims the hosted brain runs in-browser, and it does NOT green the 0G-Compute
  // pillar (the 0G Compute TEE attestation -- "which model ran on 0G" -- is the separate operator-gated layer).
  const brainNote = document.createElement("p");
  brainNote.className = "verdict-why dryrun__brain-note";
  brainNote.textContent =
    "Brain: this console plans deterministically (no key in the browser). The live agent runs a configurable " +
    "hosted-LLM brain — a CLAIM the on-chain verifier checks; the 0G Compute TEE attestation (which model ran) " +
    "is the operator-gated layer. We never fake green.";
  body.appendChild(brainNote);

  // The legs list (one block per intent) + the run-ledger panel — both filled on a run.
  const legsHost = document.createElement("div");
  legsHost.className = "dryrun__legs";
  legsHost.setAttribute("role", "status");
  legsHost.setAttribute("aria-live", "polite");
  body.appendChild(legsHost);

  const ledgerHost = document.createElement("div");
  ledgerHost.className = "dryrun__ledger";
  body.appendChild(ledgerHost);

  button.addEventListener("click", () => {
    button.disabled = true;
    legsHost.replaceChildren();
    ledgerHost.replaceChildren();
    const pending = document.createElement("p");
    pending.className = "verdict-why";
    pending.textContent = "Planning 3 demo intents and gating each PER ASSET on 0G (read-only eth_call, no broadcast)…";
    legsHost.appendChild(pending);

    void runAndRender(transport, legsHost, ledgerHost, listeners).finally(() => {
      button.disabled = false;
    });
  });

  return { root };
}

/** Run the dry-run and render every leg + the run ledger; reconcile each gate decision via an independent re-read. */
async function runAndRender(
  transport: RpcTransport,
  legsHost: HTMLElement,
  ledgerHost: HTMLElement,
  listeners?: DryRunListeners,
): Promise<void> {
  let result: DryRunResult;
  try {
    result = await runDryRun(transport);
  } catch (err) {
    // runDryRun never throws for a gate failure, but guard defensively — a thrown error is a loud diagnostic.
    legsHost.replaceChildren();
    const diag = document.createElement("p");
    diag.className = "neg__diag";
    diag.textContent = `dry-run error: ${err instanceof Error ? err.message : String(err)}`;
    legsHost.appendChild(diag);
    return;
  }

  legsHost.replaceChildren();
  for (const leg of result.legs) {
    // Independent reconcile: replay the SAME read-only gate eth_call and compare the decoded reason.
    const independent = await independentGate(transport, leg);
    const state = decideReconcile(leg.mandateReason, independent);
    legsHost.appendChild(renderLeg(leg, state));
    if (listeners?.onLeg !== undefined) {
      listeners.onLeg(leg, state);
    }
  }

  ledgerHost.replaceChildren();
  ledgerHost.appendChild(renderRunLedger(result));
  if (listeners?.onLedger !== undefined) {
    listeners.onLedger(result);
  }
}

/** Independently re-derive a leg's gate verdict by replaying the SAME read-only eth_call; null if unreachable. */
async function independentGate(transport: RpcTransport, leg: DryRunLeg): Promise<IndependentResult> {
  if (leg.decision === MANDATE_DECISION.READ_ERROR) {
    return { verdict: null }; // the source was unreachable on the first read → honest infra-gated.
  }
  try {
    const replay = await runMandateCheck(
      transport,
      { agent: DRY_RUN_AGENT, token: leg.intent.token, amount: leg.intent.amount },
      DRY_RUN_REGISTRY,
    );
    return { verdict: replay.verdict };
  } catch {
    return { verdict: null };
  }
}

/** Render one dry-run leg: the planned intent, the per-asset gate decision (+ reconcile badge), the verdict. */
function renderLeg(leg: DryRunLeg, reconcile: ReconcileState): HTMLElement {
  const block = document.createElement("article");
  block.className = "dryrun-leg";
  block.setAttribute("data-leg", leg.intent.id);
  block.setAttribute("data-decision", leg.decision);

  // Head: the planned intent (asset + amount) + a status dot for the decision family.
  const head = document.createElement("div");
  head.className = "dryrun-leg__head";
  head.appendChild(statusDot(decisionStateClass(leg.decision)));
  const title = document.createElement("h3");
  title.className = "dryrun-leg__title";
  title.textContent = leg.intent.label;
  head.appendChild(title);
  block.appendChild(head);

  const plan = document.createElement("p");
  plan.className = "dryrun-leg__plan mono-num";
  plan.textContent = `plan: transfer ${leg.intent.amount.toString()} wei of ${leg.intent.assetName}`;
  block.appendChild(plan);

  // The PER-ASSET mandate decision (the three-altitude block, with the data-verdict for the harness).
  const gateOut = document.createElement("div");
  gateOut.className = "dryrun-leg__gate";
  renderThreeAltitude(
    gateOut,
    leg.mandateReason,
    `Mandate (by asset): ${decisionLabel(leg.decision)}. ` +
      (leg.allowed
        ? `The chain ALLOWED this asset+amount as a zero-gas eth_call — the agent could execute it in a live run.`
        : `The chain BLOCKED this leg pre-broadcast — the agent does NOT execute it (the kill-switch).`),
    `checkTransfer(agent, ${leg.intent.token}, ${leg.intent.amount.toString()}) → ${leg.allowed ? "(true, " : "(false, "}${leg.mandateReason})` +
      `  ·  reproduce: ${leg.mandateReproduce}`,
  );
  block.appendChild(gateOut);

  // The reconciliation badge (greened ONLY by the independent re-read of the same gate).
  const badgeRow = document.createElement("div");
  badgeRow.className = "dryrun-leg__recon";
  const badge = new ReconcileBadge("0G RPC");
  badge.set(reconcile);
  badgeRow.appendChild(badge.element());
  block.appendChild(badgeRow);

  // The settlement verdict that WOULD settle (the verifier's verdict — unverified in a dry-run).
  const settleOut = document.createElement("div");
  settleOut.className = "dryrun-leg__settle";
  renderThreeAltitude(
    settleOut,
    leg.settlementVerdict,
    leg.settlementWhy,
    `verifier verdict (dry-run, nothing broadcast) → ${leg.settlementVerdict}  ·  reproduce: ${leg.settlementReproduce}`,
  );
  block.appendChild(settleOut);

  return block;
}

/**
 * Render the RUN LEDGER (design §6): the canonical journal lines (one per leg) + the status-at-a-glance, in
 * the verifier's OWN format — the IDENTICAL artifact `verifier verify-tx … --journal` + `verifier ledger`
 * produces. A per-leg table makes the claimed/observed/Δ/verdict readable; the journal block is the verbatim,
 * copy-safe artifact a judge can paste back into `verifier`.
 */
function renderRunLedger(result: DryRunResult): HTMLElement {
  const panel = document.createElement("section");
  panel.className = "dryrun-ledger";
  panel.setAttribute("aria-label", "Run ledger — the settlement-truth journal of this dry-run");

  const heading = document.createElement("h3");
  heading.className = "dryrun-ledger__heading";
  heading.textContent = "Run ledger — the settlement-truth journal of this run";
  panel.appendChild(heading);

  const note = document.createElement("p");
  note.className = "dryrun-ledger__note";
  note.textContent =
    "Append-only, deterministic, redacted — the SAME format the independent verifier journals (no wall-clock, " +
    "no path, no secret). A dry-run leg broadcast nothing, so its observed is null and its verdict is unverified; " +
    "the status line reads DEFECTS honestly (an all-unverified dry-run is NOT green) and audit would surface " +
    "those rows loud, exit 1 — never a fabricated settled.";
  panel.appendChild(note);

  // The per-leg table (claimed / observed / Δ / verdict) — the ledger projection, readable.
  const table = document.createElement("table");
  table.className = "dryrun-ledger__table mono-num";
  const thead = document.createElement("thead");
  const htr = document.createElement("tr");
  for (const h of ["Hash", "Kind", "Claimed (wei)", "Observed", "Δ", "Verdict"]) {
    const th = document.createElement("th");
    th.textContent = h;
    htr.appendChild(th);
  }
  thead.appendChild(htr);
  table.appendChild(thead);
  const tbody = document.createElement("tbody");
  for (const row of result.ledgerRows) {
    tbody.appendChild(renderLedgerTableRow(row));
  }
  table.appendChild(tbody);
  panel.appendChild(table);

  // The canonical JSONL journal block (verbatim, copy-safe) + the status line — the verifier's own artifact.
  const journalTitle = document.createElement("p");
  journalTitle.className = "dryrun-ledger__subtitle";
  journalTitle.textContent = "the canonical verdict journal (verifier journal lines) + the ledger projection:";
  panel.appendChild(journalTitle);

  const pre = document.createElement("pre");
  pre.className = "dryrun-ledger__journal mono-num";
  const lines = [
    ...result.journalLines,
    "",
    `# verifier ledger --journal <run.journal>`,
    result.statusLine,
  ];
  pre.textContent = lines.join("\n");
  panel.appendChild(pre);

  return panel;
}

/** Render one ledger table row (the ledger projection: hash · kind · claimed · observed · Δ · verdict). */
function renderLedgerTableRow(row: RunLedgerRow): HTMLElement {
  const tr = document.createElement("tr");
  tr.setAttribute("data-verdict", row.verdict);
  const cell = (text: string): void => {
    const td = document.createElement("td");
    td.textContent = text;
    tr.appendChild(td);
  };
  cell(shortHash(row.hash));
  cell(row.kind);
  cell(row.claimed.toString());
  cell(row.observed === null ? "unavailable" : row.observed.toString());
  cell(row.delta === null ? "unavailable" : row.delta.toString());
  cell(row.verdict);
  return tr;
}
