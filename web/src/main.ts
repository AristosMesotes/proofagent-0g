/**
 * main.ts -- the thin DOM wiring for the demo screen (design §4 web, §2 the three proofs + NEG case).
 *
 * Renders the THREE honest stamps (brain = pending/Phase-2, rails = the on-chain cap, settlement = the
 * verifier verdict) from {@link buildStamps}, and wires the NEG-case button to {@link runNegCase} so a
 * click points the verifier's published rule at a FABRICATED hash and shows the hero verdict `UNVERIFIED`.
 *
 * This module mints NO verdict and fabricates NO success (design §3 principle 2/3); it only reads the
 * honest model in `proofs.ts` and reflects it into the DOM. It is browser-only, offline, no framework and
 * no network -- a single static page loads the compiled ESM via `<script type="module">`.
 *
 * Clean-room (design §6): no proprietary identifier, private path, or secret -- only the public spine-
 * derived constants and the public explorer URL.
 */

import {
  buildStamps,
  runNegCase,
  CHAIN,
  MANDATE,
  VERIFIER,
  VERDICT,
  STAMP_LEVEL,
  FABRICATED_HASH,
  type Stamp,
  type StampLevel,
} from "./proofs.js";
import {
  runRailsCheck,
  runSettledCheck,
  createBrowserRpcTransport,
  GALILEO,
  RAILS_ONCHAIN,
  SETTLED_ONCHAIN,
  type RpcTransport,
} from "./onchain.js";
import { renderOnchainOutcome, renderOnchainDiag, markPending } from "./render.js";

/** Map a stamp honesty level to its CSS state class. Only `LIVE` is the green state (design §8). */
function levelClass(level: StampLevel): string {
  switch (level) {
    case STAMP_LEVEL.LIVE:
      return "stamp--live";
    case STAMP_LEVEL.ARMED:
      return "stamp--armed";
    case STAMP_LEVEL.PENDING:
      return "stamp--pending";
    default:
      // Exhaustive in practice; a defensive amber for any future level (never green by default).
      return "stamp--pending";
  }
}

/** Render one stamp card into a container element. Pure DOM construction, no innerHTML injection. */
function renderStamp(stamp: Stamp): HTMLElement {
  const card = document.createElement("article");
  card.className = `stamp ${levelClass(stamp.level)}`;
  card.setAttribute("data-proof", stamp.proof);

  const badge = document.createElement("span");
  badge.className = "stamp__bracket";
  badge.textContent = stamp.bracket;
  card.appendChild(badge);

  const title = document.createElement("h2");
  title.className = "stamp__title";
  title.textContent = stamp.title;
  card.appendChild(title);

  const status = document.createElement("p");
  status.className = "stamp__status";
  status.textContent = stamp.status;
  card.appendChild(status);

  const claim = document.createElement("p");
  claim.className = "stamp__claim";
  claim.textContent = stamp.claim;
  card.appendChild(claim);

  return card;
}

/** Render the three stamps into the `#stamps` grid. */
function renderStamps(): void {
  const grid = document.getElementById("stamps");
  if (grid === null) {
    return;
  }
  grid.replaceChildren();
  for (const stamp of buildStamps()) {
    grid.appendChild(renderStamp(stamp));
  }
}

/** Fill the small spine facts panel so the page reflects the real `proofagent.toml`, not a slogan. */
function renderSpineFacts(): void {
  const set = (id: string, text: string): void => {
    const el = document.getElementById(id);
    if (el !== null) {
      el.textContent = text;
    }
  };
  set("fact-chain", `${CHAIN.name} (chain id ${CHAIN.id}; testnet ${CHAIN.testnet})`);
  set("fact-cap", `$${MANDATE.perTxCapUsd} per transaction`);
  set(
    "fact-registry",
    MANDATE.registryAddress.length > 0
      ? MANDATE.registryAddress
      : "not yet deployed / pinned on-chain (claim only what's live)",
  );
  set(
    "fact-corpus",
    VERIFIER.corpusSize > 0
      ? `${VERIFIER.corpusSize} pinned on-chain settlement(s)`
      : "0 pinned settlements yet -- the live proof is the NEG case",
  );
  set("fact-tolerance", `${VERIFIER.toleranceNum}/${VERIFIER.toleranceDen} (exact-integer band, no float)`);

  // Wire the explorer link (always to the public explorer root; never a private endpoint).
  const explorer = document.getElementById("explorer-link");
  if (explorer instanceof HTMLAnchorElement) {
    explorer.href = CHAIN.explorer;
    explorer.textContent = CHAIN.explorer;
  }
}

