# ProofAgent-0G — Add an Adapter (the recipe)

> **Width-by-data.** A new protocol is *a manifest entry + an adapter* — **zero** change to the gateway's
> dispatch or the verifier's settlement entry. The adapter **cannot vote itself in**: it is trusted only
> once the gate passes (build · lint · typecheck · tests · a money-critical boot check). An unproven
> adapter degrades **loud-UNVERIFIED**, never **silent-green**.

This is the exact, reproducible procedure to add a protocol to ProofAgent-0G. It touches three seams and
one gate, in order:

1. **Implement the execution contract** — an `ExecutionConnector` (the agent side).
2. **Declare the manifest entry** — one `[[connector]]` block in `proofagent.toml` (the data spine).
3. **Let the verifier confirm the settlement** — through the **one** unified settlement entry
   (`verify_connector_settlement`), routing to the matching per-protocol algebra.
4. **Pass the gate** — build · lint · typecheck · tests · the clean-room firewall · a money-critical boot
   check — *before the adapter is trusted*.

Every step stays **clean-room**: public protocol facts only (addresses, selectors, endpoints from config),
no proprietary identifier, no private path, no secret. Amounts are exact-integer minor units (`bigint` in
TypeScript, `i128` in Rust) — **no floating point** on the money path.

---

## The four invariants a new adapter MUST preserve

These are not negotiable; the gate enforces each one:

1. **The verdict monopoly.** Only the verifier mints a verdict (`settled / hollow / mismatch /
   unverified`). The adapter produces **claims and facts** — never a verdict. There is **no new verdict
   enum**; a new protocol reuses the same four-verdict alphabet through the same monopoly.
2. **Two-source truth.** The adapter's account of an action is a **Claim** (never trusted). The verifier's
   own independent on-chain read is the **Observation**. They meet only inside the settlement algebra.
3. **Never fabricate.** An unavailable / unreadable result degrades **loudly** to `unverified`, never
   silently to a fabricated `settled`. A not-wired live signer fails **closed**, loud — never a made-up
   order id / tx hash.
4. **Deterministic + exact-integer.** Same inputs → same verdict and the same reproducible digest; minor
   units only, no float.

---

## Step 1 — Implement the execution contract (the agent side)

The agent never names a protocol; it expresses ONE intent and the gateway dispatches over adapters. So a
new protocol is a new **`ExecutionConnector`** — the five-method seam in `agent/src/connector.ts`:

| Method | Moves value? | Contract |
|---|---|---|
| `quote(intent, ctx)` | **No** (read-only) | Produce a priced `Quote`. An intent it cannot serve is `quotable: false` with a loud reason — **never throws** for an unservable intent (the gateway skips it). |
| `buildUnsigned(intent, ctx)` | **No** (pure) | Build the deterministic `UnsignedTx` (ordered un-signed calls + the exact-integer floor + a secret-free descriptor). A malformed intent / unconfigured venue is a loud `ConnectorError`, **pre-submit**. |
| `submit(tx, ctx)` | **YES** (the only one) | Sign + broadcast via the operator-wired `ctx.signer`. With no signer wired it **fails CLOSED** (loud not-wired), never a fabricated `OrderId`. |
| `status(orderId, ctx)` | No | Read the lifecycle `OrderStatus`, incl. the load-bearing **`valueMoved`** flag. Unreadable → loud `UNKNOWN`. |
| `cancel(orderId, ctx)` | No | Best-effort cancel of a **pre-value** order. MUST refuse (loudly) anything whose value already moved — it cannot un-move funds. |

**Write the adapter under `agent/src/adapters/`** (e.g. `myproto_adapter.ts`), wrapping your protocol's
proven on-chain shape behind this contract. Keep all protocol-specific public facts (addresses, selectors,
endpoints) in config (the data spine) — never baked into the adapter.

The gateway's **fund-loss-safe `value_moved` short-circuit** is automatic once you honour the contract: the
split between `buildUnsigned` (pure) and `submit` (the only value-mover) lets the gateway fall back freely
on a **pre-broadcast** failure, but the instant `submit` puts value in flight it **STOPS** — it never
retries or falls back (a re-dispatch could double-spend). Your adapter must set `valueMoved: true` the
moment it has broadcast anything that could move funds, and never clear it on a later failure/refund.

