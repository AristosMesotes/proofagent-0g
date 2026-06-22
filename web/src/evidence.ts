/**
 * evidence.ts -- the single responsive EVIDENCE DRAWER (design §3 G, §4.6 "the Evidence Drawer", §8 honesty).
 *
 * ONE `position: fixed` surface -- a right slide-over on a wide viewport, a bottom sheet on a narrow one --
 * with a SINGLE state (no parallel tab to desync, anti-pattern (e)(6)). It keeps the main page clean while
 * depth is ONE click away: per surface it shows the RAW RPC JSON of the last reads, the full CALLDATA, the
 * exact REPRODUCE commands, and a RECONCILIATION LOG (the painted verdict vs the independent re-read).
 *
 * ## Accessibility scaffolding (design §4.6) -- a real, escapable dialog
 *
 *   - `role="dialog"` + `aria-modal="true"` + an `aria-labelledby` title, behind a scrim.
 *   - Esc closes it; a click on the scrim closes it; the × close button closes it.
 *   - On open, focus moves to the close button; a focus TRAP keeps Tab within the drawer; on close, focus is
 *     RESTORED to the element that opened it (so a keyboard user is never dropped at the top of the page).
 *
 * ## Honesty (design §8) -- the drawer shows the EVIDENCE, it never re-derives a verdict
 *
 *   - It renders a pre-built {@link EvidenceRecord} VERBATIM -- the raw reads, calldata, reproduce commands,
 *     and the reconciliation log the originating surface already produced. It MINTS no verdict and colours
 *     nothing on its own authority; the reconciliation-log lines reuse the repo-wide honesty grammar.
 *   - The reproduce commands are the literal, re-runnable independent checks (the `cargo run … verify-tx` /
 *     `cast call …` lines) so a skeptic confirms the read OUT OF BAND -- the drawer exposes the mechanism.
 *
 * ## Clean-room (design §6)
 *
 * Pure DOM, NO `innerHTML` (raw JSON is rendered as text content, never parsed-and-injected). No proprietary
 * identifier, private path, or secret -- only public reads/commands. Generic, verification-domain names only.
 */

import { verdictStateClass } from "./render.js";

/* ------------------------------------------------------------------------------------------------ *
 * The evidence record -- the pure data the drawer renders (built by the originating surface).
 * ------------------------------------------------------------------------------------------------ */

/** One reconciliation-log line: a painted verdict vs the independent re-read, with the resolved state. */
export interface ReconLogLine {
  /** Which surface/leg this line is about (e.g. `RAILS`, `SETTLEMENT`, `Playground 0x8c59…`). */
  readonly surface: string;
  /** The verdict the UI painted. */
  readonly painted: string;
  /** The verdict the INDEPENDENT re-read produced, or `null` if the source was unreachable. */
  readonly independent: string | null;
  /** The resolved reconciliation state string (`reconciled` / `mismatch` / `unavailable` / …). */
  readonly state: string;
}

/** A pre-built evidence record for one surface -- everything the drawer shows, all already-produced. */
export interface EvidenceRecord {
  /** The surface key (matches a card key / `playground`) so the drawer can be opened scrolled to it. */
  readonly key: string;
  /** A human title for the drawer header (e.g. "RAILS — on-chain cap"). */
  readonly title: string;
  /** The raw RPC JSON / read body of the last reads, rendered VERBATIM as text (never injected). */
  readonly rawJson: string;
  /** The full calldata sent (the over-cap `checkTransfer` calldata), or `null` when not applicable. */
  readonly calldata: string | null;
  /** The exact, re-runnable independent reproduce commands (one per line). */
  readonly reproduce: readonly string[];
  /** The reconciliation log -- painted vs independent, per leg. */
  readonly reconLog: readonly ReconLogLine[];
}

/* ------------------------------------------------------------------------------------------------ *
 * The reconciliation-log honesty colour (reused grammar) + a small pure helper.
 * ------------------------------------------------------------------------------------------------ */

/** Map a reconciliation-log state to the SAME repo-wide honesty colour class (only reconciled is green). */
export function reconLogStateClass(state: string): string {
  switch (state.trim().toLowerCase()) {
    case "reconciled":
      return "is-settled";
    case "mismatch":
      return "is-mismatch";
    case "unavailable":
      return "is-read-error";
    default:
      // pending / checking / awaiting -> the honest amber/neutral not-yet face.
      return "is-pending";
  }
}

