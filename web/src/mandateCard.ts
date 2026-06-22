/**
 * mandateCard.ts -- the EXPANDED RAILS card: a READ-ONLY mirror of the deployed mandate registry (design
 * §2 Rails, §4 web, §8 honesty, §10.4b the consolidated `MandateRegistryV4`).
 *
 * ## What this is
 *
 * The dashboard keeps FOUR cards (NEG · BRAIN · RAILS · SETTLEMENT). This is the RAILS card, EXPANDED into a
 * full read-only mirror of the deployed mandate registry -- NOT a fifth card. It shows, top to bottom:
 *
 *   A. a HEADER -- the title + a 0G MONOGRAM chain badge (0G has no branded glyph, so a clean-room monogram)
 *      + a tri-state RECONCILED-vs-deployed pill (Reconciled / Drifted / Unverified). The on-chain read is
 *      the BASELINE: the card's stated config is reconciled against what `checkTransfer` actually answers
 *      on-chain (two-source doctrine -- the chain is the arbiter, never the UI).
 *   B. a GLOBAL USD period-cap bar -- the used fraction + a reset countdown. This is the consolidated
 *      `MandateRegistryV4` spec tier (built-not-deployed), labelled honestly -- the live MVP registry
 *      enforces no USD/period cap, so the bar shows the V4 SPEC, never a live-enforced number.
 *   C. a PER-ASSET TABLE -- one row per asset: a state dot (allowed/blocked) · symbol · truncated address ·
 *      decimals · per-tx cap (formatted by the asset's decimals). Blocked rows are greyed with a `—` cap.
 *      The body scrolls inside a fixed cap so a long allowlist never blows the card height.
 *   D. a WALLET-FREE checkTransfer SIMULATOR -- an asset dropdown + an amount field -> a real READ-ONLY
 *      `eth_call checkTransfer(agent, asset, amount)` against the deployed registry. The decoded on-chain
 *      `(ok, reason)` becomes a tri-state verdict ALLOWED / BLOCKED / UNVERIFIED that spells out the binding
 *      reason. No wallet, no signing, no broadcast -- a zero-gas read; an unreachable RPC degrades LOUD to
 *      UNVERIFIED, never a faked allow.
 *   E. a FOOTER -- "Read independently from chain — not the agent's UI."
 *
 * ## What it REUSES (does not reinvent -- design §7)
 *   - the read-only {@link ./onchain.ts} `RpcTransport` seam (no signing surface by construction),
 *   - `runRailsCheck` (the over-cap probe -> the header reconcile baseline) + `runMandateCheck` /
 *     `decodeCheckTransfer` (the simulator's per-asset read),
 *   - the {@link ./render.ts} primitives (`statusDot`, `shortHash`, the verdict grammar),
 *   - the {@link ./reconcile.ts} badge + `decideReconcile` (the pill greens ONLY from an independent re-read),
 *   - the {@link ./spine.ts} `MANDATE_CARD` context object ({chainId, registryAddress, assets, v4Spec}).
 *
 * ## Honesty (design §3 #1/#2/#3, §8) -- the whole point
 *   - The on-chain read is the baseline; the displayed config is reconciled AGAINST it. `Reconciled` only
 *     from a real, agreeing re-read; `Drifted` is LOUD; an unreachable RPC is `Unverified` (grey), never a
 *     faked green. The card mints NO verdict -- it carries the chain's `(ok, reason)`.
 *   - The simulator is a real READ-ONLY eth_call (no wallet, no broadcast); a usage error (a non-numeric /
 *     out-of-range amount) mints no verdict; an unreachable source shows UNVERIFIED, never a fabricated allow.
 *   - The USD/period-cap bar is the V4 spec (built-not-deployed), labelled so -- it never reads as live.
 *
 * ## By-CHAIN (design §8, the 0g-only gate)
 *   The chain context is the single 0G monogram badge ONLY -- there is one enforcement chain (0G), proven by
 *   the 0g-only gate. The `{chainId, registryAddress}` is threaded as a context object so a later multi-chain
 *   surface is a DATA change (repoint the context), NOT a redesign. There is deliberately NO chain selector.
 *
 * ## Clean-room (design §6)
 *   Pure DOM, NO `innerHTML` (no injection surface). No proprietary identifier, private path, or secret --
 *   only the public spine context + the public 0G RPC. Generic, verification-domain names only.
 */

import {
  runRailsCheck,
  runMandateCheck,
  type RpcTransport,
} from "./onchain.js";
import { MANDATE_CARD, type MandateAsset } from "./spine.js";
import { statusDot, shortHash } from "./render.js";
import {
  ReconcileBadge,
  RECONCILE,
  decideReconcile,
  type IndependentResult,
  type ReconcileState,
} from "./reconcile.js";

