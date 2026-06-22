/**
 * playground.ts -- THE one bespoke widget: paste ANY 0G tx hash -> a live verifier verdict (design §3 D,
 * §4.3 "The Playground", §5.2 paste-a-hash flow, §8 honesty).
 *
 * A judge tests the claim with THEIR OWN hash: paste a `0x + 64 hex` hash, click Check, and watch the SAME
 * verifier pipeline that backs the SETTLEMENT card stamp a verdict live -- reading the chain independently
 * of this UI, narrating each wait, and showing claimed-vs-observed SIDE BY SIDE so the cross-check (not a
 * bare checkmark) IS the verdict.
 *
 * ## What it REUSES (does not reinvent -- design §7)
 *
 *   - the read-only {@link ./onchain.ts} `RpcTransport` seam (no signing surface by construction) and the
 *     GENERALIZED `runSettledCheck(transport, hash)` -- the SAME receipt+value+`adjudicate` pipeline the
 *     SETTLEMENT card runs, just parameterized by the pasted hash (a thin, backward-compatible generalization),
 *   - the {@link ./render.ts} primitives (the `Card` chrome, the three-altitude block, the short-hash + status
 *     dot, the `data-verdict` discipline -- pure DOM, no innerHTML),
 *   - the {@link ./verdictCopy.ts} dictionary (raw verdict -> headline + why; unmapped -> the raw code),
 *   - the {@link ./reconcile.ts} badge + `decideReconcile` (the badge greens ONLY from an INDEPENDENT re-read).
 *
 * ## Honesty (design §8) -- the whole point, applied to the playground
 *
 *   - A MALFORMED input is a LOUD usage diagnostic, NOT a verdict (mirrors `runNegCase`'s `RangeError`). No
 *     `data-verdict` is minted, no feed row is appended -- the absence of a verdict is the honest signal.
 *   - The pipeline MINTS no verdict: it carries `adjudicate`'s published rule. A pasted hash has NO recorded
 *     claim, so it can ONLY reach `unverified` (off-record), `mismatch` (failed/out-of-band), or `hollow`
 *     (zero value) -- there is NO code path to a fabricated `settled` for a hash the spine does not pin.
 *   - An UNREACHABLE RPC degrades LOUDLY to `read-error` (grey, infra-gated) -- never a faked pass.
 *   - The output container emits `data-verdict` through its FULL lifecycle (absent -> `pending` -> the verdict
 *     -> `read-error`) so the headless harness reconciles every pasted-hash verdict independently.
 *
 * ## Clean-room (design §6)
 *
 * Pure DOM, NO `innerHTML`. No proprietary identifier, private path, or secret -- only the read-only public
 * 0G RPC and the public spine constants. Generic, verification-domain names only.
 */

import { runSettledCheck, type RpcTransport, type SettledResult } from "./onchain.js";
import { card, renderThreeAltitude, statusDot } from "./render.js";
import { verdictCopyFor } from "./verdictCopy.js";
import { ReconcileBadge, RECONCILE, decideReconcile, type IndependentResult } from "./reconcile.js";

/* ------------------------------------------------------------------------------------------------ *
 * Hash validation -- a usage error is NOT a verdict (design §4.3 / §5.2).
 * ------------------------------------------------------------------------------------------------ */

/** A 32-byte (0x + 64 hex) transaction-hash shape -- the verifier's hash-shape gate. */
const TX_HASH_RE = /^0x[0-9a-fA-F]{64}$/;

/** A loud usage error: the input is not a transaction hash at all (distinct from any verdict). */
export class PlaygroundUsageError extends Error {
  public override readonly name = "PlaygroundUsageError";
  public constructor(message: string) {
    super(message);
    Object.setPrototypeOf(this, PlaygroundUsageError.prototype);
  }
}

/**
 * Validate + normalize a pasted hash to the canonical `0x + 64 hex` shape, or throw a LOUD
 * {@link PlaygroundUsageError} (design §4.3 -- a malformed input is a usage diagnostic, never a verdict).
 * Trims surrounding whitespace and lower-cases the hex; it does NOT pad, truncate, or coerce a bad shape.
 *
 * @param raw the pasted input.
 * @returns the normalized hash.
 * @throws {PlaygroundUsageError} if the input is empty or not a 0x + 64-hex tx hash.
 */
