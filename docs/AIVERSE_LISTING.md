# Listing the ProofAgent Agentic ID on the AIverse marketplace — operator runbook

The ProofAgent Agentic ID is **deployed + verified live on 0G mainnet** (Aristotle, chain `16661`). Putting it
into the **AIverse** marketplace catalog (`aiverse.0g.ai` / `app.0g.ai`) is a short browser step — this is the
one-click checklist, with every value you need pre-filled.

> Honest status: AIverse's **custom-contract** catalog import is *"direct minting integrations coming soon."*
> The on-chain asset is fully live + standards-conformant **now**; the two paths below cover (A) importing our
> deployed contract once that lands, and (B) minting through AIverse's own app today.

---

## The live mainnet artifacts (everything you'll paste)

| What | Address (0G mainnet, 16661) | Explorer |
|---|---|---|
| **Agentic ID — conformant (recommended)** | `0x1E56e7bde7147FEaa3a1d4bcd1b2C305d2201E6e` | [chainscan ✓ verified](https://chainscan.0g.ai/address/0x1E56e7bde7147FEaa3a1d4bcd1b2C305d2201E6e) |
| Verifier oracle (TEE) | `0xE0D51040d3285383ED2ad08589eE538a6Ee64cE7` | chainscan |
| Agentic ID — simple | `0xcb00ACb3daC87465c4c931B3b713710e1c17Be7f` | [chainscan ✓ verified](https://chainscan.0g.ai/address/0xcb00ACb3daC87465c4c931B3b713710e1c17Be7f) |
| MandateRegistryV4 (rails) | `0xD96F7e0cb712Bbc5b17ebb6fd13F48e47a7320DF` | chainscan |

- **Token:** `#1` (already minted), owner `0x9893BE528e31F6ea27064B27417AD7d87b623616`.
- **Use the conformant one** (`0x1E56e7…`) for AIverse — it returns `true` for `type(IERC7857).interfaceId`, so an
  interface-detecting catalog recognises it; it also enforces `canSpend` on-chain (over-cap → `OVER_TX_CAP`).
- **Model:** `qwen/qwen2.5-omni-7b` · **sealed mind (0G Storage rootHash):** `0x6b51c075…2fe3f6b`.

## 0) One-time: add 0G mainnet to your wallet (MetaMask)
- Network name: `0G Aristotle` · RPC: `https://evmrpc.0g.ai` · Chain ID: `16661` · Currency: `0G` · Explorer:
  `https://chainscan.0g.ai`
- Use the wallet that owns token #1 (`0x9893BE…`) so you can manage/list it.

## Path A — import the deployed contract (preferred; when AIverse opens custom-contract listing)
1. Go to `app.0g.ai` (or `aiverse.0g.ai`) and **Connect Wallet** → select **0G Aristotle (16661)**.
2. Open the **Create / Import / List** flow → choose **"import an existing iNFT / contract"** (this is the
   "coming soon" path; if absent, use Path B).
3. Paste the **conformant** contract address `0x1E56e7bde7147FEaa3a1d4bcd1b2C305d2201E6e` and token id `1`.
4. The catalog reads the on-chain metadata (`intelligentDatasOf`, `tokenURI`, `supportsInterface`) — it should
   detect the ERC-7857 interface automatically. Confirm name **"ProofAgent Agentic ID"**, model `qwen/qwen2.5-omni-7b`.
5. Submit. Pay the (small) gas if prompted. The agent appears in the catalog, ownable + tradeable.

## Path B — mint through AIverse today (uses AIverse's own contract)
1. `app.0g.ai` → **Connect Wallet** (0G Aristotle) → **Create / Mint Agent**.
2. Fill: **name** = `ProofAgent — can't lie, can't overspend`; **description** = the thesis + the proof links
   (paste the chainscan links above so judges can verify); **model** = `qwen/qwen2.5-omni-7b`; upload an image.
3. For the encrypted "intelligence", point it at the 0G Storage rootHash `0x6b51c075…2fe3f6b` (the sealed mind)
   if it accepts an external handle; otherwise let AIverse seal it.
4. Mint → it lists in the catalog. *(Note: this mints via AIverse's contract, so it won't carry our on-chain
   `canSpend` mandate enforcement — keep the deployed contract above as the canonical, verifiable version and
   link it in the description.)*

## Verify it's real (for the listing description / judges)
```bash
RPC=https://evmrpc.0g.ai; ID=0x1E56e7bde7147FEaa3a1d4bcd1b2C305d2201E6e
cast call $ID "ownerOf(uint256)(address)" 1 --rpc-url $RPC          # 0x9893BE…
cast call $ID "supportsInterface(bytes4)(bool)" 0x80ac58cd --rpc-url $RPC   # true (ERC-721)
cast call $ID "canSpend(uint256,address,uint256)(bool,bytes32)" 1 0x0000000000000000000000000000000000000001 1000000000000000000 --rpc-url $RPC   # false, OVER_TX_CAP
```
Every line is independently checkable — the whole point of ProofAgent.