/* ------------------------------------------------------------------------------------------------ *
 * The mandate-card context (threaded -- the ONE place chain/registry come from; multi-chain = data change).
 * ------------------------------------------------------------------------------------------------ */

/**
 * The mandate-card context object -- `{chainId, registryAddress, agent, assets, v4Spec, ...}`. Defaults to
 * the spine's deployed-registry mirror ({@link MANDATE_CARD}); injectable so a test (or a future second
 * chain) drives a different registry WITHOUT a card redesign. There is deliberately no chain SELECTOR -- the
 * card renders exactly one context's single 0G badge.
 */
export type MandateContext = typeof MANDATE_CARD;

/* ------------------------------------------------------------------------------------------------ *
 * Pure helpers (formatting + classification) -- std-only, deterministic, unit-tested offline.
 * ------------------------------------------------------------------------------------------------ */

/** The tri-state RECONCILED-vs-deployed pill faces (the header's two-source verdict on the stated config). */
export const DEPLOY_RECONCILE = {
  /** The stated config AGREES with the chain's own `checkTransfer` answer -- green (two reads concur). */
  RECONCILED: "reconciled",
  /** The stated config DISAGREES with the chain -- a LOUD red drift (the displayed config is stale). */
  DRIFTED: "drifted",
  /** The chain could not be read -- honest grey, infra-gated; the config is unconfirmed, never faked green. */
  UNVERIFIED: "unverified",
} as const;

/** A header-pill state. */
export type DeployReconcile = (typeof DEPLOY_RECONCILE)[keyof typeof DEPLOY_RECONCILE];

/** The simulator's tri-state verdict family (the honest classification of the on-chain `(ok, reason)`). */
export const SIM_VERDICT = {
  /** `ok==true` (reason `OK`) -- the chain ALLOWS this asset+amount as a zero-gas read. Green. */
  ALLOWED: "ALLOWED",
  /** `ok==false` -- the chain BLOCKS it; the binding reason is the decoded on-chain reason tag. Amber. */
  BLOCKED: "BLOCKED",
  /** The gate read was unreachable/malformed -- a loud UNVERIFIED (fail-closed), never a faked allow. Grey. */
  UNVERIFIED: "UNVERIFIED",
} as const;

/** A simulator verdict family. */
export type SimVerdict = (typeof SIM_VERDICT)[keyof typeof SIM_VERDICT];

/**
 * Format a raw MINOR-unit amount into a whole-unit decimal string using `decimals`, exact-integer (no
 * float on the money path -- design §3 #5). e.g. `(2_000_000n, 18)` -> `"0.000000000002"`; `(0n, 6)` ->
 * `"0"`. Trailing zeros are trimmed; a whole value shows no fractional part. Pure + deterministic.
 */
export function formatUnits(raw: bigint, decimals: number): string {
  if (decimals < 0 || !Number.isInteger(decimals)) {
    throw new RangeError(`decimals must be a non-negative integer, got ${String(decimals)}`);
  }
  const neg = raw < 0n;
  const mag = neg ? -raw : raw;
  if (decimals === 0) {
    return (neg ? "-" : "") + mag.toString();
  }
  const scale = 10n ** BigInt(decimals);
  const whole = mag / scale;
  const frac = mag % scale;
  if (frac === 0n) {
    return (neg ? "-" : "") + whole.toString();
  }
  // Left-pad the fractional part to `decimals` then trim trailing zeros (never round -- exact integer).
  const fracStr = frac.toString().padStart(decimals, "0").replace(/0+$/, "");
  return (neg ? "-" : "") + `${whole.toString()}.${fracStr}`;
}

/**
 * Parse a human whole-unit decimal string into raw MINOR units using `decimals`, exact-integer. Rejects a
 * non-numeric string, a negative, more fractional digits than `decimals` (which would silently truncate
 * money), or a value out of range -- a usage error (mints no verdict). e.g. `("1.5", 6)` -> `1_500_000n`.
 */
export function parseUnits(value: string, decimals: number): bigint {
  if (decimals < 0 || !Number.isInteger(decimals)) {
    throw new RangeError(`decimals must be a non-negative integer, got ${String(decimals)}`);
  }
  const trimmed = value.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) {
    throw new RangeError(`amount must be a non-negative decimal number, got ${JSON.stringify(value)}`);
  }
  const parts = trimmed.split(".");
  const wholePart = parts[0] ?? "0";
  const fracPart = parts[1] ?? "";
  if (fracPart.length > decimals) {
    throw new RangeError(
      `amount has ${fracPart.length} fractional digits but the asset has only ${decimals} decimals ` +
        `(that would silently truncate money — enter at most ${decimals} fractional digits)`,
    );
  }
  const scale = 10n ** BigInt(decimals);
  const whole = BigInt(wholePart) * scale;
  const frac = fracPart.length > 0 ? BigInt(fracPart.padEnd(decimals, "0")) : 0n;
  return whole + frac;
}