export function validateHash(raw: string): string {
  // Normalize FIRST (trim + lower-case) so an upper-cased `0X`/hex still resolves, then gate the shape.
  const normalized = (typeof raw === "string" ? raw.trim() : "").toLowerCase();
  if (normalized.length === 0) {
    throw new PlaygroundUsageError("Paste a transaction hash first (0x followed by 64 hex characters).");
  }
  if (!TX_HASH_RE.test(normalized)) {
    throw new PlaygroundUsageError(
      `Not a transaction hash. Expected 0x + 64 hex characters, got ${JSON.stringify(raw)} ` +
        `(${normalized.length} chars). No verdict was minted — fix the hash and try again.`,
    );
  }
  return normalized;
}

/* ------------------------------------------------------------------------------------------------ *
 * The named intermediate states (design §4.3 / §5.2) -- narrate the wait, never a bare spinner.
 * ------------------------------------------------------------------------------------------------ */

/**
 * The named wait states of one playground check (design §4.3 -- "each a sentence, not a bare spinner").
 * They narrate the lifecycle the user watches: validating the hash, fetching the receipt, cross-checking
 * the chain, then a terminal state (confirmed / off-record / unreachable). The `idle` state is the empty
 * skeleton before any paste.
 */
export const PLAYGROUND_STATE = {
  /** Before any paste -- the empty skeleton that teaches the verdict shape. */
  IDLE: "idle",
  /** Checking the pasted input is a real `0x + 64 hex` hash. */
  VALIDATING: "validating hash",
  /** Reading the transaction receipt from the chain (read-only, no broadcast). */
  FETCHING: "fetching receipt",
  /** Cross-checking the claim against the chain's observed value (recomputing `adjudicate`). */
  CROSS_CHECKING: "cross-checking chain",
  /** A verdict was produced and reconciled (the terminal happy/honest state). */
  CONFIRMED: "confirmed",
  /** The RPC was unreachable -- honestly infra-gated, never a faked pass. */
  UNREACHABLE: "source unreachable",
} as const;

/** A named playground wait/terminal state. */
export type PlaygroundState = (typeof PLAYGROUND_STATE)[keyof typeof PLAYGROUND_STATE];

/** Human copy for each named state -- the sentence the wait line shows (design §4.3). */
const STATE_COPY: Readonly<Record<PlaygroundState, string>> = {
  [PLAYGROUND_STATE.IDLE]: "Awaiting a hash — paste any 0G tx hash above to see the verifier's verdict.",
  [PLAYGROUND_STATE.VALIDATING]: "Validating the hash shape (0x + 64 hex)…",
  [PLAYGROUND_STATE.FETCHING]: "Reading the transaction receipt from 0G (read-only, no broadcast)…",
  [PLAYGROUND_STATE.CROSS_CHECKING]: "Cross-checking the claim against the chain's observed value…",
  [PLAYGROUND_STATE.CONFIRMED]: "Verdict produced — reconciling against an independent re-read…",
  [PLAYGROUND_STATE.UNREACHABLE]: "The 0G RPC could not be reached — shown honestly as infra-gated, never faked.",
};

/* ------------------------------------------------------------------------------------------------ *
 * The check engine -- a thin orchestration over the reused pipeline, with named-state callbacks.
 * ------------------------------------------------------------------------------------------------ */

/** A callback the engine fires as it moves through the named wait states (so the UI can narrate). */
export type StateListener = (state: PlaygroundState) => void;

/**
 * Run one playground check over the REUSED settlement pipeline, parameterized by the pasted hash, emitting
 * the named wait states as it goes (design §4.3 / §5.2). It validates the hash (a usage error throws BEFORE
 * any read -- no verdict minted), reads the receipt, then cross-checks the value via the SAME generalized
 * `runSettledCheck(transport, hash)`. It MINTS no verdict -- it returns whatever the published `adjudicate`
 * rule produced.
 *
 * @param transport the read-only RPC seam.
 * @param raw the pasted input (validated inside).
 * @param onState an optional listener fired with each named state.
 * @returns the settled result (verdict + claimed + observed + evidence).
 * @throws {PlaygroundUsageError} if the input is not a tx hash (a usage error, never a verdict).
 * @throws {OnChainReadError} if the RPC is unreachable/malformed (a loud degrade, never a fabricated pass).
 */
export async function runPlaygroundCheck(
  transport: RpcTransport,
  raw: string,
  onState?: StateListener,
): Promise<SettledResult> {
  const emit = (state: PlaygroundState): void => {
    if (onState !== undefined) {
      onState(state);
    }
  };
  emit(PLAYGROUND_STATE.VALIDATING);
  const hash = validateHash(raw); // throws a usage error BEFORE any read -> no verdict minted.
  emit(PLAYGROUND_STATE.FETCHING);
  // The SAME receipt+value+adjudicate pipeline the SETTLEMENT card runs, parameterized by the pasted hash.
  // (runSettledCheck reads the receipt first, then the value; the cross-check is the adjudication.)
  emit(PLAYGROUND_STATE.CROSS_CHECKING);
  const result = await runSettledCheck(transport, hash);
  emit(PLAYGROUND_STATE.CONFIRMED);
  return result;
}

