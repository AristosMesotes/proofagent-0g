/**
 * dashboard.ts -- the entry skeleton for the interactive Verification Console (design §3 IA, §4 components).
 *
 * ## P0 status: SCAFFOLD ONLY (no verdict surface yet)
 *
 * This is the new `boot()` entry the dashboard's later phases grow into the full information architecture
 * (header rail + at-a-glance rollup + the four proof cards + the playground + the live feed + spine facts +
 * the evidence drawer). At P0 it renders ONLY the honest, static chrome -- the header rail (eyebrow / title /
 * tagline) and the spine-facts readout from the public constants -- plus a clearly-labelled scaffold notice.
 * It paints NO verdict and reconciles NOTHING yet, so there is nothing here that could be dishonest. The
 * existing demo page (`index.html` -> `dist/main.js`) is untouched and remains the live proof surface; this
 * page is a parallel, additive entry the next phases build out.
 *
 * It deliberately REUSES the existing, proven building blocks rather than reinventing them:
 *   - the spine-derived public constants from {@link ./spine.ts} (one source, no drift),
 *   - the shared render primitives (`card`) from {@link ./render.ts},
 * so this skeleton compiles under the exact same ultra-strict `tsconfig` and inherits the honesty
 * primitives unchanged.
 *
 * ## Honesty (design §3 #2/#3, §8)
 *
 * Pure DOM, NO innerHTML (no injection surface). It mints no verdict and fabricates no success; the spine
 * facts reflect ONLY what the public spine actually pins (an unpinned registry / empty corpus render their
 * honest "not yet" copy, never a fabricated green).
 *
 * ## Clean-room (design §6)
 *
 * No proprietary identifier, private path, or secret -- only the public spine constants and the public
 * explorer URL. Generic, verification-domain names only.
 */

import { CHAIN, MANDATE, VERIFIER } from "./spine.js";
import { card } from "./render.js";

/** The header-rail eyebrow -- the mono credibility cue (design §4.1). */
const EYEBROW = "0G Aristotle · Verification Console";
/** The page title + one-line tagline (design §3 header rail). */
const TITLE = "ProofAgent-0G";
const TAGLINE = "can't lie, can't overspend";

/**
 * Render the slim header rail (eyebrow / title / tagline) into a host element. The network indicator and
 * the optional Tier-2 affordance arrive in later phases; at P0 the rail is identity-only (honest, static).
 */
function renderHeaderRail(host: HTMLElement): void {
  const rail = document.createElement("header");
  rail.className = "dash-header";

  const eyebrow = document.createElement("p");
  eyebrow.className = "dash-header__eyebrow mono-num";
  eyebrow.textContent = EYEBROW;
  rail.appendChild(eyebrow);

  const title = document.createElement("h1");
  title.className = "dash-header__title";
  title.textContent = TITLE;
  rail.appendChild(title);

  const tagline = document.createElement("p");
  tagline.className = "dash-header__tagline";
  tagline.textContent = TAGLINE;
  rail.appendChild(tagline);

  host.appendChild(rail);
}

/**
 * Render the spine-facts readout from the public constants (design §4.7 -- "live from the spine, not a
 * slogan"). Reflects ONLY what the spine pins: an unpinned registry / empty corpus show their honest
 * "not yet" copy, never a fabricated green. Mirrors the existing page's spine panel, value-for-value.
 */
function renderSpineFacts(host: HTMLElement): void {
  const { root, body } = card({ title: "Live from the data spine (proofagent.toml)", id: "dash-spine" });

  const dl = document.createElement("dl");
  dl.className = "spine__facts";

  const row = (term: string, value: string): void => {
    const dt = document.createElement("dt");
    dt.textContent = term;
    const dd = document.createElement("dd");
    dd.textContent = value;
    dl.appendChild(dt);
    dl.appendChild(dd);
  };

  row("Chain", `${CHAIN.name} (chain id ${CHAIN.id}; testnet ${CHAIN.testnet})`);
  row("Per-tx cap (Rails)", `$${MANDATE.perTxCapUsd} per transaction`);
  row(
    "MandateRegistry",
    MANDATE.registryAddress.length > 0
      ? MANDATE.registryAddress
      : "not yet deployed / pinned on-chain (claim only what's live)",
  );
  row(
    "Verifier corpus",
    VERIFIER.corpusSize > 0
      ? `${VERIFIER.corpusSize} pinned on-chain settlement(s)`
      : "0 pinned settlements yet -- the live proof is the NEG case",
  );
  row("Tolerance band", `${VERIFIER.toleranceNum}/${VERIFIER.toleranceDen} (exact-integer band, no float)`);

  // The public explorer link (always the public explorer root; never a private endpoint).
  const dt = document.createElement("dt");
  dt.textContent = "Public explorer";
  const dd = document.createElement("dd");
  const a = document.createElement("a");
  a.href = CHAIN.explorer;
  a.textContent = CHAIN.explorer;
  a.rel = "noopener noreferrer";
  dd.appendChild(a);
  dl.appendChild(dt);
  dl.appendChild(dd);

  body.appendChild(dl);
  host.appendChild(root);
}

/**
 * Render the honest P0 scaffold notice -- a clearly-labelled placeholder so a viewer is never misled into
 * thinking the verdict surface is live here yet. It directs them to the working proof page in the meantime.
 */
function renderScaffoldNotice(host: HTMLElement): void {
  const { root, body } = card({ title: "Verification console -- scaffold", id: "dash-scaffold" });

  const p = document.createElement("p");
  p.className = "dash-scaffold__note";
  p.textContent =
    "This interactive Verification Console is being built in phases. At this scaffold stage it renders " +
    "the header rail and the live spine facts only -- no verdict is painted here yet, so nothing on " +
    "this page is reconciled or claimed live.";
  body.appendChild(p);

  const link = document.createElement("p");
  link.className = "dash-scaffold__note";
  const a = document.createElement("a");
  a.href = "./index.html";
  a.textContent = "Open the working proof page (three proofs + the NEG case) →";
  link.appendChild(a);
  body.appendChild(link);

  host.appendChild(root);
}

/** Boot the dashboard scaffold once the DOM is ready. Renders ONLY honest, static chrome at P0. */
export function boot(): void {
  const mount = document.getElementById("dashboard");
  if (mount === null) {
    return;
  }
  mount.replaceChildren();
  renderHeaderRail(mount);
  renderScaffoldNotice(mount);
  renderSpineFacts(mount);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot, { once: true });
} else {
  boot();
}
