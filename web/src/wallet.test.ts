import { test } from "node:test";
import assert from "node:assert/strict";
import {
  detectWallet,
  connect,
  chainId,
  ensureGalileo,
  sendNativeTransfer,
  WalletError,
  GALILEO_CHAIN,
  type Eip1193Provider,
} from "./wallet.js";

/** A scriptable mock EIP-1193 provider: maps `method -> handler`, records the call order. */
function mockProvider(
  handlers: Record<string, (params?: readonly unknown[]) => unknown>,
): Eip1193Provider & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async request({ method, params }: { method: string; params?: readonly unknown[] }) {
      calls.push(method);
      const h = handlers[method];
      if (!h) throw Object.assign(new Error(`unhandled ${method}`), { code: -32601 });
      return h(params);
    },
  };
}

test("detectWallet returns the injected provider, or null when absent", () => {
  const p = mockProvider({});
  assert.equal(detectWallet({ ethereum: p }), p);
  assert.equal(detectWallet({}), null);
});

test("connect returns the first account; rejects an empty/malformed result", async () => {
  const ok = mockProvider({ eth_requestAccounts: () => ["0x1111111111111111111111111111111111111111"] });
  assert.equal(await connect(ok), "0x1111111111111111111111111111111111111111");
  await assert.rejects(() => connect(mockProvider({ eth_requestAccounts: () => [] })), WalletError);
  await assert.rejects(() => connect(mockProvider({ eth_requestAccounts: () => ["nope"] })), WalletError);
});

test("chainId parses the hex chain id; rejects a malformed one", async () => {
  assert.equal(await chainId(mockProvider({ eth_chainId: () => "0x40da" })), 16602);
  await assert.rejects(() => chainId(mockProvider({ eth_chainId: () => "oops" })), WalletError);
});

test("ensureGalileo switches; on a 4902 unknown-chain it ADDS then switches", async () => {
  const sw = mockProvider({ wallet_switchEthereumChain: () => null });
  await ensureGalileo(sw);
  assert.deepEqual(sw.calls, ["wallet_switchEthereumChain"]);

  let switched = 0;
  const addThenSwitch = mockProvider({
    wallet_switchEthereumChain: () => {
      switched += 1;
      if (switched === 1) throw Object.assign(new Error("unrecognized chain"), { code: 4902 });
      return null;
    },
    wallet_addEthereumChain: () => null,
  });
  await ensureGalileo(addThenSwitch);
  assert.deepEqual(addThenSwitch.calls, [
    "wallet_switchEthereumChain",
    "wallet_addEthereumChain",
    "wallet_switchEthereumChain",
  ]);
});

test("ensureGalileo surfaces a declined (non-4902) switch as a WalletError", async () => {
  const declined = mockProvider({
    wallet_switchEthereumChain: () => {
      throw Object.assign(new Error("user rejected"), { code: 4001 });
    },
  });
  await assert.rejects(() => ensureGalileo(declined), WalletError);
});

test("sendNativeTransfer hex-encodes value + returns the tx hash; rejects a bad hash", async () => {
  const p = mockProvider({
    eth_sendTransaction: (params) => {
      const tx = (params as [{ from: string; to: string; value: string }])[0];
      assert.equal(tx.value, "0x" + (1_000_000n).toString(16)); // value is hex-encoded wei
      assert.equal(tx.from, "0xfrom");
      assert.equal(tx.to, "0xto");
      return "0x" + "a".repeat(64);
    },
  });
  assert.equal(await sendNativeTransfer(p, "0xfrom", "0xto", 1_000_000n), "0x" + "a".repeat(64));
  await assert.rejects(
    () => sendNativeTransfer(mockProvider({ eth_sendTransaction: () => "0xshort" }), "0xa", "0xb", 1n),
    WalletError,
  );
  await assert.rejects(() => sendNativeTransfer(p, "0xa", "0xb", -1n), WalletError);
});

test("GALILEO_CHAIN pins 16602 + the public RPC/explorer (no secret)", () => {
  assert.equal(GALILEO_CHAIN.chainIdNum, 16602);
  assert.equal(GALILEO_CHAIN.chainIdHex, "0x40da");
  assert.deepEqual(GALILEO_CHAIN.params.rpcUrls, ["https://evmrpc-testnet.0g.ai"]);
  assert.deepEqual(GALILEO_CHAIN.params.blockExplorerUrls, ["https://chainscan-galileo.0g.ai"]);
});