/**
 * Format a window length (seconds) into a compact `Hh Mm Ss` countdown (the period-cap reset). e.g.
 * `3600` -> `"1h 0m"`, `90` -> `"1m 30s"`, `0` -> `"0s"`. Pure; used for both the static window + the live
 * remaining countdown.
 */
export function formatDuration(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) {
    return "—";
  }
  const s = Math.floor(totalSeconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const parts: string[] = [];
  if (h > 0) {
    parts.push(`${h}h`);
    parts.push(`${m}m`);
  } else if (m > 0) {
    parts.push(`${m}m`);
    parts.push(`${sec}s`);
  } else {
    parts.push(`${sec}s`);
  }
  return parts.join(" ");
}

/**
 * Classify a decoded on-chain `(ok, reason)` into the simulator's tri-state verdict + a plain-English
 * binding-reason sentence. `ok` -> ALLOWED; else BLOCKED with the decoded reason named (the FIRST failing
 * rung the chain returned). Pure; the simulator renders exactly this (it mints no verdict of its own).
 */
export function classifySim(ok: boolean, reason: string): { verdict: SimVerdict; binding: string } {
  if (ok) {
    return {
      verdict: SIM_VERDICT.ALLOWED,
      binding:
        `The deployed registry ALLOWS this spend (ok=true, reason=${reason}) — within the per-asset sub-cap ` +
        `and the global per-tx cap. This is a zero-gas eth_call; nothing was signed or broadcast.`,
    };
  }
  return {
    verdict: SIM_VERDICT.BLOCKED,
    binding:
      `The deployed registry BLOCKS this spend (ok=false, reason=${reason}). ${bindingExplain(reason)} ` +
      `The block is a zero-gas eth_call BEFORE broadcast — no transaction exists; the refusal is the proof.`,
  };
}

/** A one-clause plain-English gloss of the binding on-chain reason tag (the WHY the chain refused). */
function bindingExplain(reason: string): string {
  switch (reason.toUpperCase()) {
    case "OVER_TX_CAP":
      return "The amount exceeds the global per-transaction cap.";
    case "OVER_ASSET_CAP":
      return "The amount exceeds this asset's per-asset sub-cap.";
    case "TOKEN_NOT_ALLOWED":
      return "This asset is not on the registry's allowlist (default-deny).";
    case "OVER_PERIOD_CAP":
      return "This spend would push the rolling-period leaky bucket over its cap.";
    case "OVER_USD_CAP":
      return "The USD-priced value exceeds the global USD cap.";
    case "PAUSED":
      return "The whole registry is paused (the kill-switch is engaged).";
    case "AGENT_PAUSED":
      return "This agent is paused (the per-agent kill-switch is engaged).";
    case "EXPIRED":
      return "The mandate's time-box has elapsed.";
    case "NOT_STARTED":
      return "The mandate has not begun yet (now < start).";
    case "NOT_AGENT":
      return "The caller is not the mandate's bound agent.";
    case "ZERO_AMOUNT":
      return "A zero-amount spend is never a valid mandated transfer.";
    case "EPOCH_STALE":
      return "The request's epoch is stale (a bumpEpoch revoked this in-flight grant).";
    default:
      return "The chain named this as the first-failing mandate rung.";
  }
}

/* ------------------------------------------------------------------------------------------------ *
 * Listeners (so the host can stamp the live feed / record evidence) + the built handle.
 * ------------------------------------------------------------------------------------------------ */

/** What the host wires so the expanded RAILS card can stamp a feed row + record evidence (all optional). */
export interface MandateCardListeners {
  /** Called when the header reconcile pill resolves (the deployed-config baseline, reconciled on-chain). */
  readonly onReconcile?: (verdict: string, reconcile: ReconcileState) => void;
  /** Called when a wallet-free simulator read resolves (a real read-only checkTransfer eth_call). */
  readonly onSimulate?: (asset: MandateAsset, amount: bigint, reason: string, reconcile: ReconcileState) => void;
  /** Called when a read fails (a loud read-error diagnostic — never a faked verdict). */
  readonly onReadError?: (where: string, message: string) => void;
}

/** The built expanded-RAILS card. */
export interface BuiltMandateCard {
  /** The card root element (append it into the card grid in the RAILS slot). */
  readonly root: HTMLElement;
}

/* ------------------------------------------------------------------------------------------------ *
 * The build -- assemble the expanded RAILS card (header / period-cap bar / asset table / simulator / footer).
 * ------------------------------------------------------------------------------------------------ */

/**
 * Build the expanded RAILS card -- the read-only mandate-registry mirror. First paint is honest + complete
 * with ZERO network round-trip (the table + period bar + simulator render from the threaded context); the
 * header's reconcile pill + the simulator's verdict enrich on a live read in the background.
 *
 * @param transport the read-only RPC seam (a live browser reader, or a test double).
 * @param listeners optional hooks so the host stamps a feed row + records evidence.
 * @param ctx the mandate context (defaults to the spine's deployed-registry mirror); injectable for tests.
 */