/* ------------------------------------------------------------------------------------------------ *
 * The widget DOM -- input + Check button + named-wait line + three-altitude + two-source + verbatim line.
 * ------------------------------------------------------------------------------------------------ */

/** The handles a built playground exposes so its host can observe verdicts (e.g. append to the feed). */
export interface BuiltPlayground {
  /** The widget root element (append it into the page). */
  readonly root: HTMLElement;
}

/** A callback fired with each PRODUCED verdict (a usage error does NOT fire it -- no verdict was minted). */
export type VerdictListener = (result: SettledResult) => void;

/** Build the empty two-source skeleton rows (design §4.3 -- teach the verdict shape before any paste). */
function buildTwoSource(): { panel: HTMLElement; claimedEl: HTMLElement; observedEl: HTMLElement } {
  const panel = document.createElement("div");
  panel.className = "pg-twosource";

  const make = (title: string, sub: string): { col: HTMLElement; valueEl: HTMLElement } => {
    const col = document.createElement("div");
    col.className = "pg-twosource__col";
    const h = document.createElement("p");
    h.className = "pg-twosource__title";
    h.textContent = title;
    const valueEl = document.createElement("p");
    valueEl.className = "pg-twosource__value mono-num";
    valueEl.textContent = "—";
    const subEl = document.createElement("p");
    subEl.className = "pg-twosource__sub";
    subEl.textContent = sub;
    col.appendChild(h);
    col.appendChild(valueEl);
    col.appendChild(subEl);
    return { col, valueEl };
  };

  const claimed = make("Claimed", "what is recorded (the spine corpus)");
  const observed = make("Observed", "what the chain shows (this page's own RPC)");
  panel.appendChild(claimed.col);
  panel.appendChild(observed.col);
  return { panel, claimedEl: claimed.valueEl, observedEl: observed.valueEl };
}

/**
 * Build + wire THE playground widget (design §4.3). Lays out the input + Check button, a named-wait line, the
 * three-altitude verdict block, the two-source (claimed | observed) panel, a persistent verbatim result line,
 * and a reconciliation badge. On Check it runs {@link runPlaygroundCheck}; a usage error is a loud diagnostic
 * (no verdict, no `data-verdict`); a verdict drives the three-altitude block + two-source + the badge (greened
 * ONLY by an independent re-read) and fires `onVerdict` for the host (e.g. the feed). Pure DOM, no innerHTML.
 *
 * @param transport the read-only RPC seam (a live reader by default; a test double in tests).
 * @param onVerdict an optional listener fired with each PRODUCED verdict (never for a usage error).
 */
