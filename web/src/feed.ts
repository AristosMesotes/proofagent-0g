/**
 * feed.ts -- the in-memory LIVE VERDICT FEED (design §3 E, §4.5 "the live verdict feed", §8 honesty).
 *
 * Every checked verdict this session -- each proof-card run, each playground paste -- becomes a stamped row
 * in a newest-first, in-memory log. The feed is the session's accumulating SIGNED VERDICT LOG: a chain of
 * stamped verdicts, NOT raw logs. It is in-memory ONLY (no persistence, no backend) and clears on reload.
 *
 * ## Split: a PURE store + a PURE-DOM renderer (so the honesty logic is testable offline)
 *
 * The {@link FeedStore} is pure logic (append, snapshot newest-first, clear) with NO DOM dependency, so the
 * append/clear/order invariants are unit-tested under `node --test` (the app `tsconfig` is `types: []`,
 * DOM-only; the store must not need a DOM). {@link explorerTxUrl} and {@link verdictChip} are likewise pure.
 * {@link renderFeedRow} / {@link FeedView} are the DOM half -- pure DOM construction, NO `innerHTML`.
 *
 * ## Honesty (design §8) -- the feed reflects, it never mints
 *
 *   - A row carries ONLY a verdict a verifier surface already produced (`source` records WHICH independent
 *     source: `verifier` / `0G RPC`). The feed MINTS no verdict and colours nothing on its own authority --
 *     the verdict-chip colour reuses the SAME repo-wide honesty grammar ({@link ./render.ts} -- only
 *     `settled`/`live` is green; `hollow`/`mismatch` are LOUD red; everything else amber/neutral).
 *   - Each row shows its RECONCILIATION state (the badge state the tile resolved to) so a reviewer scans the
 *     whole session's reconciliation at a glance -- never auto-green, just the resolved state mirrored.
 *   - A usage error (a malformed playground hash) mints NO verdict, so it appends NO row (the absence is the
 *     honest signal; the playground only calls {@link FeedStore.append} on a real produced verdict).
 *   - The short hash is for the COMPACT row only; the canonical evidence (the verbatim verify-tx line) lives
 *     on the originating surface and is never truncated there (design §4.3 / §4.5).
 *
 * ## Clean-room (design §6)
 *
 * Pure data + pure DOM. No `innerHTML`, no proprietary identifier, private path, or secret -- only the public
 * 0G explorer URL and the public verdict strings. Generic, verification-domain names only.
 */

import { shortHash, statusDot, verdictStateClass } from "./render.js";
import { RECONCILE, type ReconcileState } from "./reconcile.js";
import { GALILEO } from "./spine.js";

/* ------------------------------------------------------------------------------------------------ *
 * The feed entry -- one stamped verdict (the pure data shape).
 * ------------------------------------------------------------------------------------------------ */

/** Which INDEPENDENT source produced/confirmed a verdict (shown in the row's sub-line). */
export type VerdictSource = "verifier" | "0G RPC";

/** One stamped verdict row -- the pure data a feed entry carries (no DOM). */
export interface FeedEntry {
  /** A monotonically-increasing id (stable key; assigned by the store on append). */
  readonly id: number;
  /** The capitalized action that produced the verdict (e.g. `NEG`, `RAILS`, `SETTLEMENT`, `Playground`). */
  readonly action: string;
  /** The raw verdict string the surface produced (e.g. `settled` / `unverified` / `over_tx_cap`). */
  readonly verdict: string;
  /** The independent source this verdict came from (`verifier` / `0G RPC`). */
  readonly source: VerdictSource;
  /** The tx hash this verdict is about, if any (the playground/settlement hash; `null` for the NEG fabrication-free case is still a hash). */
  readonly hash: string | null;
  /** The reconciliation-badge state the originating tile resolved to (mirrored, never re-derived here). */
  readonly reconcile: ReconcileState;
  /** The wall-clock time the verdict was stamped (ms epoch; rendered HH:MM:SS). */
  readonly at: number;
}

/** The fields a caller supplies to {@link FeedStore.append} (the store assigns `id` + `at`). */
export interface FeedInput {
  readonly action: string;
  readonly verdict: string;
  readonly source: VerdictSource;
  readonly hash: string | null;
  readonly reconcile: ReconcileState;
}

/* ------------------------------------------------------------------------------------------------ *
 * The PURE feed store -- append / snapshot (newest-first) / clear. No DOM. Unit-tested offline.
 * ------------------------------------------------------------------------------------------------ */