export function buildMandateCard(
  transport: RpcTransport,
  listeners?: MandateCardListeners,
  ctx: MandateContext = MANDATE_CARD,
): BuiltMandateCard {
  const root = document.createElement("article");
  root.className = "card proof-card mandate-card";
  root.id = "card-rails";
  root.setAttribute("data-proof", "rails");

  const body = document.createElement("div");
  body.className = "card__body";
  root.appendChild(body);

  // A. The header: title + 0G monogram chain badge + the tri-state reconciled-vs-deployed pill.
  const { reconcilePill, setReconcile } = renderHeader(body, ctx);

  // The claim copy (what this mirror IS + the honesty split).
  const claim = document.createElement("p");
  claim.className = "proof-card__claim";
  claim.textContent =
    "A read-only mirror of the deployed MandateRegistry on 0G — the same gate the agent reads pre-broadcast. " +
    "The on-chain read is the baseline: the config below is reconciled against what checkTransfer actually " +
    "answers on-chain. The consolidated V4 USD/period tier is built-not-deployed and labelled so.";
  body.appendChild(claim);

  // B. The global USD period-cap bar (the V4 spec tier — built-not-deployed, labelled honestly).
  renderPeriodCapBar(body, ctx);

  // C. The per-asset table (state dot · symbol · address · decimals · per-tx cap; blocked greyed; capped-scroll).
  renderAssetTable(body, ctx);

  // D. The wallet-free checkTransfer simulator (asset dropdown + amount -> a real read-only eth_call).
  const simOut = renderSimulator(body, transport, ctx, listeners);

  // E. The footer line (the two-source doctrine, in one line).
  const footer = document.createElement("p");
  footer.className = "mandate-card__footer";
  footer.textContent = "Read independently from chain — not the agent's UI.";
  body.appendChild(footer);

  // The reconcile badge row (the header pill is the verdict; this badge is the reusable honesty primitive).
  const badge = new ReconcileBadge("0G RPC");
  const badgeRow = document.createElement("div");
  badgeRow.className = "proof-card__recon mandate-card__recon";
  badgeRow.appendChild(badge.element());
  body.appendChild(badgeRow);

  // Enrich in the background: reconcile the stated config against the chain's own checkTransfer answer.
  void reconcileDeployedConfig(transport).then((res) => {
    setReconcile(res.pill, res.detail);
    badge.set(res.badge);
    if (listeners?.onReconcile !== undefined) {
      listeners.onReconcile(res.verdict, res.badge);
    }
    if (res.pill === DEPLOY_RECONCILE.UNVERIFIED && listeners?.onReadError !== undefined) {
      listeners.onReadError("RAILS reconcile", res.detail);
    }
  });

  // Keep the simulator output container referenced (the closure above already wired its button).
  void simOut;
  void reconcilePill;

  return { root };
}

/* ------------------------------------------------------------------------------------------------ *
 * A. The header -- title + 0G monogram chain badge + the tri-state reconciled-vs-deployed pill.
 * ------------------------------------------------------------------------------------------------ */

