/**
 * render.ts -- shared, pure-DOM render helpers + the `data-verdict` lifecycle (design §4 web, §8 honesty).
 *
 * ## Why this module exists
 *
 * The `data-verdict` lifecycle helpers (`renderOnchainOutcome` / `renderOnchainDiag` / `markPending`) were
 * defined privately inside `main.ts` and shared by the two on-chain controls (RAILS + SETTLED). A growing
 * dashboard adds more tiles (the playground, the four cards) that each emit the SAME honest `data-verdict`
 * lifecycle for the headless harness to reconcile. To keep ONE faithful implementation of that lifecycle --
 * rather than re-deriving it per tile and risking drift -- it is lifted here and reused by every surface.
 * `main.ts` now imports these instead of holding its own copies, so the existing page's behaviour is
 * byte-identical (same DOM, same classes, same `data-verdict` strings) -- this is a pure relocation.
 *
 * It also adds the small, generic render primitives a verification console reuses (a `Card` chrome wrapper,
 * a short-hash formatter, a tabular-number wrapper, a status dot). These are NEW and additive: the existing
 * page does not call them yet, so adding them changes nothing on screen. The dashboard phases build on them.
 *
 * ## Honesty + discipline (design §3 #2/#3, §8)
 *
 * - PURE DOM construction only -- NO `innerHTML`, so there is no string-injection surface (the existing
 *   no-injection discipline, preserved).
 * - The verdict colour grammar is honest: `settled` is the ONLY green verdict; everything else renders the
 *   neutral/amber face. A read failure marks `data-verdict="read-error"` (a loud degrade), never a stale or
 *   fabricated verdict. These helpers MINT no verdict -- they only reflect a verdict string handed to them.
 *
 * ## Clean-room (design §6)
 *
 * No proprietary identifier, private path, or secret. Generic, verification-domain names only.
 */

import { VERDICT } from "./proofs.js";

/* ------------------------------------------------------------------------------------------------ *
 * The `data-verdict` lifecycle helpers -- lifted VERBATIM from main.ts (behaviour-identical).
 *
 * Every interactive control's output container moves through: absent (not run) -> `pending` (read in
 * flight, {@link markPending}) -> the verdict ({@link renderOnchainOutcome}) on success, or `read-error`
 * ({@link renderOnchainDiag}) on a read/usage failure. The headless harness reads `data-verdict` and
 * reconciles it against the verifier/contract independently -- the UI is never trusted (design §8).
 * ------------------------------------------------------------------------------------------------ */

/**
 * Append a verdict line, a why line, and a reproduce block to an output container, then stamp the
 * container's `data-verdict` so the headless harness can read the rendered verdict. Shared by the
 * on-chain controls. `settled` is the only green verdict; everything else renders amber.
 */
export function renderOnchainOutcome(
  out: HTMLElement,
  verdict: string,
  why: string,
  reproduceCommand: string,
): void {
  out.replaceChildren();

  const verdictEl = document.createElement("p");
  const isGreen = verdict.toLowerCase() === VERDICT.SETTLED;
  verdictEl.className = isGreen ? "neg__verdict neg__verdict--settled" : "neg__verdict";
  verdictEl.textContent = verdict.toUpperCase();
  out.appendChild(verdictEl);

  const whyEl = document.createElement("p");
  whyEl.className = "neg__why";
  whyEl.textContent = why;
  out.appendChild(whyEl);

  const repro = document.createElement("pre");
  repro.className = "neg__repro";
  repro.textContent = `# reproduce the read independently:\n${reproduceCommand}`;
  out.appendChild(repro);

  // The harness reads this attribute and reconciles it against the verifier/contract independently.
  out.setAttribute("data-verdict", verdict);
}

/** Render a loud diagnostic (a read/usage failure) WITHOUT a verdict -- the absence is the honest signal. */
export function renderOnchainDiag(out: HTMLElement, message: string): void {
  out.replaceChildren();
  const diag = document.createElement("p");
  diag.className = "neg__diag";
  diag.textContent = message;
  out.appendChild(diag);
  // No verdict was minted -> mark the read as errored, never leave a stale green verdict.
  out.setAttribute("data-verdict", "read-error");
}

/** Mark a control's output as in-flight (a read is pending) -- honest, never a premature verdict. */
export function markPending(out: HTMLElement, label: string): void {
  out.replaceChildren();
  const p = document.createElement("p");
  p.className = "neg__why";
  p.textContent = label;
  out.appendChild(p);
  out.setAttribute("data-verdict", "pending");
}

/* ------------------------------------------------------------------------------------------------ *
 * Generic render primitives -- NEW + additive (the existing page does not call these yet).
 *
 * A verification console reuses one card chrome, one short-hash formatter, and one tabular-number wrapper
 * everywhere so the surface is visually consistent and digits do not jitter. These are pure DOM builders.
 * ------------------------------------------------------------------------------------------------ */

/** A 32-byte tx-hash / 20-byte address shape (so the short-hash formatter only truncates a real hash). */
const HEXISH_RE = /^0x[0-9a-fA-F]{8,}$/;

/**
 * Shorten a long `0x…` hash/address to `0x1234…abcd` (first 6 + last 4) for compact pills/feed rows.
 * The CANONICAL evidence line never uses this -- it shows the full value, never truncated (design §4.3).
 * A value too short to shorten (or not `0x`-hex) is returned unchanged, never mangled.
 */
export function shortHash(value: string): string {
  if (!HEXISH_RE.test(value) || value.length <= 12) {
    return value;
  }
  return `${value.slice(0, 6)}…${value.slice(-4)}`;
}

/**
 * Wrap a number/hash string in a `<span class="mono-num">` so it renders with tabular numerals (digits do
 * not jitter as values change). Pure text content -- no injection. Returns the span element.
 */
export function tabularNum(value: string): HTMLSpanElement {
  const span = document.createElement("span");
  span.className = "mono-num";
  span.textContent = value;
  return span;
}

/** A small status dot whose colour reflects an honest state class (only `live`/`settled` is green). */
export function statusDot(stateClass: string): HTMLSpanElement {
  const dot = document.createElement("span");
  dot.className = `status-dot ${stateClass}`;
  dot.setAttribute("aria-hidden", "true");
  return dot;
}

/** Options for the {@link card} chrome primitive. */
export interface CardOptions {
  /** Optional uppercase-mono title bar text. Omitted -> no title bar. */
  readonly title?: string;
  /** An optional extra class (e.g. a state class) added to the card root. */
  readonly className?: string;
  /** An optional stable id for the card root (so a harness/test can find it). */
  readonly id?: string;
}

/**
 * Build the shared `Card` chrome (hairline border, panel background, soft shadow, overflow:hidden, an
 * optional uppercase-mono title bar, a `min-height` floor so the grid does not jump while a read is in
 * flight). One primitive -> visual consistency for free. Returns `{ root, body }`: append content to
 * `body`. Pure DOM, no innerHTML.
 */
export function card(opts: CardOptions = {}): { root: HTMLElement; body: HTMLElement } {
  const root = document.createElement("article");
  root.className = opts.className !== undefined && opts.className.length > 0 ? `card ${opts.className}` : "card";
  if (opts.id !== undefined && opts.id.length > 0) {
    root.id = opts.id;
  }

  if (opts.title !== undefined && opts.title.length > 0) {
    const bar = document.createElement("div");
    bar.className = "card__titlebar";
    bar.textContent = opts.title;
    root.appendChild(bar);
  }

  const body = document.createElement("div");
  body.className = "card__body";
  root.appendChild(body);

  return { root, body };
}
