/**
 * tier2.ts -- the Tier-2 "own-wallet" card (design §4 Tier-2): "run it with YOUR wallet."
 *
 * The judge/voter connects their OWN wallet + funds and exercises the SAME mandate gate the agent obeys --
 * with their key, on the live MandateRegistryV4. The whole thesis, hands-on, honest by construction:
 *
 *   - CAN'T OVERSPEND: an OVER-cap intent is gated by a REAL read-only `checkTransfer` on the live registry
 *     BEFORE anything is signed -> `(false, OVER_TX_CAP)` -> BLOCKED pre-broadcast, nothing to sign.
 *   - CAN'T LIE: an UNDER-cap intent is ALLOWED, the judge SIGNS + broadcasts with their OWN wallet (the
 *     console never sees the key), and the verifier reads the chain and adjudicates the judge's OWN tx against
 *     the amount the console asked them to send -> `settled` ONLY on a real, in-band, Success receipt.
 *
 * Every READ (the gate, the verify) is a public-RPC read, INDEPENDENT of the signer -- you don't trust the
 * console, you check the chain. The wallet provider is INJECTED (`getProvider`), so the headless harness drives
 * this with a mock provider while production uses the real `window.ethereum`. Each action stamps a `data-verdict`
 * the harness reads + reconciles. The card mints NO verdict of its own -- it shows the chain's `checkTransfer`
 * answer and the verifier's PUBLISHED `adjudicate`, both re-derivable by anyone who reads the same chain.
 */
import {
  type RpcTransport,
  encodeCheckTransfer,
  decodeCheckTransfer,
  adjudicate,
  parseHexQuantity,
} from "./onchain.js";
import { VERDICT } from "./proofs.js";
import { RAILS_ONCHAIN, SETTLED_ONCHAIN, GALILEO } from "./spine.js";
import {
  type Eip1193Provider,
  detectWallet,
  connect,
  chainId,
  ensureGalileo,
  sendNativeTransfer,
} from "./wallet.js";

/** The built Tier-2 card (the `root` element the dashboard appends). */
export interface Tier2Card {
  readonly root: HTMLElement;
}

/** Optional hooks so the host can stamp the live feed / evidence when a Tier-2 verdict resolves. */
export interface Tier2Listeners {
  /** A connection / gate / settle verdict resolved -- `(action, verdict, hash | null)`. */
  readonly onVerdict?: (action: string, verdict: string, hash: string | null) => void;
}

/** The under-cap intent: 1_000_000 wei < the 2_000_000 per-tx cap -> the gate ALLOWS it. */
const UNDER_CAP_WEI = 1_000_000n;
/** The over-cap intent: 3_000_000 wei > the cap -> the gate BLOCKS it `(false, OVER_TX_CAP)` pre-broadcast. */
const OVER_CAP_WEI = RAILS_ONCHAIN.overCapAmount;

/**
 * Build the Tier-2 own-wallet card. `getProvider` defaults to the injected `window.ethereum`; the headless
 * harness passes a mock provider. Reads (gate + verify) go through `transport` (public RPC), independent of
 * the signer.
 */