/* ------------------------------------------------------------------------------------------------ *
 * The drawer -- one fixed surface, a11y-complete, slide-over / bottom-sheet by viewport.
 * ------------------------------------------------------------------------------------------------ */

/** The focusable selector for the focus trap (the close button + any links/buttons inside the drawer). */
const FOCUSABLE = 'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * The single, responsive Evidence Drawer (design §4.6). Construct it ONCE and mount {@link element} into the
 * page; call {@link open} with a pre-built {@link EvidenceRecord} to slide it in for a surface, {@link close}
 * (or Esc / scrim / ×) to dismiss it. It is a real dialog: `aria-modal`, scrim, Esc-to-close, initial focus
 * on ×, a focus trap, and focus restored to the opener on close. Pure DOM, no innerHTML.
 */
export class EvidenceDrawer {
  private readonly root: HTMLElement;
  private readonly panel: HTMLElement;
  private readonly titleEl: HTMLElement;
  private readonly bodyEl: HTMLElement;
  private readonly closeBtn: HTMLButtonElement;
  /** The element focus returns to on close (the trigger that opened the drawer). */
  private opener: HTMLElement | null = null;
  private isOpen = false;

  public constructor() {
    const root = document.createElement("div");
    root.className = "drawer";
    root.hidden = true;

    const scrim = document.createElement("div");
    scrim.className = "drawer__scrim";
    scrim.addEventListener("click", () => {
      this.close();
    });

    const panel = document.createElement("div");
    panel.className = "drawer__panel";
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-modal", "true");
    panel.setAttribute("aria-labelledby", "drawer-title");

    const header = document.createElement("div");
    header.className = "drawer__header";

    const titleEl = document.createElement("h2");
    titleEl.className = "drawer__title";
    titleEl.id = "drawer-title";
    titleEl.textContent = "Evidence";

    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "drawer__close";
    closeBtn.textContent = "×";
    closeBtn.setAttribute("aria-label", "Close the evidence drawer");
    closeBtn.addEventListener("click", () => {
      this.close();
    });

    header.appendChild(titleEl);
    header.appendChild(closeBtn);
    panel.appendChild(header);

    const bodyEl = document.createElement("div");
    bodyEl.className = "drawer__body";
    panel.appendChild(bodyEl);

    root.appendChild(scrim);
    root.appendChild(panel);

    // Esc-to-close + a focus trap, registered on the panel (active only while open).
    panel.addEventListener("keydown", (ev) => {
      this.onKeydown(ev);
    });

    this.root = root;
    this.panel = panel;
    this.titleEl = titleEl;
    this.bodyEl = bodyEl;
    this.closeBtn = closeBtn;
  }

  /** The drawer's root element (mount it once, near the end of the page). */
  public element(): HTMLElement {
    return this.root;
  }

  /** Whether the drawer is currently open (used by the host to toggle). */
  public opened(): boolean {
    return this.isOpen;
  }

  /**
   * Open the drawer for a surface, rendering its pre-built {@link EvidenceRecord}. Records the `opener` so
   * focus is restored to it on close, slides the panel in, and moves focus to the × close button. Re-opening
   * for a different surface just re-renders the body (one surface, one state).
   *
   * @param record the pre-built evidence (raw JSON / calldata / reproduce / reconciliation log).
   * @param opener the element that triggered the open (focus returns here on close).
   */
  public open(record: EvidenceRecord, opener?: HTMLElement): void {
    this.opener = opener ?? null;
    this.titleEl.textContent = `Evidence — ${record.title}`;
    this.renderBody(record);
    this.root.hidden = false;
    // Force a layout read so the slide-in transition runs from the hidden state.
    void this.panel.offsetWidth;
    this.root.classList.add("drawer--open");
    this.isOpen = true;
    this.closeBtn.focus();
  }

  /** Close the drawer and RESTORE focus to the opener (a keyboard user is never dropped at the page top). */
  public close(): void {
    if (!this.isOpen) {
      return;
    }
    this.root.classList.remove("drawer--open");
    this.root.hidden = true;
    this.isOpen = false;
    const opener = this.opener;
    this.opener = null;
    if (opener !== null && typeof opener.focus === "function") {
      opener.focus();
    }
  }