export function buildPlayground(transport: RpcTransport, onVerdict?: VerdictListener): BuiltPlayground {
  const { root, body } = card({ title: "Playground — paste ANY 0G tx hash", id: "playground" });
  root.classList.add("playground");

  const lead = document.createElement("p");
  lead.className = "pg-lead";
  lead.textContent =
    "Test the claim with your OWN hash. The same verifier pipeline reads 0G independently and stamps a " +
    "verdict — settled, unverified, hollow, or mismatch — with the claimed and observed values shown side " +
    "by side. The cross-check is the verdict; the UI is never trusted.";
  body.appendChild(lead);

  // --- input row: a 0x… hash field + a Check button ---
  const inputRow = document.createElement("div");
  inputRow.className = "pg-inputrow";

  const input = document.createElement("input");
  input.type = "text";
  input.className = "pg-input mono-num";
  input.setAttribute("spellcheck", "false");
  input.setAttribute("autocomplete", "off");
  input.setAttribute("aria-label", "Paste a 0G transaction hash (0x + 64 hex)");
  input.placeholder = "0x… (a 32-byte 0G tx hash)";

  const checkBtn = document.createElement("button");
  checkBtn.type = "button";
  checkBtn.className = "pg-check";
  checkBtn.textContent = "Check";

  inputRow.appendChild(input);
  inputRow.appendChild(checkBtn);
  body.appendChild(inputRow);

  // --- the named-wait line (a sentence, never a bare spinner) ---
  const waitLine = document.createElement("p");
  waitLine.className = "pg-wait";
  waitLine.setAttribute("role", "status");
  waitLine.setAttribute("aria-live", "polite");
  const waitDot = statusDot("is-pending");
  const waitText = document.createElement("span");
  waitText.textContent = STATE_COPY[PLAYGROUND_STATE.IDLE];
  waitLine.appendChild(waitDot);
  waitLine.appendChild(waitText);
  body.appendChild(waitLine);

  const setWait = (state: PlaygroundState, errorState = false): void => {
    // The wait dot is amber/neutral (pending) through the named waits; grey (read-error) only on a degrade.
    waitDot.className = `status-dot ${errorState ? "is-read-error" : "is-pending"}`;
    waitText.textContent = STATE_COPY[state];
  };

  // --- the three-altitude verdict output container (the harness reads its data-verdict) ---
  const out = document.createElement("div");
  out.className = "pg-output proof-card__output";
  out.setAttribute("role", "status");
  out.setAttribute("aria-live", "polite");
  // Empty skeleton: teach the shape before any paste (no data-verdict yet -> absent is the honest signal).
  renderSkeleton(out);
  body.appendChild(out);

  // --- the two-source (claimed | observed) panel ---
  const twoSource = buildTwoSource();
  body.appendChild(twoSource.panel);

  // --- the persistent, verbatim result line (never truncated -- the canonical evidence) ---
  const verbatim = document.createElement("p");
  verbatim.className = "pg-verbatim mono-num";
  verbatim.textContent = "verify-tx(—) → awaiting a hash";
  body.appendChild(verbatim);

  // --- the reconciliation badge (greens ONLY from an independent re-read) ---
  const badge = new ReconcileBadge("verifier");
  const badgeRow = document.createElement("div");
  badgeRow.className = "proof-card__recon";
  badgeRow.appendChild(badge.element());
  body.appendChild(badgeRow);

  // --- wire Check ---
  let inFlight = false;
  const onCheck = (): void => {
    if (inFlight) {
      return;
    }
    inFlight = true;
    checkBtn.disabled = true;

    // Validate the shape FIRST -- a usage error is a loud diagnostic, NOT a verdict (no data-verdict minted).
    setWait(PLAYGROUND_STATE.VALIDATING);
    let hash: string;
    try {
      hash = validateHash(input.value);
    } catch (err) {
      renderUsageDiag(out, err instanceof Error ? err.message : String(err));
      setWait(PLAYGROUND_STATE.IDLE, true);
      twoSource.claimedEl.textContent = "—";
      twoSource.observedEl.textContent = "—";
      verbatim.textContent = `verify-tx(${input.value.trim() || "—"}) → usage error (no verdict minted)`;
      badge.set(RECONCILE.PENDING);
      inFlight = false;
      checkBtn.disabled = false;
      return; // a usage error mints no verdict and appends no feed row.
    }

    // A valid hash -> the read. Mark the output pending (data-verdict lifecycle: absent -> pending).
    out.replaceChildren();
    out.setAttribute("data-verdict", "pending");
    const pend = document.createElement("p");
    pend.className = "verdict-why";
    pend.textContent = "Reading the chain for this hash (receipt + value, no broadcast)…";
    out.appendChild(pend);
    badge.set(RECONCILE.CHECKING);
    verbatim.textContent = `verify-tx(${hash}) → reading…`;

    runPlaygroundCheck(transport, input.value, (state) => {
      setWait(state);
    })
      .then(async (result) => {
        renderVerdict(out, result);
        // Two-source: claimed (what's recorded) | observed (the chain's native value, this page's own RPC).
        // A pasted hash has NO claim on record (`null`) -> the cross-check is honestly "nothing to verify
        // against", shown side by side with the real observed value (the cross-check IS the verdict).
        twoSource.claimedEl.textContent =
          result.claimed === null ? "no claim on record" : `${result.claimed.toString()} wei`;
        twoSource.observedEl.textContent =
          result.observed === null ? "∅ (off-record)" : `${result.observed.toString()} wei`;
        // The persistent verbatim line -- the exact hash + verdict, never truncated, copy-safe.
        verbatim.textContent = `verify-tx(${result.hash}) → ${result.verdict.toUpperCase()}`;
        // Independent re-read: re-run the SAME pipeline for the same hash and compare (the badge is the arbiter).
        const independent = await independentReplay(transport, result.hash);
        const state = decideReconcile(result.verdict, independent);
        badge.set(state);
        setWait(PLAYGROUND_STATE.CONFIRMED);
        if (onVerdict !== undefined) {
          onVerdict(result); // hand the produced verdict to the host (e.g. the feed) -- only on a real verdict.
        }
      })
      .catch((err: unknown) => {
        // An unreachable/malformed RPC -> read-error (grey, infra-gated) -- never a faked pass.
        renderThreeAltitude(
          out,
          "read-error",
          `on-chain read error: ${err instanceof Error ? err.message : String(err)}`,
          `verify-tx(${hash}) → read error (the source was unreachable; nothing is faked settled)`,
        );
        twoSource.claimedEl.textContent = "—";
        twoSource.observedEl.textContent = "unreachable";
        verbatim.textContent = `verify-tx(${hash}) → READ-ERROR (infra-gated)`;
        badge.set(RECONCILE.UNAVAILABLE);
        setWait(PLAYGROUND_STATE.UNREACHABLE, true);
      })
      .finally(() => {
        inFlight = false;
        checkBtn.disabled = false;
      });
  };

  checkBtn.addEventListener("click", onCheck);
  input.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") {
      ev.preventDefault();
      onCheck();
    }
  });

  return { root };
}