/**
 * An in-memory, newest-first store of stamped verdicts (design §4.5). Pure logic -- it holds the session's
 * verdict log and notifies a subscriber on change so the DOM view re-renders. No persistence: it is cleared
 * on reload, and {@link clear} empties it on demand. It MINTS no verdict; it only records ones surfaces
 * produced.
 */
export class FeedStore {
  private readonly entries: FeedEntry[] = [];
  private nextId = 1;
  private subscriber: ((entries: readonly FeedEntry[]) => void) | null = null;
  /** The injectable clock (defaults to `Date.now`) -- so tests can stamp deterministic times. */
  private readonly now: () => number;

  /** @param now an optional clock for the `at` timestamp (defaults to `Date.now`; injected in tests). */
  public constructor(now: () => number = Date.now) {
    this.now = now;
  }

  /**
   * Append one stamped verdict and notify the subscriber. Assigns a stable, monotonically-increasing `id`
   * and an `at` timestamp from the injected clock. Returns the created entry. The store records exactly what
   * it is handed -- it never alters or invents a verdict.
   */
  public append(input: FeedInput): FeedEntry {
    const entry: FeedEntry = {
      id: this.nextId,
      action: input.action,
      verdict: input.verdict,
      source: input.source,
      hash: input.hash,
      reconcile: input.reconcile,
      at: this.now(),
    };
    this.nextId += 1;
    this.entries.push(entry);
    this.notify();
    return entry;
  }

  /** A NEWEST-FIRST snapshot of the feed (a fresh array -- the caller cannot mutate the store's state). */
  public snapshot(): readonly FeedEntry[] {
    return [...this.entries].reverse();
  }

  /** The number of stamped verdicts in the feed. */
  public size(): number {
    return this.entries.length;
  }

  /** Clear the feed (in-memory only; design §4.5 "a small clear-feed control"). Notifies the subscriber. */
  public clear(): void {
    this.entries.length = 0;
    this.notify();
  }

  /** Subscribe to changes (append/clear) -- the DOM view re-renders from the newest-first snapshot. */
  public subscribe(fn: (entries: readonly FeedEntry[]) => void): void {
    this.subscriber = fn;
  }

  private notify(): void {
    if (this.subscriber !== null) {
      this.subscriber(this.snapshot());
    }
  }
}

/* ------------------------------------------------------------------------------------------------ *
 * PURE row helpers (testable offline) -- the explorer URL + the verdict chip face.
 * ------------------------------------------------------------------------------------------------ */

/** The 32-byte tx-hash shape (so {@link explorerTxUrl} only links a real hash, never a coerced one). */
const TX_HASH_RE = /^0x[0-9a-fA-F]{64}$/;

/**
 * Build the PUBLIC 0G Galileo explorer URL for a tx hash, so a reviewer confirms the chain THEMSELVES
 * (design §4.5 "↗ explorer"). Returns `null` for a non-hash input (never a coerced/half link) -- the caller
 * then renders no explorer affordance rather than a broken link. The live legs run on Galileo, so the link
 * targets the Galileo explorer.
 */
export function explorerTxUrl(hash: string | null): string | null {
  if (hash === null || !TX_HASH_RE.test(hash.trim())) {
    return null;
  }
  return `${GALILEO.explorer}/tx/${hash.trim().toLowerCase()}`;
}

/** A verdict chip's honest face: the glyph + the SAME repo-wide colour state class (only settled is green). */
export interface VerdictChip {
  /** A leading glyph hinting the verdict family (`✓` settled · `⚠` mismatch/hollow · `·` neutral). */
  readonly glyph: string;
  /** The honesty colour state class (reused from the repo-wide grammar -- only `is-settled` is green). */
  readonly stateClass: string;
  /** The chip label (the verdict, lower-cased -- the row's compact verdict word). */
  readonly label: string;
}

/**
 * Resolve a verdict's compact chip face for a feed row (design §4.5). It REUSES the repo-wide honesty colour
 * grammar ({@link ./render.ts} `verdictStateClass`) so the feed can never colour a verdict differently from
 * the card that produced it -- only `settled`/`live` is green; `hollow`/`mismatch` are LOUD red; everything
 * else (including an on-chain reason like `over_tx_cap`, or `read-error`) is the honest neutral/amber/grey.
 * It mints/changes no verdict; it only supplies the glyph + the existing colour class for the given string.
 */