/** Wire the NEG-case button: a click runs the fabricated-hash check and shows `UNVERIFIED`. */
function wireNegCase(): void {
  const button = document.getElementById("neg-run");
  const out = document.getElementById("neg-output");
  const hashEl = document.getElementById("neg-hash");
  if (!(button instanceof HTMLButtonElement) || out === null) {
    return;
  }

  // Pre-fill the fabricated hash so the viewer sees exactly what is being checked.
  if (hashEl !== null) {
    hashEl.textContent = FABRICATED_HASH;
  }

  button.addEventListener("click", () => {
    out.replaceChildren();
    let result;
    try {
      result = runNegCase(FABRICATED_HASH);
    } catch (err) {
      // A usage error (not a hash) -- show it as a loud diagnostic, NOT a verdict.
      const diag = document.createElement("p");
      diag.className = "neg__diag";
      diag.textContent = `usage error: ${err instanceof Error ? err.message : String(err)}`;
      out.appendChild(diag);
      return;
    }

    // The hero verdict line. It can ONLY ever be `unverified` here (design §2/§3).
    const verdict = document.createElement("p");
    verdict.className =
      result.verdict === VERDICT.SETTLED ? "neg__verdict neg__verdict--settled" : "neg__verdict";
    verdict.textContent = result.verdict.toUpperCase();
    out.appendChild(verdict);

    const why = document.createElement("p");
    why.className = "neg__why";
    why.textContent = result.explanation;
    out.appendChild(why);

    const repro = document.createElement("pre");
    repro.className = "neg__repro";
    repro.textContent = `# reproduce against the REAL independent verifier:\n${result.reproduceCommand}`;
    out.appendChild(repro);

    out.setAttribute("data-verdict", result.verdict);
  });
}

/**
 * Wire the RAILS control: a click runs a READ-ONLY `checkTransfer` of an OVER-cap amount against the
 * deployed registry and renders the decoded on-chain reason (`OVER_TX_CAP`) with `data-verdict`.
 * The transport defaults to the live public-0G reader; tests inject an offline double.
 */
function wireRailsCheck(transport: RpcTransport): void {
  const button = document.getElementById("rails-run");
  const out = document.getElementById("rails-output");
  if (!(button instanceof HTMLButtonElement) || out === null) {
    return;
  }
  // Pre-fill the probe facts so the viewer sees exactly what is being checked.
  const amountEl = document.getElementById("rails-amount");
  if (amountEl !== null) {
    amountEl.textContent = `${RAILS_ONCHAIN.overCapAmount.toString()} wei`;
  }
  const capEl = document.getElementById("rails-cap");
  if (capEl !== null) {
    capEl.textContent = `${RAILS_ONCHAIN.perTxCap.toString()} wei`;
  }
  const regEl = document.getElementById("rails-registry");
  if (regEl !== null) {
    regEl.textContent = RAILS_ONCHAIN.registry;
  }

  button.addEventListener("click", () => {
    button.disabled = true;
    markPending(out, "Reading the on-chain cap (eth_call checkTransfer, zero gas, no broadcast)…");
    runRailsCheck(transport)
      .then((result) => {
        renderOnchainOutcome(out, result.verdict, result.explanation, result.reproduceCommand);
      })
      .catch((err: unknown) => {
        renderOnchainDiag(
          out,
          `on-chain read error: ${err instanceof Error ? err.message : String(err)}`,
        );
      })
      .finally(() => {
        button.disabled = false;
      });
  });
}

/**
 * Wire the SETTLED control: a click runs a READ-ONLY receipt + value read of the PINNED settled tx and
 * renders the re-derived verifier verdict (`settled`) with `data-verdict`. Live reader by default; a
 * test double is injected in tests.
 */
function wireSettledCheck(transport: RpcTransport): void {
  const button = document.getElementById("settled-run");
  const out = document.getElementById("settled-output");
  if (!(button instanceof HTMLButtonElement) || out === null) {
    return;
  }
  const hashEl = document.getElementById("settled-hash");
  if (hashEl !== null) {
    hashEl.textContent = SETTLED_ONCHAIN.hash;
  }

  button.addEventListener("click", () => {
    button.disabled = true;
    markPending(out, "Reading the pinned settlement (receipt + value, no broadcast)…");
    runSettledCheck(transport)
      .then((result) => {
        renderOnchainOutcome(out, result.verdict, result.explanation, result.reproduceCommand);
      })
      .catch((err: unknown) => {
        renderOnchainDiag(
          out,
          `on-chain read error: ${err instanceof Error ? err.message : String(err)}`,
        );
      })
      .finally(() => {
        button.disabled = false;
      });
  });
}

/** Boot the page once the DOM is ready. */
function boot(): void {
  renderStamps();
  renderSpineFacts();
  wireNegCase();
  // The two on-chain controls read the public 0G Galileo testnet read-only (no key, no broadcast).
  const transport = createBrowserRpcTransport(GALILEO.rpcUrl);
  wireRailsCheck(transport);
  wireSettledCheck(transport);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot, { once: true });
} else {
  boot();
}