export function buildTier2Card(
  transport: RpcTransport,
  getProvider: () => Eip1193Provider | null = () => detectWallet(),
  listeners: Tier2Listeners = {},
): Tier2Card {
  const root = document.createElement("section");
  root.className = "tier2-card";
  root.setAttribute("aria-label", "Tier-2 — run it with your own wallet");

  const h = document.createElement("h2");
  h.className = "tier2-card__title";
  h.textContent = "Run it with YOUR wallet";
  root.appendChild(h);

  const lead = document.createElement("p");
  lead.className = "tier2-card__lead";
  lead.textContent =
    "Connect your own wallet + funds and run the SAME mandate gate the agent obeys — with your key, on the " +
    "live MandateRegistryV4. Over-cap is blocked pre-broadcast (you can't even sign it); under-cap, you sign " +
    "with your own key and the independent verifier confirms your transaction. You don't trust the console — " +
    "you check the chain.";
  root.appendChild(lead);

  const connectRow = document.createElement("div");
  connectRow.className = "tier2-card__connect";
  const connectBtn = document.createElement("button");
  connectBtn.type = "button";
  connectBtn.id = "tier2-connect";
  connectBtn.className = "tier2-card__btn";
  connectBtn.textContent = "Connect wallet";
  const pill = document.createElement("span");
  pill.className = "tier2-card__pill";
  pill.id = "tier2-account";
  pill.textContent = "no wallet connected";
  connectRow.appendChild(connectBtn);
  connectRow.appendChild(pill);
  root.appendChild(connectRow);

  const actions = document.createElement("div");
  actions.className = "tier2-card__actions";
  actions.hidden = true;
  const underBtn = actionButton("tier2-under", "Spend within cap → expect ALLOWED → settled");
  const overBtn = actionButton("tier2-over", "Try to overspend → expect BLOCKED pre-broadcast");
  actions.appendChild(underBtn);
  actions.appendChild(overBtn);
  root.appendChild(actions);

  const out = document.createElement("div");
  out.className = "tier2-card__output";
  out.id = "tier2-output";
  out.setAttribute("role", "status");
  out.setAttribute("aria-live", "polite");
  root.appendChild(out);

  let provider: Eip1193Provider | null = null;
  let account: string | null = null;

  function setVerdict(verdict: string, hash: string | null): void {
    out.setAttribute("data-verdict", verdict);
    if (listeners.onVerdict !== undefined) listeners.onVerdict("Tier-2", verdict, hash);
  }

  function render(lines: readonly string[]): void {
    out.replaceChildren();
    for (const line of lines) {
      const p = document.createElement("p");
      p.className = "tier2-card__line";
      p.textContent = line;
      out.appendChild(p);
    }
  }

  connectBtn.addEventListener("click", () => {
    void onConnect();
  });
  underBtn.addEventListener("click", () => {
    void runGated(UNDER_CAP_WEI);
  });
  overBtn.addEventListener("click", () => {
    void runGated(OVER_CAP_WEI);
  });

  async function onConnect(): Promise<void> {
    out.setAttribute("data-verdict", "pending");
    render(["connecting your wallet…"]);
    const p = getProvider();
    if (p === null) {
      out.setAttribute("data-verdict", "no-wallet");
      render([
        "No wallet detected. Install an EIP-1193 wallet (e.g. MetaMask) and reload — Tier-2 needs your own signer.",
      ]);
      return;
    }
    try {
      const addr = await connect(p);
      await ensureGalileo(p);
      const chain = await chainId(p);
      provider = p;
      account = addr;
      pill.textContent = `${short(addr)} · 0G-Galileo (${chain})`;
      actions.hidden = false;
      out.setAttribute("data-verdict", "connected");
      render([`Connected ${addr} on chain ${chain}. Now run the mandate-gated flow with your own funds.`]);
    } catch (err) {
      out.setAttribute("data-verdict", "connect-error");
      render([`Wallet connect/switch failed: ${msg(err)}`]);
    }
  }

  async function runGated(amount: bigint): Promise<void> {
    if (provider === null || account === null) {
      render(["Connect your wallet first."]);
      return;
    }
    const p = provider;
    const from = account;
    out.setAttribute("data-verdict", "pending");
    render([
      `Mandate gate (read-only, zero-gas): checkTransfer(agent, native, ${amount.toString()} wei) on the live V4…`,
    ]);
    // 1. the mandate gate -- a REAL read-only checkTransfer on the live registry, BEFORE anything is signed.
    let ok: boolean;
    let reason: string;
    try {
      const data = encodeCheckTransfer(RAILS_ONCHAIN.agent, RAILS_ONCHAIN.nativeSentinel, amount);
      const raw = await transport.ethCall(RAILS_ONCHAIN.registry, data);
      const decoded = decodeCheckTransfer(raw);
      ok = decoded.ok;
      reason = decoded.reason;
    } catch (err) {
      setVerdict("read-error", null);
      render([`The mandate gate read failed (infra-gated): ${msg(err)} — degraded loudly, never an allow.`]);
      return;
    }
    // 2a. BLOCKED pre-broadcast -- nothing to sign. The can't-overspend proof, with your own wallet.
    if (!ok) {
      setVerdict(reason, null);
      render([
        `BLOCKED — the live mandate answered (false, ${reason}) for ${amount.toString()} wei.`,
        "Nothing was signed: the mandate blocked it PRE-BROADCAST. You cannot overspend even with your own key.",
      ]);
      return;
    }
    // 2b. ALLOWED -- the judge SIGNS + broadcasts with THEIR OWN wallet (the console never sees the key).
    render([
      `ALLOWED — the live mandate answered (true, OK) for ${amount.toString()} wei.`,
      "Sign the self-transfer in your wallet to broadcast it with your own key…",
    ]);
    let hash: string;
    try {
      hash = await sendNativeTransfer(p, from, from, amount);
    } catch (err) {
      setVerdict("signing-declined", null);
      render([`Broadcast declined / failed in your wallet: ${msg(err)} — nothing was sent.`]);
      return;
    }
    render([`Broadcast with your wallet: ${hash}`, "Verifying YOUR transaction independently on 0G Galileo…"]);
    // 3. VERIFY -- the verifier reads the chain and adjudicates the judge's OWN tx against the amount the
    //    console asked them to send (a REAL claim -> a real two-source check, never a fabricated settled).
    try {
      const receipt = await transport.getTransactionReceipt(hash);
      if (receipt === null) {
        setVerdict(VERDICT.UNVERIFIED, hash);
        render([
          `No receipt yet for ${hash} — the verifier degrades loudly to unverified (never a guessed settled).`,
          explorerLine(hash),
        ]);
        return;
      }
      if (receipt.status !== "0x1") {
        setVerdict(VERDICT.MISMATCH, hash);
        render([
          `Your tx ${hash} reports status ${receipt.status} (NOT Success) — surfaced loud, never softened to settled.`,
          explorerLine(hash),
        ]);
        return;
      }
      const tx = await transport.getTransactionByHash(hash);
      const observed = tx === null ? null : parseHexQuantity("tx.value", tx.value);
      const verdict = adjudicate(amount, observed, SETTLED_ONCHAIN.toleranceNum, SETTLED_ONCHAIN.toleranceDen);
      setVerdict(verdict, hash);
      render([
        `Success (0x1). The verifier read your tx independently: claimed ${amount.toString()} vs observed ` +
          `${observed === null ? "∅" : observed.toString()} wei → ${verdict}.`,
        "You signed it with YOUR key; the independent verifier confirmed it on-chain. Don't trust us — check it:",
        explorerLine(hash),
      ]);
    } catch (err) {
      setVerdict("read-error", hash);
      render([`Verification read failed (infra-gated): ${msg(err)} — degraded loudly.`, explorerLine(hash)]);
    }
  }

  function explorerLine(hash: string): string {
    return `${GALILEO.explorer}/tx/${hash}`;
  }

  return { root };
}

// ---- small helpers ----

function actionButton(id: string, label: string): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.id = id;
  b.className = "tier2-card__btn tier2-card__btn--action";
  b.textContent = label;
  return b;
}

function short(addr: string): string {
  return addr.length > 12 ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : addr;
}

function msg(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