export function verdictChip(verdict: string): VerdictChip {
  const stateClass = verdictStateClass(verdict);
  let glyph: string;
  switch (stateClass) {
    case "is-settled":
      glyph = "✓";
      break;
    case "is-mismatch":
      glyph = "⚠";
      break;
    default:
      // amber/neutral (unverified / pending / an on-chain reason) + grey read-error -> a neutral dot glyph.
      glyph = "·";
      break;
  }
  return { glyph, stateClass, label: verdict.trim().toLowerCase() };
}

/** Format an `at` epoch-ms timestamp as a stable `HH:MM:SS` (24h, zero-padded) -- pure, no locale drift. */
export function formatClock(at: number): string {
  const d = new Date(at);
  const pad = (n: number): string => n.toString().padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** The honest short label for a reconciliation state in a compact feed cell (mirrors the badge meaning). */
export function reconcileLabel(state: ReconcileState): string {
  switch (state) {
    case RECONCILE.RECONCILED:
      return "reconciled";
    case RECONCILE.MISMATCH:
      return "unreconciled";
    case RECONCILE.UNAVAILABLE:
      return "infra-gated";
    case RECONCILE.AWAITING:
      return "awaiting attestation";
    default:
      return "reconciling…";
  }
}

/** Map a reconciliation state to the SAME honesty colour class the badge uses (only reconciled is green). */
export function reconcileStateClass(state: ReconcileState): string {
  switch (state) {
    case RECONCILE.RECONCILED:
      return "is-settled";
    case RECONCILE.MISMATCH:
      return "is-mismatch";
    case RECONCILE.UNAVAILABLE:
      return "is-read-error";
    default:
      return "is-pending";
  }
}

/* ------------------------------------------------------------------------------------------------ *
 * The DOM half -- a row renderer + a small view that re-renders the list from the store. No innerHTML.
 * ------------------------------------------------------------------------------------------------ */

/**
 * Build one feed-row element (design §4.5): a colour DOT + the capitalized action + a verdict CHIP +
 * a right-aligned timestamp; a sub-line of detail (source · block/hash · reconciliation state) with a
 * SHORTENED hash + a COPY control + an ↗ EXPLORER link (only when the hash is a real tx hash). Pure DOM, no
 * innerHTML. The chip + reconciliation colours reuse the repo-wide honest grammar (only settled/reconciled
 * is green). The optional `onCopy` lets the host flash a transient "Copied" confirmation.
 */
export function renderFeedRow(
  entry: FeedEntry,
  opts?: { onCopy?: (value: string, trigger: HTMLElement) => void },
): HTMLElement {
  const chip = verdictChip(entry.verdict);

  const row = document.createElement("li");
  row.className = "feed-row";
  row.setAttribute("data-feed-verdict", entry.verdict.toLowerCase());
  row.setAttribute("data-feed-reconcile", entry.reconcile);

  // --- the headline line: dot + action + chip + timestamp ---
  const head = document.createElement("div");
  head.className = "feed-row__head";

  head.appendChild(statusDot(chip.stateClass));

  const action = document.createElement("span");
  action.className = "feed-row__action";
  action.textContent = entry.action;
  head.appendChild(action);

  const chipEl = document.createElement("span");
  chipEl.className = `feed-chip pill ${chip.stateClass}`;
  const chipGlyph = document.createElement("span");
  chipGlyph.className = "feed-chip__glyph";
  chipGlyph.setAttribute("aria-hidden", "true");
  chipGlyph.textContent = chip.glyph;
  const chipText = document.createElement("span");
  chipText.textContent = chip.label;
  chipEl.appendChild(chipGlyph);
  chipEl.appendChild(chipText);
  head.appendChild(chipEl);

  const time = document.createElement("time");
  time.className = "feed-row__time mono-num";
  time.dateTime = new Date(entry.at).toISOString();
  time.textContent = formatClock(entry.at);
  head.appendChild(time);

  row.appendChild(head);

  // --- the sub-line: source · short hash (+ copy + explorer) · reconciliation state ---
  const sub = document.createElement("div");
  sub.className = "feed-row__sub";

  const src = document.createElement("span");
  src.className = "feed-row__src";
  src.textContent = `source: ${entry.source}`;
  sub.appendChild(src);

  if (entry.hash !== null) {
    const hashEl = document.createElement("span");
    hashEl.className = "feed-row__hash mono-num";
    hashEl.textContent = shortHash(entry.hash);
    hashEl.title = entry.hash; // the full hash on hover -- the short form never hides it.
    sub.appendChild(hashEl);

    const copyBtn = document.createElement("button");
    copyBtn.type = "button";
    copyBtn.className = "feed-row__copy ghost-btn";
    copyBtn.textContent = "copy";
    copyBtn.setAttribute("aria-label", `Copy the full transaction hash ${entry.hash}`);
    const fullHash = entry.hash;
    copyBtn.addEventListener("click", () => {
      if (opts?.onCopy !== undefined) {
        opts.onCopy(fullHash, copyBtn);
      }
    });
    sub.appendChild(copyBtn);

    const url = explorerTxUrl(entry.hash);
    if (url !== null) {
      const link = document.createElement("a");
      link.className = "feed-row__explorer ghost-btn";
      link.href = url;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.textContent = "↗ explorer";
      link.setAttribute("aria-label", "Confirm this transaction on the public 0G explorer (opens a new tab)");
      sub.appendChild(link);
    }
  }

  const recon = document.createElement("span");
  recon.className = `feed-row__recon ${reconcileStateClass(entry.reconcile)}`;
  recon.textContent = reconcileLabel(entry.reconcile);
  sub.appendChild(recon);

  row.appendChild(sub);
  return row;
}

/**
 * The feed VIEW (design §3 E / §4.5): a titled card with a "clear feed" ghost control and a newest-first
 * list that re-renders from the {@link FeedStore} on every change. An empty feed shows an honest empty state
 * ("No verdicts yet — run a proof or paste a hash."). Pure DOM; it subscribes to the store and never holds a
 * second copy of the feed state (one source of truth -- the store).
 */
export class FeedView {
  private readonly root: HTMLElement;
  private readonly list: HTMLUListElement;
  private readonly empty: HTMLElement;
  private readonly count: HTMLElement;

  /**
   * @param store the pure feed store (the single source of truth) -- the view subscribes and re-renders.
   * @param onCopy an optional copy handler (so the host flashes a transient "Copied" confirmation).
   */
  public constructor(
    private readonly store: FeedStore,
    private readonly onCopy?: (value: string, trigger: HTMLElement) => void,
  ) {
    const section = document.createElement("section");
    section.className = "card feed";
    section.id = "feed";
    section.setAttribute("aria-label", "Live verdict feed (this session)");

    const bar = document.createElement("div");
    bar.className = "card__titlebar feed__titlebar";
    const barTitle = document.createElement("span");
    barTitle.textContent = "Live verdict feed — this session";
    this.count = document.createElement("span");
    this.count.className = "feed__count mono-num";
    this.count.textContent = "0";
    const clearBtn = document.createElement("button");
    clearBtn.type = "button";
    clearBtn.className = "feed__clear ghost-btn";
    clearBtn.textContent = "clear feed";
    clearBtn.addEventListener("click", () => {
      this.store.clear();
    });
    bar.appendChild(barTitle);
    bar.appendChild(this.count);
    bar.appendChild(clearBtn);
    section.appendChild(bar);

    const body = document.createElement("div");
    body.className = "card__body feed__body";

    this.empty = document.createElement("p");
    this.empty.className = "feed__empty";
    this.empty.textContent = "No verdicts yet — run a proof or paste a hash.";
    body.appendChild(this.empty);

    this.list = document.createElement("ul");
    this.list.className = "feed__list";
    this.list.setAttribute("role", "log");
    this.list.setAttribute("aria-live", "polite");
    this.list.setAttribute("aria-label", "Stamped verdicts, newest first");
    body.appendChild(this.list);

    section.appendChild(body);
    this.root = section;

    this.store.subscribe((entries) => {
      this.render(entries);
    });
    this.render(this.store.snapshot());
  }

  /** The feed view's root element (append it into the page). */
  public element(): HTMLElement {
    return this.root;
  }

  /** Re-render the list (newest-first) from a snapshot; toggle the honest empty state. Pure DOM. */
  private render(entries: readonly FeedEntry[]): void {
    this.count.textContent = entries.length.toString();
    this.list.replaceChildren();
    const handler = this.onCopy;
    if (entries.length === 0) {
      this.empty.hidden = false;
      this.list.hidden = true;
      return;
    }
    this.empty.hidden = true;
    this.list.hidden = false;
    for (const entry of entries) {
      this.list.appendChild(
        renderFeedRow(entry, handler === undefined ? undefined : { onCopy: handler }),
      );
    }
  }
}