/* ------------------------------------------------------------------------------------------------ *
 * Render helpers -- skeleton, usage diagnostic, the verdict three-altitude block (via the dictionary).
 * ------------------------------------------------------------------------------------------------ */

/** The labelled dash-rows of the empty skeleton (teach the completed-verdict shape -- design §4.3). */
const SKELETON_ROWS: readonly string[] = ["Verdict", "Source", "Block", "Claimed", "Observed"];

/**
 * Render the EMPTY skeleton (design §4.3 -- before any paste, show a greyed verdict shape so users see what
 * a completed verification looks like). Sets NO `data-verdict` (absent is the honest "not run" signal).
 */
export function renderSkeleton(out: HTMLElement): void {
  out.replaceChildren();
  out.removeAttribute("data-verdict");

  const pill = document.createElement("p");
  pill.className = "pg-skeleton__pill";
  pill.textContent = "Awaiting a hash";
  out.appendChild(pill);

  const dl = document.createElement("dl");
  dl.className = "pg-skeleton__rows";
  for (const label of SKELETON_ROWS) {
    const dt = document.createElement("dt");
    dt.textContent = label;
    const dd = document.createElement("dd");
    dd.className = "mono-num";
    dd.textContent = "—";
    dl.appendChild(dt);
    dl.appendChild(dd);
  }
  out.appendChild(dl);
}

/**
 * Render a LOUD usage diagnostic (design §4.3 / §5.2 -- a malformed input is a usage error, NOT a verdict).
 * No `data-verdict` is minted (the absence is the honest signal -- this mirrors the existing diag path).
 */
export function renderUsageDiag(out: HTMLElement, message: string): void {
  out.replaceChildren();
  out.removeAttribute("data-verdict"); // a usage error mints NO verdict -> absent, never a stale/fake one.
  const diag = document.createElement("p");
  diag.className = "pg-diag";
  diag.textContent = `usage error: ${message}`;
  out.appendChild(diag);
}

/**
 * Render the THREE-ALTITUDE verdict block for a produced verdict, using the {@link ./verdictCopy.ts}
 * dictionary for the plain-English headline + why (unmapped -> the raw code). The colour grammar is the
 * shared honest one ({@link ./render.ts} -- only `settled` is green); the `data-verdict` is stamped so the
 * harness reconciles it independently.
 */
export function renderVerdict(out: HTMLElement, result: SettledResult): void {
  const copy = verdictCopyFor(result.verdict);
  const observedTxt = result.observed === null ? "∅" : `${result.observed.toString()} wei`;
  const claimedTxt = result.claimed === null ? "no claim on record" : `${result.claimed.toString()} wei`;
  // The three-altitude block: the dictionary HEADLINE+why are the human altitude; the raw line is verbatim.
  // renderThreeAltitude paints the headline as the verdict word; we prepend the dictionary headline as the
  // plain-English "why" so a judge reads meaning and a skeptic reads the raw evidence line.
  renderThreeAltitude(
    out,
    result.verdict,
    `${copy.headline}. ${copy.why}`,
    `verify-tx(${result.hash}) → ${result.verdict.toUpperCase()}  ·  receipt.status=${result.success ? "0x1" : "0x0"}, ` +
      `claimed=${claimedTxt}, observed=${observedTxt}  ·  reproduce: ${result.reproduceCommand}`,
  );
}

/** Independently re-derive the playground verdict by replaying the SAME read; null if unreachable. */
async function independentReplay(transport: RpcTransport, hash: string): Promise<IndependentResult> {
  try {
    const replay = await runSettledCheck(transport, hash);
    return { verdict: replay.verdict };
  } catch {
    return { verdict: null };
  }
}