/** Build the header; returns the reconcile pill + a setter that drives its tri-state face honestly. */
function renderHeader(
  body: HTMLElement,
  ctx: MandateContext,
): { reconcilePill: HTMLElement; setReconcile: (state: DeployReconcile, detail: string) => void } {
  const header = document.createElement("div");
  header.className = "mandate-card__header";

  // Title + status-dot row (the RAILS proof headline).
  const titleRow = document.createElement("div");
  titleRow.className = "mandate-card__title-row";
  titleRow.appendChild(statusDot("is-pending"));
  const h = document.createElement("h2");
  h.className = "proof-card__headline mandate-card__title";
  h.textContent = "RAILS — it cannot overspend";
  titleRow.appendChild(h);
  header.appendChild(titleRow);

  // The badges row: the 0G monogram chain badge + the tri-state reconciled-vs-deployed pill.
  const badges = document.createElement("div");
  badges.className = "mandate-card__badges";

  // The 0G MONOGRAM chain badge (0G has no branded glyph -> a clean-room monogram tile + the chain id).
  const chainBadge = document.createElement("span");
  chainBadge.className = "chain-badge";
  chainBadge.setAttribute("title", `0G Galileo testnet · chain id ${ctx.chainId}`);
  const mono = document.createElement("span");
  mono.className = "chain-badge__mono";
  mono.setAttribute("aria-hidden", "true");
  mono.textContent = "0G";
  const chainText = document.createElement("span");
  chainText.className = "chain-badge__text mono-num";
  chainText.textContent = `0G · ${ctx.chainId}`;
  chainBadge.appendChild(mono);
  chainBadge.appendChild(chainText);
  badges.appendChild(chainBadge);

  // The tri-state reconciled-vs-deployed pill (starts honest: checking…).
  const reconcilePill = document.createElement("span");
  reconcilePill.className = "pill deploy-pill is-pending";
  reconcilePill.setAttribute("data-deploy-reconcile", "checking");
  const pillDot = statusDot("is-pending");
  const pillText = document.createElement("span");
  pillText.className = "deploy-pill__text";
  pillText.textContent = "reconciling vs deployed…";
  reconcilePill.appendChild(pillDot);
  reconcilePill.appendChild(pillText);
  badges.appendChild(reconcilePill);

  header.appendChild(badges);
  body.appendChild(header);

  /** Drive the tri-state pill honestly: Reconciled (green) / Drifted (red) / Unverified (grey). */
  const setReconcile = (state: DeployReconcile, detail: string): void => {
    const face =
      state === DEPLOY_RECONCILE.RECONCILED
        ? { css: "is-settled", dot: "is-settled", label: "Reconciled vs deployed" }
        : state === DEPLOY_RECONCILE.DRIFTED
          ? { css: "is-mismatch", dot: "is-mismatch", label: "Drifted vs deployed" }
          : { css: "is-read-error", dot: "is-read-error", label: "Unverified (source unavailable)" };
    reconcilePill.className = `pill deploy-pill ${face.css}`;
    reconcilePill.setAttribute("data-deploy-reconcile", state);
    reconcilePill.replaceChildren();
    reconcilePill.appendChild(statusDot(face.dot));
    const t = document.createElement("span");
    t.className = "deploy-pill__text";
    t.textContent = detail.length > 0 ? `${face.label} — ${detail}` : face.label;
    reconcilePill.appendChild(t);
  };

  return { reconcilePill, setReconcile };
}

/**
 * Reconcile the STATED deployed config against the chain's own answer (the two-source baseline). The card
 * states "the over-cap native probe is BLOCKED (OVER_TX_CAP)"; we read the chain's own `checkTransfer`
 * over-cap reason (`runRailsCheck`) and confirm it equals the expected block. Agreement -> Reconciled; a
 * different answer (e.g. the chain ALLOWED an over-cap, or a different reason) -> Drifted; an unreachable
 * RPC -> Unverified. The on-chain read is authoritative; the displayed config is never trusted over it.
 */
async function reconcileDeployedConfig(
  transport: RpcTransport,
): Promise<{ pill: DeployReconcile; badge: ReconcileState; verdict: string; detail: string }> {
  // The card's stated config asserts the native over-cap probe is BLOCKED on `OVER_TX_CAP` (the per-tx cap).
  const expected = "OVER_TX_CAP";
  let painted: string;
  try {
    const result = await runRailsCheck(transport);
    painted = result.verdict;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      pill: DEPLOY_RECONCILE.UNVERIFIED,
      badge: RECONCILE.UNAVAILABLE,
      verdict: "read-error",
      detail: `0G RPC unreachable (${msg.slice(0, 80)})`,
    };
  }
  // Independent re-read: replay the SAME read-only eth_call and compare the decoded reason (two reads concur).
  const independent = await independentRails(transport);
  const badge = decideReconcile(painted, independent);
  if (badge === RECONCILE.UNAVAILABLE) {
    return {
      pill: DEPLOY_RECONCILE.UNVERIFIED,
      badge,
      verdict: painted,
      detail: "the independent re-read could not confirm the chain answer",
    };
  }
  // The header pill reconciles the STATED config (expected OVER_TX_CAP) against the chain's painted answer.
  const matchesStated = painted.trim().toUpperCase() === expected;
  if (badge === RECONCILE.RECONCILED && matchesStated) {
    return {
      pill: DEPLOY_RECONCILE.RECONCILED,
      badge,
      verdict: painted,
      detail: `the deployed registry confirms the over-cap block (${painted}) — two reads concur`,
    };
  }
  // Two reads concur but they DISAGREE with the stated config -> a LOUD drift (the displayed config is stale).
  return {
    pill: DEPLOY_RECONCILE.DRIFTED,
    badge: RECONCILE.MISMATCH,
    verdict: painted,
    detail: `the chain answered ${painted}, not the stated ${expected} — the displayed config drifted`,
  };
}

/** Independently re-derive the over-cap reason by replaying the SAME read-only eth_call; null if unreachable. */
async function independentRails(transport: RpcTransport): Promise<IndependentResult> {
  try {
    const replay = await runRailsCheck(transport);
    return { verdict: replay.verdict };
  } catch {
    return { verdict: null };
  }
}

/* ------------------------------------------------------------------------------------------------ *
 * B. The global USD period-cap bar (the V4 spec tier — built-not-deployed, labelled honestly).
 * ------------------------------------------------------------------------------------------------ */

