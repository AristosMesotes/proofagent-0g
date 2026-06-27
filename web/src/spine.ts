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
 * The on-chain spend cap, mirroring `[mandate_v4]` in proofagent.toml. `registryAddress` is now PINNED to
 * the LIVE consolidated `MandateRegistryV4` on 0G Galileo (its operator-gated deploy has landed -- design
 * §8: claim only what's live), so the thin index page's Rails stamp reads a green `LIVE` (an empty address
 * was the HONEST "not yet deployed" signal; it is no longer empty because V4 is confirmed on-chain).
 */
export const MANDATE = {
  /** Per-transaction cap, the public knob from the spine (`per_tx_cap = "2 USD"`). */
  perTxCapUsd: 2,
  /** Deployed registry address -- the LIVE `MandateRegistryV4` on 16602 (`[mandate_v4].address`; design §8). */
  registryAddress: "0x8e561a5cc096af6e570220a5228b33c7d889f774" as string,
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
  /** Deployed MandateRegistryV4 on Galileo, LIVE + pinned (`[mandate_v4].address`). */
  registry: "0x8e561a5cc096af6e570220a5228b33c7d889f774",
  /**
   * The demo agent the mandate is bound to (the V4 registry's mandated `agent` == `owner`, READ
   * FROM-CHAIN via `cast call <address> "agent()(address)"`; PUBLIC — never from a key/env).
   */
  agent: "0x4850417aE8aEDD5D67344FE98c86515cfb5F393b",
  /**
   * The canonical native-asset sentinel the cap is enforced against on V4
   * (`[mandate_v4].native_asset_sentinel` = `0x..0001`, the V4 `NATIVE()` constant — allowlisted on-chain).
   */
  nativeSentinel: "0x0000000000000000000000000000000000000001",
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
 * proofagent.toml + `demo/EVIDENCE.md` (the on-chain allowlist). All PUBLIC. The deployed, LIVE
 * `MandateRegistryV4` enforces a per-asset allowlist + per-asset sub-caps: ONLY the native sentinel was
 * allowlisted on-chain (`addAllowedAsset(0x..0001, 2_000_000, 18)`), so a DIFFERENT asset is rejected
 * `TOKEN_NOT_ALLOWED` — the same agent gets a DIFFERENT gate decision per asset. The amounts below make
 * the per-asset enforcement visible against the LIVE V4 registry, each as a real read-only `eth_call`:
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
  /** Deployed MandateRegistryV4 on Galileo, LIVE (same address the RAILS leg reads — `[mandate_v4].address`). */
  registry: "0x8e561a5cc096af6e570220a5228b33c7d889f774",
  /** The demo agent the mandate is bound to (the V4 registry's mandated `agent`, READ FROM-CHAIN; PUBLIC). */
  agent: "0x4850417aE8aEDD5D67344FE98c86515cfb5F393b",
  /** The allowlisted native-asset sentinel the cap is enforced against (`[mandate_v4].native_asset_sentinel`). */
  nativeSentinel: "0x0000000000000000000000000000000000000001",
  /**
   * A NON-allowlisted asset on the deployed V4 registry — the public USDC.E token on 0G
   * (`[bridge].usdce_token`). It was never `addAllowedAsset`-allowlisted on V4, so the gate
   * rejects it `TOKEN_NOT_ALLOWED` for the same agent — proving the mandate is enforced PER ASSET.
   */
  nonAllowlistedAsset: "0x1f3AA82227281cA364bFb3d253B0f1af1Da6473E",
  /** The native sentinel's on-chain per-asset sub-cap, MINOR units (wei) — `assetCap[sentinel]` (`[mandate_v4]`). */
  perAssetCap: 2_000_000n,
  /** An UNDER-cap probe amount, MINOR units (wei). 1_000_000 < the 2_000_000 sub-cap → the chain answers `(true, OK)`. */
  underCapAmount: 1_000_000n,
  /** An OVER-cap probe amount, MINOR units (wei). 3_000_000 > the 2_000_000 sub-cap → the chain answers `(false, OVER_TX_CAP)`. */
  overCapAmount: 3_000_000n,
  /** The amount probed against the NON-allowlisted asset (rejected on the allowlist rung BEFORE any cap). */
  nonAllowlistedAmount: 1_000_000n,
} as const;

/* ------------------------------------------------------------------------------------------------ *
 * The MANDATE-CARD context -- the deployed-registry mirror the expanded RAILS card reads (design §10.4b).
 *
 * ## Why a CONTEXT OBJECT (not loose constants)
 *
 * The mandate card is a READ-ONLY mirror of the deployed mandate registry. Everything chain-specific is
 * threaded as ONE `{chainId, registryAddress}` context so that bringing a NEW registry live (the
 * consolidated `MandateRegistryV4`, whose operator-gated deploy has now LANDED) was a DATA change here --
 * repoint `chainId` + `registryAddress` -- never a card REDESIGN. By-CHAIN is the SINGLE 0G badge only (one
 * enforcement chain; the 0g-only gate proves it); there is deliberately NO chain selector. V4's
 * `[mandate_v4].address` is now pinned in `proofagent.toml`, so `registryAddress` (and the tier facts) moved.
 *
 * ## What is LIVE (the honesty split -- design §8, claim only what's live)
 *
 * The card reads the **currently-deployed** registry: the consolidated, hardened `MandateRegistryV4`, now
 * LIVE on 0G Galileo (`[mandate_v4].address` = `0x8e561a…f774`), which enforces
 * `checkTransfer(agent,token,amount) -> (ok,reason)` (selector `0xcc1dd94f`), the asset allowlist + per-asset
 * sub-caps, the global per-tx cap, AND the leaky-bucket period cap -- the exact surface the per-asset table +
 * the wallet-free simulator read. V4 folds the MVP `MandateRegistry` + the four-tier `MandateRegistryV3` +
 * the TimelockGuard into ONE non-custodial gate (built + Foundry-tested + verifier-confirmed, now deployed
 * + tier-configured on-chain). The MVP registry + V3 remain on-chain as historical provenance but V4 is the
 * pinned mandate the card reads. The V4 USD cap stays opt-in (`usd_cap_micros = 0`, off by default), so the
 * card labels the USD tier as a configured-off spec, never a live-enforced number it does not read.
 *
 * ## Two-source reconciliation (design §3 #1, §8)
 *
 * The on-chain read is the BASELINE: the card's stated config (the per-asset caps + allowlist) is
 * RECONCILED against what `checkTransfer` actually answers on-chain (an independent eth_call). Agreement
 * is `Reconciled`; a disagreement is a LOUD `Drifted`; an unreachable RPC is an honest `Unverified` (never
 * faked green). The displayed config is never trusted over the chain -- the chain read is the arbiter.
 * ------------------------------------------------------------------------------------------------ */

/** One asset row the per-asset mandate table mirrors (PUBLIC; mirrors the deployed registry's allowlist). */
export interface MandateAsset {
  /** A short human symbol for the asset (UI label; never the source of truth). */
  readonly symbol: string;
  /** The asset's 20-byte address (the allowlist key the gate reads). */
  readonly address: string;
  /** The asset's decimals (for formatting the raw per-tx cap into whole units; PUBLIC). */
  readonly decimals: number;
  /** `true` iff this asset is on the deployed registry's allowlist (the stated config; reconciled on-chain). */
  readonly allowed: boolean;
  /** The per-tx cap for this asset, MINOR units (the effective `min(perTxCap, assetCap)`); 0 when blocked. */
  readonly perTxCap: bigint;
}

/**
 * The mandate-card context -- the deployed-registry mirror, threaded as ONE object so multi-chain is a
 * later DATA change (repoint `chainId` + `registryAddress`), not a redesign. All PUBLIC: mirrors
 * `[mandate_v4]` (the LIVE consolidated `MandateRegistryV4` the card now reads -- `0x8e561a…f774`). The
 * period tier is the V4's on-chain leaky-bucket cap (`setPeriodConfig(3600, 1_500_000)` confirmed), rendered
 * as a live-enforced figure; the V4 USD cap stays opt-in (off by default), labelled so -- never a number the
 * card does not read. The MVP registry + V3 remain on-chain as historical provenance, superseded by V4.
 */
export const MANDATE_CARD = {
  /** The enforcement chain id -- the ONE 0G chain the deployed registry is live on (Galileo testnet). */
  chainId: 16602,
  /**
   * The DEPLOYED registry address the card reads (`[mandate_v4].address` -- the LIVE consolidated
   * `MandateRegistryV4`, `0x8e561a…f774`). This single field repointed when the V4 deploy landed -- the
   * card is unchanged (the context-object design made it a data move, not a redesign).
   */
  registryAddress: "0x8e561a5cc096af6e570220a5228b33c7d889f774",
  /** The mandated agent the V4 registry is bound to (`[mandate_v4].agent`, READ FROM-CHAIN; PUBLIC). */
  agent: "0x4850417aE8aEDD5D67344FE98c86515cfb5F393b",
  /** The global per-tx cap on the DEPLOYED V4 registry, MINOR units (`[mandate_v4].per_tx_cap` = 2_000_000 wei). */
  perTxCap: 2_000_000n,
  /** The same cap, USD knob, for the human-readable label (`[mandate].per_tx_cap = "2 USD"`). */
  perTxCapUsd: 2,
  /**
   * The per-asset table the card mirrors -- the deployed V4 registry's allowlist + per-asset sub-caps. The
   * native sentinel (`0x..0001`) is allowlisted on-chain (`addAllowedAsset(0x..0001, 2_000_000, 18)`); the
   * public USDC.E token is NOT allowlisted (the gate answers `TOKEN_NOT_ALLOWED`), so its row is greyed/blocked.
   * These stated rows are RECONCILED against the chain's own `checkTransfer` answers (the on-chain read is truth).
   */
  assets: [
    {
      symbol: "0G (native)",
      address: "0x0000000000000000000000000000000000000001",
      decimals: 18,
      allowed: true,
      perTxCap: 2_000_000n,
    },
    {
      symbol: "USDC.E",
      address: "0x1f3AA82227281cA364bFb3d253B0f1af1Da6473E",
      decimals: 6,
      allowed: false,
      perTxCap: 0n,
    },
  ] as readonly MandateAsset[],
  /**
   * The V4 global period cap (`[mandate_v4]`), carried for the period-cap bar. The consolidated
   * `MandateRegistryV4` is now DEPLOYED + tier-configured LIVE on 16602: `setPeriodConfig(3600, 1_500_000)`
   * is confirmed on-chain (read back via `periodSeconds()`/`periodCap()`), so the leaky-bucket period cap is
   * a LIVE-enforced number. The USD cap stays opt-in (`usd_cap_micros = 0`, off by default), so the bar's
   * period figures are the CONFIGURED, on-chain rolling-window cap (`period_cap`) + window (`period_seconds`);
   * `used` reads 0 because no demo spend has accrued against the live bucket (an honest empty, not a fake).
   */
  v4Spec: {
    /** `true` iff the consolidated V4 registry is DEPLOYED + pinned (`[mandate_v4].address` non-empty). LIVE. */
    deployed: true,
    /** The leaky-bucket window length, seconds (`[mandate_v4].period_seconds` = 3600 = 1h; on-chain). */
    periodSeconds: 3600,
    /** The leaky-bucket cumulative cap per window, MINOR units (`[mandate_v4].period_cap` = 1_500_000; on-chain). */
    periodCap: 1_500_000n,
    /** The per-tx USD cap, micro-dollars (`[mandate_v4].usd_cap_micros`; 0 => opt-in, off by default). */
    usdCapMicros: 0n,
  },
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

/**
 * The 0G Storage "Wow" leg surface (design §9 Wow): the verifier's verdict bundle published to 0G Storage as
 * immutable, content-addressed evidence -- "the proof itself lives on 0G". `rootHash` is the on-0G Merkle
 * handle of the latest published bundle. It is now PINNED to a REAL live publish (a verdict bundle uploaded
 * via the official `@0gfoundation/0g-storage-ts-sdk` against a funded 0G wallet on Galileo), so the Storage
 * stamp renders LIVE and any viewer can re-fetch the bundle by its rootHash on storagescan. All PUBLIC,
 * re-checkable evidence -- never a fabricated handle (empty would render PENDING; this is a genuine root).
 */
export const STORAGE_ONCHAIN = {
  /** The 0G Storage Merkle rootHash of a real published verdict bundle (LIVE -- re-fetchable on storagescan). */
  rootHash: "0x6b51c075fccac9fff9ab461fee61252d93cd676010ffcb5f79972d8432fe3f6b" as string,
  /** The 0G Storage publishing transaction hash (the on-chain anchor of the upload -- confirmable on chainscan). */
  txHash: "0xb7e7f04f2450a08e60f4c53bccbd6e070b3875a8868e89e39dd2b506748f6582",
  /** The public 0G Galileo explorer base (so a viewer can confirm the publishing tx on 0G). */
  explorer: "https://chainscan-galileo.0g.ai",
  /** The public 0G Storage scan base (so a viewer can re-fetch the bundle by its rootHash). */
  storageExplorer: "https://storagescan-galileo.0g.ai",
} as const;

/**
 * The 0G Compute "Depth" leg surface (design §9 Depth): a REAL, verified per-response TEE attestation from
 * 0G Compute, pinned as the brain's evidence. `attested: true` is reached ONLY because a live inference ran
 * inside a 0G Compute TEE and `processResponse` VERIFIED the enclave signature (via the official
 * `@0gfoundation/0g-compute-ts-sdk` broker) -- provider + model + responseId are the auditable references.
 * Unlike the Storage rootHash / the on-chain mandate (which a viewer re-checks on a scan), a TEE attestation
 * is a ONE-TIME enclave signature: the durable proof is this recorded evidence + the REPRODUCIBLE broker call
 * (anyone re-runs it with the official SDK + a funded ledger). It is NEVER fabricated -- the brain stamp lifts
 * green ONLY for `attested === true`, and `planZeroGCompute` mints `"tee"` ONLY on the same live verification.
 */
export const BRAIN_ONCHAIN = {
  /** `true` -- a real 0G Compute TEE attestation VERIFIED (processResponse === true) on a live inference. */
  attested: true,
  /** The 0G Compute TEE provider the attestation is for (public address). */
  provider: "0xa48f01287233509FD694a22Bf840225062E67836",
  /** Which model actually ran inside the enclave. */
  model: "qwen/qwen2.5-omni-7b",
  /** The per-response handle the enclave signature keyed on (the auditable reference). */
  responseId: "8a389c56-b252-428c-a44c-b098f03b9b35",
  /** Honest note: verified + reproducible via the official SDK; a one-time signature, not a re-fetchable hash. */
  reason:
    "0G Compute TEE attestation VERIFIED (processResponse === true) via @0gfoundation/0g-compute-ts-sdk — " +
    "re-runnable with the official SDK + a funded 0G ledger; a one-time enclave signature, not a frozen hash.",
} as const;

/**
 * The READ-ONLY "watch the agent's wallet on 0G" surface (the honest, key-free wallet display). A PUBLIC
 * wallet ADDRESS the console shows live, read-only (native balance + nonce) -- NO key, NO signing (the
 * console never holds a key, by construction). Defaults to the public demo wallet the LEDGER / V4 deploy /
 * live settlement already use (already public on-chain); overridable via the input. NEVER a private key.
 */
export const WATCH = {
  /** The default public wallet address to watch (the demo wallet -- already public on-chain). */
  address: "0x4850417aE8aEDD5D67344FE98c86515cfb5F393b",
} as const;
