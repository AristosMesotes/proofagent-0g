/**
 * wallet.ts -- the Tier-2 "own-wallet" seam (design §4 Tier-2): a thin, honest EIP-1193 adapter so a
 * judge/voter can run the mandate-gated flow with THEIR OWN wallet + funds. Honest by construction:
 *
 *  - the console NEVER sees a private key -- it asks the user's wallet (`window.ethereum`) to CONNECT and to
 *    SIGN + broadcast; the key stays in the wallet;
 *  - every READ (the pre-broadcast mandate gate `checkTransfer`, the post-broadcast settlement verify) goes
 *    through the public RPC transport (`onchain.ts`), NOT the wallet -- so the verdict is independent of the
 *    signer (you do not trust the console, you check the chain);
 *  - the provider is INJECTABLE (`detectWallet(win)`), so the headless fullstack harness drives Tier-2 with a
 *    mock provider (no real extension, no secret) while production uses the real injected `window.ethereum`.
 *
 * No bundler, no network in THIS module -- pure EIP-1193 request plumbing over an injected provider.
 */

/** The minimal EIP-1193 surface Tier-2 uses: the single `request({ method, params })` entry point. */
export interface Eip1193Provider {
  request(args: { method: string; params?: readonly unknown[] }): Promise<unknown>;
}

/** A connected wallet: the selected account + the chain it is currently on. */
export interface ConnectedWallet {
  readonly address: string;
  readonly chainId: number;
}

/** A loud, typed wallet failure (a rejected connection, a wrong chain, a declined signature). Never silent. */
export class WalletError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WalletError";
  }
}

/** 0G Galileo testnet (chain 16602 = `0x40da`). `params` is what a wallet needs to ADD the chain if unknown. */
export const GALILEO_CHAIN = {
  /** The chain id as the `0x`-hex string EIP-1193 expects (`16602`). */
  chainIdHex: "0x40da",
  /** The chain id as a number (for an `eth_chainId` comparison). */
  chainIdNum: 16602,
  /** `wallet_addEthereumChain` params -- the public RPC + explorer + native currency (no secret). */
  params: {
    chainId: "0x40da",
    chainName: "0G-Galileo Testnet",
    nativeCurrency: { name: "0G", symbol: "0G", decimals: 18 },
    rpcUrls: ["https://evmrpc-testnet.0g.ai"],
    blockExplorerUrls: ["https://chainscan-galileo.0g.ai"],
  },
} as const;

/** Detect an injected EIP-1193 provider (`window.ethereum`), or `null` when no wallet is present. The window
 *  object is a parameter so a test / the headless harness can inject a mock provider deterministically. */
export function detectWallet(
  win: { ethereum?: Eip1193Provider } = globalThis as unknown as { ethereum?: Eip1193Provider },
): Eip1193Provider | null {
  return win.ethereum ?? null;
}

/** Request the wallet's accounts (`eth_requestAccounts`) and return the first (the active signer address).
 *  Throws `WalletError` on a rejected/empty connection -- the UI surfaces it, never a silent fail. */
export async function connect(p: Eip1193Provider): Promise<string> {
  const accounts = await req<unknown>(p, "eth_requestAccounts");
  const addr = Array.isArray(accounts) ? accounts[0] : undefined;
  if (typeof addr !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(addr)) {
    throw new WalletError("wallet returned no account (connection rejected or empty)");
  }
  return addr;
}

/** The wallet's current chain id (`eth_chainId` -> number). */
export async function chainId(p: Eip1193Provider): Promise<number> {
  const raw = await req<unknown>(p, "eth_chainId");
  const n = typeof raw === "string" ? Number.parseInt(raw, 16) : NaN;
  if (!Number.isFinite(n)) {
    throw new WalletError(`wallet returned a malformed chainId: ${String(raw)}`);
  }
  return n;
}

/** Ensure the wallet is on 0G Galileo (16602): try to SWITCH; if the chain is unknown to the wallet
 *  (EIP-1193 error code 4902), ADD it then switch. Throws `WalletError` on a declined switch. */
export async function ensureGalileo(p: Eip1193Provider): Promise<void> {
  try {
    await p.request({ method: "wallet_switchEthereumChain", params: [{ chainId: GALILEO_CHAIN.chainIdHex }] });
  } catch (err) {
    if (codeOf(err) === 4902) {
      // the chain is unknown to the wallet -> add it (public RPC/explorer), then switch.
      await req(p, "wallet_addEthereumChain", [GALILEO_CHAIN.params]);
      await req(p, "wallet_switchEthereumChain", [{ chainId: GALILEO_CHAIN.chainIdHex }]);
    } else {
      throw new WalletError(`could not switch the wallet to 0G Galileo: ${errMsg(err)}`);
    }
  }
}

/** Ask the wallet to SIGN + broadcast a native transfer of `valueWei` (from -> to). Returns the tx hash.
 *  The wallet signs -- this module never sees the key; `value` is hex-encoded wei. */
export async function sendNativeTransfer(
  p: Eip1193Provider,
  from: string,
  to: string,
  valueWei: bigint,
): Promise<string> {
  if (valueWei < 0n) throw new WalletError("transfer value must be non-negative");
  const hash = await req<unknown>(p, "eth_sendTransaction", [
    { from, to, value: "0x" + valueWei.toString(16) },
  ]);
  if (typeof hash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(hash)) {
    throw new WalletError(`wallet returned a malformed tx hash: ${String(hash)}`);
  }
  return hash;
}

// ---- internals ----------------------------------------------------------------------------------

/** A typed `provider.request` wrapper -- maps a thrown provider error to a loud `WalletError`. */
async function req<T>(p: Eip1193Provider, method: string, params?: readonly unknown[]): Promise<T> {
  try {
    const args = params === undefined ? { method } : { method, params };
    return (await p.request(args)) as T;
  } catch (err) {
    if (err instanceof WalletError) throw err;
    throw new WalletError(`wallet ${method} failed: ${errMsg(err)}`);
  }
}

/** The EIP-1193 numeric error `code`, if any (4902 = "chain not added to the wallet"). */
function codeOf(err: unknown): number | undefined {
  const c = (err as { code?: number } | null)?.code;
  return typeof c === "number" ? c : undefined;
}

function errMsg(err: unknown): string {
  if (err instanceof Error) return err.message;
  const m = (err as { message?: string } | null)?.message;
  return typeof m === "string" ? m : String(err);
}
