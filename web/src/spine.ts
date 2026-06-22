/**
 * spine.ts -- the SINGLE clean-room source of the public data-spine constants (mirror proofagent.toml).
 *
 * ## Why this module exists
 *
 * The spine-derived public constants (the 0G chain + explorer, the per-tx cap + registry, the verifier
 * corpus + tolerance band, the deployed `MandateRegistry` + pinned SETTLED tx) were historically declared
 * in TWO places -- `proofs.ts` and `onchain.ts` -- with overlapping values (chain ids, the cap, the
 * tolerance band). As the surface grows, two copies can DRIFT: a value pinned in one file but stale in the
 * other is a silent honesty hazard (the screen would claim a number the spine no longer pins). This module
 * lifts every such constant into ONE place so there is a single source of truth a growing surface reads.
 *
 * ## Backward-compatible by construction (no behaviour change)
 *
 * `proofs.ts` and `onchain.ts` RE-EXPORT the constants they already exposed (`CHAIN`, `MANDATE`,
 * `VERIFIER`, `GALILEO`, `RAILS_ONCHAIN`, `SETTLED_ONCHAIN`), so every existing importer -- `main.ts`, the
 * tests, the headless harness -- keeps working unchanged, against byte-identical values. This module only
 * RELOCATES the declarations; it changes no value, no type, and no behaviour. The honesty doctrine is
 * preserved verbatim: an empty `registryAddress` is still the honest "not yet pinned on-chain" signal, the
 * tolerance band is still the exact-integer 15/100 (no float), and every value here is PUBLIC -- it mirrors
 * `proofagent.toml`, with no proprietary identifier, private path, or secret.
 *
 * ## Clean-room (design §6)
 *
 * Nothing secret. Every constant mirrors the PUBLIC spine `proofagent.toml`; the RPC URL is the public 0G
 * Galileo endpoint (overridable at run time elsewhere), never a private endpoint, and no wallet material is
 * present.
 */

/* ------------------------------------------------------------------------------------------------ *
 * The 0G chain + public explorer (mirror `[chain]` in proofagent.toml).
 * ------------------------------------------------------------------------------------------------ */

/** The 0G chain + public explorer, mirroring `[chain]` in proofagent.toml. */
export const CHAIN = {
  /** 0G Aristotle chain id (design appendix). */
  id: 16661,
  name: "0G Aristotle",
  /** Galileo testnet chain id -- where live legs run (design §8: testnet/dev only). */
  testnet: 16602,
  /** The public explorer (design appendix: chainscan.0g.ai). Viewers confirm the chain themselves. */
  explorer: "https://chainscan.0g.ai",
} as const;

/**
 * The on-chain spend cap, mirroring `[mandate]` in proofagent.toml. `registryAddress` is empty until the
 * MandateRegistry is confirmed/deployed on-chain (design §8: claim only what's live). An empty address is
 * the HONEST "not yet deployed" signal -- the UI must not render a green "live on-chain" rails stamp while
 * it is empty.
 */
export const MANDATE = {
  /** Per-transaction cap, the public knob from the spine (`per_tx_cap = "2 USD"`). */
  perTxCapUsd: 2,
  /** Deployed registry address, or "" when not yet pinned on-chain (design §8). */
  registryAddress: "" as string,
} as const;

/**
 * The settlement corpus, mirroring `[verifier]` `corpus` in proofagent.toml. Empty until real,
 * already-settled txs are confirmed on-chain (design §6: "Demo against already-public settlements" /
 * §8: claim only what's live). While empty, the UI asserts NO `settled` -- the one live proof is the NEG
 * case. The exact-integer tolerance band mirrors `[verifier.tolerance]` (15/100 -- design §3 #5).
 */
export const VERIFIER = {
  /** Count of real, already-settled txs pinned in the spine (0 until confirmed on-chain). */
  corpusSize: 0,
  /** Exact-integer tolerance band num/den (no float on the money path -- design §3 principle 5). */
  toleranceNum: 15,
  toleranceDen: 100,
} as const;

/* ------------------------------------------------------------------------------------------------ *
 * 0G Galileo testnet + the deployed on-chain surface (mirror `[mandate]` / `[[verifier.corpus]]`).
 *
 * These pin the SAME live surface the demo's `demo/EVIDENCE.md` confirms on the public explorer:
 * the deployed MandateRegistry, the native-asset sentinel, the agent identity, the pinned SETTLED tx,
 * and the per-tx cap -- all on 0G Galileo testnet (chain id 16602).
 * ------------------------------------------------------------------------------------------------ */

/** 0G Galileo testnet -- the chain the deployed registry + pinned SETTLED tx are live on. */
export const GALILEO = {
  /** Galileo testnet chain id (mirrors `[mandate].chain_id` / `[verifier]` corpus context). */
  chainId: 16602,
  /**
   * The public 0G Galileo JSON-RPC endpoint (mirrors `demo/EVIDENCE.md` RPC). Read-only reads only;
   * overridable at run time via the env-injected RPC so a private endpoint is never baked in here.
   */
  rpcUrl: "https://evmrpc-testnet.0g.ai",
  /** The public 0G Galileo testnet explorer (so a viewer confirms each read themselves). */
  explorer: "https://chainscan-galileo.0g.ai",
} as const;

/**
 * The deployed `MandateRegistry` + the identities the RAILS read targets, mirroring `[mandate]` in
 * proofagent.toml. All PUBLIC (the spine marks each "safe to commit"): the registry address, the
 * native-asset sentinel the cap is enforced against, the demo agent the mandate is bound to, and the
 * per-tx cap. The OVER-cap probe amount is strictly above the cap so the chain MUST answer
 * `OVER_TX_CAP` -- the honest, deterministic block.
 */