/**
 * Render the global period-cap bar: the configured rolling-window cap, a USED fraction, and a reset window.
 * This is the consolidated `MandateRegistryV4` spec (its leaky-bucket period cap). It is BUILT-NOT-DEPLOYED:
 * the live MVP registry enforces no period/USD cap, so the bar shows the V4 SPEC with `0 used` and a clear
 * "built-not-deployed" tag -- it never reads as a live-enforced figure. When V4 is deployed (the context's
 * `v4Spec.deployed` flips true via a repoint), the same bar reads the live `accruedInWindow` -- a data change.
 */
function renderPeriodCapBar(body: HTMLElement, ctx: MandateContext): void {
  const section = document.createElement("section");
  section.className = "period-cap";
  section.setAttribute("aria-label", "Global period cap (V4 spec)");

  const head = document.createElement("div");
  head.className = "period-cap__head";
  const label = document.createElement("span");
  label.className = "period-cap__label";
  label.textContent = "Global period cap";
  head.appendChild(label);

  const tag = document.createElement("span");
  tag.className = "period-cap__tag";
  tag.textContent = ctx.v4Spec.deployed ? "live (V4)" : "V4 spec · built-not-deployed";
  head.appendChild(tag);
  section.appendChild(head);

  // The cap meter. Used is 0 on the MVP (no period cap enforced); the V4 spec cap is the bar's full width.
  const capWhole = formatUnits(ctx.v4Spec.periodCap, 18);
  const meter = document.createElement("div");
  meter.className = "period-cap__meter";
  meter.setAttribute("role", "meter");
  meter.setAttribute("aria-valuemin", "0");
  meter.setAttribute("aria-valuemax", ctx.v4Spec.periodCap.toString());
  meter.setAttribute("aria-valuenow", "0");
  const fill = document.createElement("span");
  fill.className = "period-cap__fill";
  // 0 used on the MVP -> an empty fill (honest: nothing accrued because no period cap is live).
  fill.style.width = "0%";
  meter.appendChild(fill);
  section.appendChild(meter);

  const detail = document.createElement("p");
  detail.className = "period-cap__detail mono-num";
  detail.textContent =
    `used 0 / cap ${ctx.v4Spec.periodCap.toString()} wei (${capWhole} 0G) · resets every ` +
    `${formatDuration(ctx.v4Spec.periodSeconds)}` +
    (ctx.v4Spec.deployed ? "" : " — not enforced on the deployed MVP registry (V4 adds it)");
  section.appendChild(detail);

  body.appendChild(section);
}

/* ------------------------------------------------------------------------------------------------ *
 * C. The per-asset table (state dot · symbol · address · decimals · per-tx cap; blocked greyed; capped-scroll).
 * ------------------------------------------------------------------------------------------------ */

/** Render the per-asset mandate table — the deployed registry's allowlist + per-asset sub-caps, mirrored. */
function renderAssetTable(body: HTMLElement, ctx: MandateContext): void {
  const section = document.createElement("section");
  section.className = "asset-table";
  section.setAttribute("aria-label", "Per-asset mandate rules");

  const heading = document.createElement("p");
  heading.className = "asset-table__heading";
  heading.textContent = "Per-asset rules (mirror of the deployed allowlist + sub-caps)";
  section.appendChild(heading);

  // The capped-scroll wrapper so a long allowlist never blows the card height.
  const scroll = document.createElement("div");
  scroll.className = "asset-table__scroll";

  const table = document.createElement("table");
  table.className = "asset-table__table mono-num";

  const thead = document.createElement("thead");
  const htr = document.createElement("tr");
  for (const h of ["", "Asset", "Address", "Dec", "Per-tx cap"]) {
    const th = document.createElement("th");
    th.textContent = h;
    htr.appendChild(th);
  }
  thead.appendChild(htr);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  for (const asset of ctx.assets) {
    tbody.appendChild(renderAssetRow(asset));
  }
  table.appendChild(tbody);
  scroll.appendChild(table);
  section.appendChild(scroll);
  body.appendChild(section);
}