  /** Esc closes; Tab is trapped within the drawer (focus never escapes the modal while open). */
  private onKeydown(ev: KeyboardEvent): void {
    if (ev.key === "Escape") {
      ev.preventDefault();
      this.close();
      return;
    }
    if (ev.key !== "Tab") {
      return;
    }
    const focusables = Array.from(this.panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
      (el) => el.offsetParent !== null || el === this.closeBtn,
    );
    if (focusables.length === 0) {
      ev.preventDefault();
      this.closeBtn.focus();
      return;
    }
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (first === undefined || last === undefined) {
      return;
    }
    const active = document.activeElement;
    if (ev.shiftKey && active === first) {
      ev.preventDefault();
      last.focus();
    } else if (!ev.shiftKey && active === last) {
      ev.preventDefault();
      first.focus();
    }
  }

  /** Render the evidence sections (raw JSON / calldata / reproduce / reconciliation log). Pure DOM. */
  private renderBody(record: EvidenceRecord): void {
    this.bodyEl.replaceChildren();

    this.section("Raw RPC reads (verbatim)", (host) => {
      host.appendChild(this.pre(record.rawJson));
    });

    if (record.calldata !== null && record.calldata.length > 0) {
      this.section("Calldata (replayable eth_call)", (host) => {
        host.appendChild(this.pre(record.calldata as string));
      });
    }

    this.section("Reproduce independently", (host) => {
      const cmds =
        record.reproduce.length > 0 ? record.reproduce.join("\n") : "(no reproduce command for this surface)";
      host.appendChild(this.pre(`# run these against the REAL independent verifier / chain:\n${cmds}`));
    });

    this.section("Reconciliation log (painted vs independent re-read)", (host) => {
      if (record.reconLog.length === 0) {
        const p = document.createElement("p");
        p.className = "drawer__hint";
        p.textContent = "No reconciliation has run for this surface yet (run the check to populate it).";
        host.appendChild(p);
        return;
      }
      const list = document.createElement("ul");
      list.className = "drawer__reconlog";
      for (const line of record.reconLog) {
        const li = document.createElement("li");
        li.className = "drawer__reconline";

        const surface = document.createElement("span");
        surface.className = "drawer__reconsurface";
        surface.textContent = line.surface;
        li.appendChild(surface);

        const detail = document.createElement("span");
        detail.className = "drawer__recondetail mono-num";
        const independent = line.independent === null ? "unreachable" : line.independent;
        detail.textContent = `painted ${line.painted} · independent ${independent}`;
        li.appendChild(detail);

        const state = document.createElement("span");
        state.className = `drawer__reconstate ${reconLogStateClass(line.state)}`;
        state.textContent = line.state;
        li.appendChild(state);

        list.appendChild(li);
      }
      host.appendChild(list);
    });
  }

  /** Build one titled drawer section, calling `fill` with the section body host. */
  private section(title: string, fill: (host: HTMLElement) => void): void {
    const sec = document.createElement("section");
    sec.className = "drawer__section";
    const h = document.createElement("h3");
    h.className = "drawer__sectiontitle";
    h.textContent = title;
    sec.appendChild(h);
    const host = document.createElement("div");
    host.className = "drawer__sectionbody";
    fill(host);
    sec.appendChild(host);
    this.bodyEl.appendChild(sec);
  }

  /** A mono `<pre>` rendering a string VERBATIM as text content (no innerHTML, no injection). */
  private pre(text: string): HTMLElement {
    const pre = document.createElement("pre");
    pre.className = "drawer__pre mono-num";
    pre.textContent = text;
    return pre;
  }
}

/**
 * The headline colour an evidence record's PRIMARY verdict would paint (reused grammar) -- a small helper a
 * host can use to tint a surface's "raw evidence ↗" affordance to match its verdict. Only `settled`/`live`
 * is green; never coerced. (Kept here so the drawer module owns the evidence-presentation helpers.)
 */
export function evidenceVerdictClass(verdict: string): string {
  return verdictStateClass(verdict);
}