**Tests (agent side):** add adapter tests mirroring the existing ones (`agent/src/adapters/adapters.test.ts`)
— a quotable + a not-quotable intent, a pure build, a not-wired `submit` failing closed, and the `status`
`valueMoved` read. The gateway already has the priced-fallback + short-circuit tests; a new adapter just
plugs in.

---

## Step 2 — Declare the manifest entry (the data spine)

Add **one `[[connector]]` block** to `proofagent.toml`. This is the width-by-data seam — the verifier and
the gateway learn the new connector from config, with **no code change** to their dispatch:

```toml
[[connector]]
name     = "myproto"                     # a stable connector id (the gateway registry key / journal label)
shape    = "swap"                        # settlement / swap / route / bridge — the algebra the verifier uses
chains   = [16602, 16661]                # the chain id(s) the connector runs on (testnet / mainnet)
priority = 40                            # the gateway's priced-fallback tie-break (lower = preferred)
gates    = ["settlement", "mandate-cap"] # WHICH named [[check]] gates MUST pass before it is trusted
```

Field-by-field:

- **`name`** — a stable, human-readable id. The gateway registers the adapter under it; the journal labels
  rows with it.
- **`shape`** — the settlement family the verifier adjudicates the connector through: one of
  `settlement` · `swap` · `route` · `bridge`. **This is the routing key.** It maps to the verifier's
  `ConnectorKind`, which selects which per-protocol algebra runs (Step 3). If your protocol fits an
  existing family's observation shape (a single delivered amount + an on-chain floor → `swap`/`route`; a
  two-leg cross-chain transfer → `bridge`; a native value move → `settlement`), reuse that shape. Only if
  it genuinely cannot be expressed in any existing shape do you add a new family (see "Adding a new
  family" below) — that is the rare case.
- **`chains`** — the chain id(s) the venue is live on (`16602` Galileo testnet · `16661` Aristotle
  mainnet). Exact integers, no float. A mainnet-only venue lists only `16661` and is **operator-gated**.
- **`priority`** — the gateway's tie-break when two adapters quote an equal `expectedOut` (lower wins). A
  preference, not a trust signal.
- **`gates`** — the named `[[check]]` gates (at the bottom of the spine) that MUST pass before this
  connector is trusted. **At least one is required** — a connector that names **no** gates is **rejected
  by the manifest parser**, because an adapter that gates itself on nothing could "vote itself in". This is
  the structural form of *loud-unverified over silent-green*.

The manifest is parsed by `ConnectorManifest::parse` into a typed `ConnectorManifest` (a `ConnectorEntry`
per block, in declaration order). A malformed block — an unknown `shape`, a missing required field, a float
chain id, an empty `gates` array — is a **loud** `ManifestError`, never a half-read entry.

---

## Step 3 — The verifier confirms the settlement (one entry, no new enum)

After a leg settles, the **independent verifier reads the chain itself** (raw JSON-RPC — never the
front-end / the aggregator / the bridge API) and mints a verdict. ProofAgent has **one** door for this,
shared by every protocol:

```rust
verify_connector_settlement(&claim, &observation, tolerance) -> Result<Verdict, ConnectorMismatch>
```

- **`claim`** is a `ConnectorClaim` — the protocol-tagged **Claim** (the agent's word): the claimed amount
  (`settlement`), a `SwapClaim` (`swap`), a `RouteClaim` (`route`), or a `HopClaim` (`bridge`).
- **`observation`** is a `ConnectorObservation` — the verifier's own protocol-tagged **on-chain read**: a
  read amount / a decoded `Swap`-event output / a rail terminal + delivered amount / both bridge legs. An
  unreadable read is `None` **inside** the variant — the loud absence that degrades to `unverified`.
- The entry **dispatches** on the connector family to the matching per-protocol algebra
  (`adjudicate` / `adjudicate_swap` / `adjudicate_route_leg` / `adjudicate_hop`) and mints **one of the
  same four verdicts**. **There is no new verdict enum**, and the per-protocol decode is unchanged — the
  unified entry only *composes* the proven extensions behind one interface.

Two structural safeguards keep this honest:

- A **cross-family** pair (a `swap` claim against a `bridge` observation) is a loud `ConnectorMismatch`,
  **never** a fabricated `settled` — the Claim and the Observation must describe the same action to be
  adjudicated (the type-level twin of two-source truth).
- An **unreadable** observation for **any** protocol is `unverified` — the verifier never invents a read,
  so an absent read can never collapse into a fabricated success (the NEG case, carried into the unified
  entry).

**If your protocol fits an existing `shape`**, you write **no new verifier code** — declare `shape =
"swap"` (or `route`/`bridge`/`settlement`) and the unified entry already adjudicates it. You only supply,
in the spine's per-family corpus, a real already-settled transaction (its claim + the recorded on-chain
read) so the **offline** build replays a genuine settlement deterministically; the `live` build ignores the
recording and reads the chain itself.

### Adding a NEW settlement family (the rare case)

Only if your protocol's settlement genuinely cannot be expressed in any existing observation shape:

1. Add the per-protocol module (e.g. `verifier/src/myfamily.rs`) with its own `Claim` / `Observation`
   shape, an `adjudicate_myfamily(claim, observed, tol) -> Verdict` that mints through the **existing**
   `Verdict` monopoly (call `adjudicate` for the band check; reuse the crate-private constructors via the
   per-family rules — **do not** add a verdict variant), an offline `Tape` source, and a feature-gated
   `LiveMyFamilySource`.
2. Add a `ConnectorKind::MyFamily` variant + its canonical string, a `ConnectorClaim::MyFamily` /
   `ConnectorObservation::MyFamily` arm, and the dispatch arm in `verify_connector_settlement`. The match
   has no wildcard, so the compiler forces you to wire every arm.
3. Add the family to this recipe's `shape` list and the manifest comment in `proofagent.toml`.

The four invariants above apply unchanged. The key rule: a new family **reuses the four-verdict alphabet** —
it never widens it.

---

## Step 4 — The gate (the adapter cannot vote itself in)

Before the adapter is trusted, the **whole gate must pass — run-fix-run, never commit red.** The adapter is
trusted only when these are GREEN together:

| Gate | Command | What it proves |
|---|---|---|
| **verifier — build** | `cargo build` | the unified entry + any new family compiles (offline default) |
| **verifier — tests** | `cargo test` | every verdict test still green; the new adapter's settlement adjudicates correctly through the unified entry; the manifest block parses |
| **verifier — lint (zero-warning)** | `cargo clippy --all-targets -- -D warnings` | no warnings |
| **contracts — build/test** | `forge build` · `forge test` | any on-chain gate (the mandate) still holds |
| **agent — typecheck/tests** | `tsc --noEmit` · the agent test runner | the `ExecutionConnector` typechecks; the adapter + gateway tests pass |
| **web — typecheck/tests** | `tsc --noEmit` · the web test runner | the UI still typechecks |
| **clean-room firewall** | the out-of-tree clean-room scanner | zero proprietary identifier / private path / secret in any publishable file |
| **money-critical boot check** | the manifest parse + the settlement-entry dispatch | the connector declares ≥1 gate (it cannot vote itself in); its `shape` maps to a dispatchable family; the unified entry routes it |

The **money-critical boot check** is the load-bearing one for a new adapter: the manifest parser **refuses**
a connector that names no gates, and the unified settlement entry refuses a cross-family pair — so a new
adapter is structurally incapable of being trusted without a gate, and an unproven leg surfaces
**loud-UNVERIFIED**, never silent-green. The reproducible verdict digest (the ordered verdict log) lets
anyone re-run the gate and get a byte-identical result.

Only after the **whole** gate is GREEN does the adapter land.

---

## Checklist

- [ ] `agent/src/adapters/<proto>_adapter.ts` implements all five `ExecutionConnector` methods (pure
      `quote`/`build`, value-only `submit` failing closed, honest `status`/`cancel`).
- [ ] Adapter tests added (quotable + not-quotable, pure build, not-wired `submit`, `status.valueMoved`).
- [ ] `[[connector]]` block added to `proofagent.toml` (`name`, `shape`, `chains`, `priority`, **≥1 gate**),
      using public facts only.
- [ ] If a new family: the per-protocol module + the `ConnectorKind`/`ConnectorClaim`/`ConnectorObservation`
      arms + the dispatch arm — reusing the four-verdict alphabet, never widening it.
- [ ] A real already-settled tx pinned in the family's corpus (claim + recorded read) for the offline
      replay — or honestly left empty (→ `unverified`), **never** a fabricated `settled`.
- [ ] **The full gate is GREEN** (build · lint · typecheck · tests · clean-room firewall · the
      money-critical boot check), run-fix-run, nothing red.