/** Render one asset row: a state dot (allowed/blocked) · symbol · truncated address · decimals · per-tx cap. */
function renderAssetRow(asset: MandateAsset): HTMLElement {
  const tr = document.createElement("tr");
  tr.className = asset.allowed ? "asset-row asset-row--allowed" : "asset-row asset-row--blocked";
  tr.setAttribute("data-asset", asset.address);
  tr.setAttribute("data-allowed", asset.allowed ? "true" : "false");

  // State dot: green (allowed) vs the neutral blocked face (a block is the system working, not a failure).
  const dotCell = document.createElement("td");
  dotCell.className = "asset-row__dot";
  dotCell.appendChild(statusDot(asset.allowed ? "is-settled" : "is-read-error"));
  tr.appendChild(dotCell);

  const symCell = document.createElement("td");
  symCell.className = "asset-row__symbol";
  symCell.textContent = asset.symbol;
  tr.appendChild(symCell);

  const addrCell = document.createElement("td");
  addrCell.className = "asset-row__addr";
  addrCell.textContent = shortHash(asset.address);
  addrCell.setAttribute("title", asset.address);
  tr.appendChild(addrCell);

  const decCell = document.createElement("td");
  decCell.className = "asset-row__dec";
  decCell.textContent = asset.decimals.toString();
  tr.appendChild(decCell);

  // Per-tx cap formatted by the asset's decimals; a blocked asset shows the honest `—` (no cap applies).
  const capCell = document.createElement("td");
  capCell.className = "asset-row__cap";
  capCell.textContent = asset.allowed
    ? `${asset.perTxCap.toString()} (${formatUnits(asset.perTxCap, asset.decimals)})`
    : "—";
  tr.appendChild(capCell);

  return tr;
}

/* ------------------------------------------------------------------------------------------------ *
 * D. The wallet-free checkTransfer simulator (asset dropdown + amount -> a real read-only eth_call).
 * ------------------------------------------------------------------------------------------------ */

/**
 * Render the wallet-free simulator: an asset dropdown + an amount field + a "simulate" button that runs a
 * real READ-ONLY `eth_call checkTransfer(agent, asset, amount)` against the deployed registry and renders a
 * tri-state verdict ALLOWED / BLOCKED / UNVERIFIED with the binding reason. No wallet, no signing, no
 * broadcast. A usage error (non-numeric / out-of-range amount) mints NO verdict; an unreachable RPC shows
 * UNVERIFIED, never a faked allow. Returns the output container (also driven by the click handler).
 */