export const RAILS_ONCHAIN = {
  /** Deployed MandateRegistry on Galileo (`[mandate].address`). */
  registry: "0x675FF5053F434AA3f1d48574813BFc1696FBD345",
  /** The demo agent the mandate is bound to (the registry's mandated `agent`; PUBLIC). */
  agent: "0xc7Af61A1399Aca0bee648D7853AE93f96B86866a",
  /** The canonical native-asset sentinel the cap is enforced against (`[mandate].native_asset_sentinel`). */
  nativeSentinel: "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE",
  /** The on-chain per-tx cap, MINOR units (wei) -- `perTxCap = 2_000_000` (`[mandate]`). */
  perTxCap: 2_000_000n,
  /**
   * The OVER-cap probe amount, MINOR units (wei). 3_000_000 > the 2_000_000 cap, so `checkTransfer`
   * MUST return `(false, OVER_TX_CAP)` -- the deterministic block the screen renders (mirrors the
   * `demo/EVIDENCE.md` PROOF 2 over-cap request).
   */
  overCapAmount: 3_000_000n,
} as const;

/**
 * The PER-ASSET mandate surface the dry-run's mandate-BY-ASSET leg probes, mirroring `[mandate]` in
 * proofagent.toml + `demo/EVIDENCE.md` (the on-chain `setAssetCap` allowlist). All PUBLIC. The deployed
 * MVP `MandateRegistry` enforces a per-asset allowlist + per-asset sub-caps: ONLY the native sentinel was
 * allowlisted on-chain (`setAssetCap(0xEeee…EEeE, 2_000_000, true)`), so a DIFFERENT asset is rejected
 * `TOKEN_NOT_ALLOWED` — the same agent gets a DIFFERENT gate decision per asset. The amounts below make
 * the per-asset enforcement visible against the LIVE registry, each as a real read-only `eth_call`:
 *
 *  - the native sentinel UNDER its sub-cap → `(true, OK)`        (allowed asset under cap → ALLOWED);
 *  - the native sentinel OVER  its sub-cap → `(false, OVER_TX_CAP)` (allowed asset over its per-asset cap;
 *    for this asset the per-asset sub-cap EQUALS the global per-tx cap (both 2_000_000), so the first-
 *    failing rung the chain returns is `OVER_TX_CAP` — the honest on-chain over-cap block);
 *  - a NON-allowlisted asset (the public USDC.E token) → `(false, TOKEN_NOT_ALLOWED)` (per-asset allowlist).
 *
 * These are read-only probes (no key, no broadcast); the rendered verdict is always the decoded on-chain
 * `(ok, reason)`, never fabricated — an unexpected answer surfaces loud, never softened to an allow.
 */
export const MANDATE_ASSETS = {
  /** Deployed MandateRegistry on Galileo (same address the RAILS leg reads — `[mandate].address`). */
  registry: "0x675FF5053F434AA3f1d48574813BFc1696FBD345",
  /** The demo agent the mandate is bound to (the registry's mandated `agent`; PUBLIC). */
  agent: "0xc7Af61A1399Aca0bee648D7853AE93f96B86866a",
  /** The allowlisted native-asset sentinel the cap is enforced against (`[mandate].native_asset_sentinel`). */
  nativeSentinel: "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE",
  /**
   * A NON-allowlisted asset on the deployed registry — the public USDC.E token on 0G
   * (`[bridge].usdce_token`). It was never `setAssetCap`-allowlisted on this MVP registry, so the gate
   * rejects it `TOKEN_NOT_ALLOWED` for the same agent — proving the mandate is enforced PER ASSET.
   */
  nonAllowlistedAsset: "0x1f3AA82227281cA364bFb3d253B0f1af1Da6473E",
  /** The native sentinel's on-chain per-asset sub-cap, MINOR units (wei) — `assetCap[sentinel]` (`[mandate]`). */
  perAssetCap: 2_000_000n,
  /** An UNDER-cap probe amount, MINOR units (wei). 1_000_000 < the 2_000_000 sub-cap → the chain answers `(true, OK)`. */
  underCapAmount: 1_000_000n,
  /** An OVER-cap probe amount, MINOR units (wei). 3_000_000 > the 2_000_000 sub-cap → the chain answers `(false, OVER_TX_CAP)`. */
  overCapAmount: 3_000_000n,
  /** The amount probed against the NON-allowlisted asset (rejected on the allowlist rung BEFORE any cap). */
  nonAllowlistedAmount: 1_000_000n,
} as const;

/**
 * The PINNED, already-settled tx the SETTLED read confirms, mirroring `[[verifier.corpus]]` in
 * proofagent.toml + `demo/EVIDENCE.md` PROOF 1. A genuine native 0G transfer on Galileo: `status 0x1`
 * (Success) and a native `value` of `claimed` wei, so the verifier's adjudication is `settled`.
 */
export const SETTLED_ONCHAIN = {
  /** The pinned SETTLED tx hash (`[[verifier.corpus]].hash`; confirmable on the explorer). */
  hash: "0x8c59d0e8beabc492f24e1726903388a852c964137790c47920b2cbbe3ef5bfb0",
  /** The agent's recorded claim, MINOR units (wei) -- `[[verifier.corpus]].claimed`. */
  claimed: 1_000_000n,
  /** Exact-integer tolerance band num/den (`[verifier.tolerance]`; no float -- design §3 #5). */
  toleranceNum: 15n,
  toleranceDen: 100n,
} as const;