function renderSimulator(
  body: HTMLElement,
  transport: RpcTransport,
  ctx: MandateContext,
  listeners?: MandateCardListeners,
): HTMLElement {
  const section = document.createElement("section");
  section.className = "sim";
  section.setAttribute("aria-label", "Wallet-free checkTransfer simulator");

  const heading = document.createElement("p");
  heading.className = "sim__heading";
  heading.textContent = "Simulate a transfer (wallet-free · read-only eth_call)";
  section.appendChild(heading);

  const controls = document.createElement("div");
  controls.className = "sim__controls";

  // Asset dropdown (every context asset, allowed or not — a non-allowlisted pick proves the default-deny).
  const select = document.createElement("select");
  select.className = "sim__asset";
  select.setAttribute("aria-label", "Asset to simulate");
  ctx.assets.forEach((a, i) => {
    const opt = document.createElement("option");
    opt.value = i.toString();
    opt.textContent = `${a.symbol} (${shortHash(a.address)})`;
    select.appendChild(opt);
  });
  controls.appendChild(select);

  // Amount field (whole units; converted to MINOR units by the selected asset's decimals).
  const amount = document.createElement("input");
  amount.type = "text";
  amount.className = "sim__amount mono-num";
  amount.setAttribute("inputmode", "decimal");
  amount.setAttribute("aria-label", "Amount (whole units)");
  amount.placeholder = "amount";
  controls.appendChild(amount);

  const button = document.createElement("button");
  button.type = "button";
  button.className = "proof-card__button sim__button";
  button.textContent = "Simulate → checkTransfer (eth_call)";
  controls.appendChild(button);

  section.appendChild(controls);

  const out = document.createElement("div");
  out.className = "sim__out";
  out.setAttribute("role", "status");
  out.setAttribute("aria-live", "polite");
  section.appendChild(out);

  body.appendChild(section);

  button.addEventListener("click", () => {
    const idx = Number.parseInt(select.value, 10);
    const asset = ctx.assets[idx];
    if (asset === undefined) {
      renderSimDiag(out, "select an asset to simulate.");
      return;
    }
    // Parse the whole-unit amount into MINOR units exact-integer; a usage error mints NO verdict.
    let raw: bigint;
    try {
      raw = parseUnits(amount.value, asset.decimals);
    } catch (err) {
      renderSimDiag(out, `usage: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    button.disabled = true;
    renderSimPending(out, asset, raw);
    void runSimulate(transport, ctx, asset, raw, out, listeners).finally(() => {
      button.disabled = false;
    });
  });

  return out;
}

/** Mark the simulator output as a read in flight (honest pending; never a premature verdict). */
function renderSimPending(out: HTMLElement, asset: MandateAsset, raw: bigint): void {
  out.replaceChildren();
  out.setAttribute("data-verdict", "pending");
  const p = document.createElement("p");
  p.className = "verdict-why";
  p.textContent =
    `Reading the deployed registry: checkTransfer(agent, ${asset.symbol}, ${raw.toString()} wei) ` +
    `as a zero-gas eth_call (no wallet, no broadcast)…`;
  out.appendChild(p);
}

/** Render a loud usage diagnostic WITHOUT a verdict (the absence is the honest signal — never a faked allow). */
function renderSimDiag(out: HTMLElement, message: string): void {
  out.replaceChildren();
  out.setAttribute("data-verdict", "read-error");
  const p = document.createElement("p");
  p.className = "neg__diag sim__diag";
  p.textContent = message;
  out.appendChild(p);
}

/**
 * Run the wallet-free simulation: a real READ-ONLY `checkTransfer` eth_call via the shared {@link
 * runMandateCheck}, then render the tri-state verdict + the binding reason + the reconcile badge (greened
 * ONLY by an independent re-read). An unreachable RPC -> UNVERIFIED (grey), never a faked allow.
 */
async function runSimulate(
  transport: RpcTransport,
  ctx: MandateContext,
  asset: MandateAsset,
  raw: bigint,
  out: HTMLElement,
  listeners?: MandateCardListeners,
): Promise<void> {
  let reason: string;
  let ok: boolean;
  try {
    const result = await runMandateCheck(
      transport,
      { agent: ctx.agent, token: asset.address, amount: raw },
      ctx.registryAddress,
    );
    reason = result.verdict;
    ok = !result.blocked;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    renderSimVerdict(out, SIM_VERDICT.UNVERIFIED, asset, raw, "0G RPC unreachable", RECONCILE.UNAVAILABLE,
      `The deployed registry could not be read (${msg.slice(0, 90)}). UNVERIFIED — the source was ` +
        `unreachable; nothing is faked allowed (fail-closed).`);
    if (listeners?.onSimulate !== undefined) {
      listeners.onSimulate(asset, raw, "read-error", RECONCILE.UNAVAILABLE);
    }
    if (listeners?.onReadError !== undefined) {
      listeners.onReadError("RAILS simulate", msg);
    }
    return;
  }

  const { verdict, binding } = classifySim(ok, reason);
  // Independent re-read: replay the SAME eth_call and compare the decoded reason (the badge greens only here).
  const independent = await independentSim(transport, ctx, asset, raw);
  const badge = decideReconcile(reason, independent);
  renderSimVerdict(out, verdict, asset, raw, reason, badge, binding);
  if (listeners?.onSimulate !== undefined) {
    listeners.onSimulate(asset, raw, reason, badge);
  }
}

/** Independently re-derive the simulated reason by replaying the SAME read-only eth_call; null if unreachable. */
async function independentSim(
  transport: RpcTransport,
  ctx: MandateContext,
  asset: MandateAsset,
  raw: bigint,
): Promise<IndependentResult> {
  try {
    const replay = await runMandateCheck(
      transport,
      { agent: ctx.agent, token: asset.address, amount: raw },
      ctx.registryAddress,
    );
    return { verdict: replay.verdict };
  } catch {
    return { verdict: null };
  }
}

/** Render the simulator's tri-state verdict (headline + binding reason + raw evidence) + the reconcile badge. */
function renderSimVerdict(
  out: HTMLElement,
  verdict: SimVerdict,
  asset: MandateAsset,
  raw: bigint,
  reason: string,
  badge: ReconcileState,
  binding: string,
): void {
  out.replaceChildren();
  // Honest verdict grammar: ALLOWED is green; a BLOCK is amber (the system working); UNVERIFIED is grey.
  const stateClass =
    verdict === SIM_VERDICT.ALLOWED
      ? "is-settled"
      : verdict === SIM_VERDICT.UNVERIFIED
        ? "is-read-error"
        : "is-pending";
  const headline = document.createElement("p");
  headline.className = `verdict-headline ${stateClass}`;
  headline.textContent = verdict;
  out.appendChild(headline);

  const why = document.createElement("p");
  why.className = "verdict-why";
  why.textContent = binding;
  out.appendChild(why);

  const rawLine = document.createElement("p");
  rawLine.className = "verdict-raw mono-num";
  rawLine.textContent =
    `checkTransfer(agent, ${asset.address}, ${raw.toString()}) → ` +
    `(${verdict === SIM_VERDICT.ALLOWED ? "true" : "false"}, ${reason})  ·  ` +
    `reproduce: cast call <registry> "checkTransfer(address,address,uint256)" <agent> ${asset.address} ${raw.toString()} --rpc-url $OG_RPC`;
  out.appendChild(rawLine);

  // The reconcile badge (greened ONLY by the independent re-read of the same gate).
  const badgeRow = document.createElement("div");
  badgeRow.className = "sim__recon";
  const b = new ReconcileBadge("0G RPC");
  b.set(badge);
  badgeRow.appendChild(b.element());
  out.appendChild(badgeRow);

  // The harness reads this attribute and reconciles it against the chain independently.
  out.setAttribute("data-verdict", verdict === SIM_VERDICT.UNVERIFIED ? "read-error" : reason);
}
