//! The BRIDGE verifier extension -- mint a per-hop settlement verdict for a CCIP bridge transfer.
//!
//! Design SS2 (the Settlement proof): "an independent Rust verifier reads 0G via raw JSON-RPC and stamps
//! each trade settled / hollow / mismatch / unverified -- it never trusts the UI." Design WOW Feature 3 /
//! 3b (Bridge -- Chainlink CCIP) "wrapped by the proofs": "After each hop the verifier reads **both** legs
//! (source `ccipSend`/lock + destination ... mint) ... and stamps a verdict **per hop**. Multi-hop is the
//! kill-shot: ... a **hollow hop** is surfaced LOUD ... never silently counted as a completed bridge."
//!
//! ## Why a bridge needs its OWN observation shape -- two legs per hop
//!
//! The MVP settlement leg ([`crate::verify_tx`]) reads ONE transaction's native value moved. The SWAP
//! ([`crate::swap`]) and ROUTE ([`crate::route`]) extensions read ONE settle event on ONE chain. A bridge
//! hop is fundamentally different: value **leaves one chain and must arrive on another**. A naive
//! integration reads only the SOURCE leg -- the `ccipSend` / burn -- sees it confirmed, and reports
//! "done". But CCIP delivery is **asynchronous and not always automatic**: when the destination
//! `releaseOrMint` fails (out of gas budget, a reverting receiver, or a drained rate-limit bucket), the
//! message sits **Ready-for-manual-execution / FAILURE** with **zero tokens released** -- while the source
//! tx is confirmed and the UI shows "done". This is the **HOLLOW-EGRESS** trap, and it is the centerpiece
//! of this module: a bridge hop is `settled` ONLY when BOTH legs are independently read AND the released
//! amount is in tolerance. A burned-source/empty-destination hop is `hollow`, surfaced LOUD (design WOW
//! Feature 3b), NEVER a fabricated `settled`.
//!
//! ## Two-source truth at the bridge boundary (design SS3 principle 1)
//!
//! Exactly as the value verifier never trusts the UI for "did it settle", this never trusts the bridge
//! front-end / CCIP-explorer API for "did the hop arrive". The agent's [`HopClaim`] is the **Claim** (the
//! amount it sent on the source + the on-chain `min_release` floor it bound the egress with); the
//! verifier's own read of BOTH legs -- the source burn/lock event AND the destination release/mint event
//! -- is the **Observation** ([`HopObservation`]). They meet only in [`adjudicate_hop`]. A
//! [`HopObservation`] is only ever built from an INDEPENDENT read of each leg's on-chain receipt, never
//! from a bridge REST status alone.
//!
//! ## The verdict alphabet, reused (design SS2 + SS3 principle 2, the verdict monopoly)
//!
//! A bridge hop mints one of the SAME four [`crate::Verdict`]s -- there is no new verdict enum, so the
//! bridge leg cannot widen the alphabet or escape the monopoly:
//!
//! - **`settled`**  -- BOTH legs read: the source burned/locked the amount, AND the destination released
//!   at/above the on-chain `min_release` floor AND within the exact-integer tolerance band of the amount
//!   sent. The value provably left the source AND arrived on the destination.
//! - **`hollow`**   -- the **HOLLOW-EGRESS catch** (the centerpiece): the source burned/locked, but the
//!   destination released NOTHING (`0`) or the destination leg is on-record as a FAILURE/empty. The value
//!   left the source and DID NOT arrive -- stuck in-flight (manual-exec pending) or lost. On-record but no
//!   economic effect at the destination. **LOUD**, NEVER a fabricated settle.
//! - **`mismatch`** -- both legs read, the destination released a NONZERO amount, but it is BELOW the
//!   on-chain `min_release` floor OR outside the tolerance band of the amount sent (a short release / a
//!   wrong-asset arrival / fee-skim beyond tolerance). A loud "the destination disagrees with the source".
//! - **`unverified`** -- a leg could not be read (the source receipt is unknown/unmined, or the
//!   destination leg has no recorded read yet -- the hop is genuinely still in-flight and unreadable). The
//!   loud, honest degrade target (design SS3 principle 3) -- never a fabricated `settled`.
//!
//! ## The hollow-egress vs unverified distinction (design SS3 principle 3, never fabricate)
//!
//! The two are different code paths that can never be confused. **Hollow-egress** = "we READ the
//! destination leg and it released nothing / failed" -- a real, loud defect with a prescribed heal
//! (manually execute the pending CCIP message at the OffRamp). **Unverified** = "we could not READ the
//! destination leg at all" -- the hop is still in-flight and unreadable. A hop whose source is confirmed
//! but whose destination is *unreadable* is `unverified` (still arriving), not `hollow` -- we never call a
//! still-in-flight hop a defect, and we never call a read-empty destination a success.
//!
//! ## A multi-hop journey is settled ONLY if EVERY hop is independently settled (design WOW Feature 3b)
//!
//! "A multi-hop journey is **settled only if every hop is independently settled** -- hop-1 on Ethereum
//! says nothing about hop-2 to Base." [`verify_bridge`] composes the hops: `settled` IFF every hop
//! settled, else the FIRST non-settled hop's verdict (the loud first failure). An empty journey is
//! `unverified`, never a vacuous `settled`.
//!
//! ## Determinism + exact-integer (design SS3 principles 4 + 5)
//!
//! [`adjudicate_hop`] is pure over `(claim, observation)` -- no wall-clock, no global state. Every amount
//! (`sent`, `released`, the `min_release` floor, the tolerance band) is an exact `i128` in the bridged
//! token's MINOR units; there is no float anywhere on this money path. The destination chain selector is
//! carried as an exact `u64` (the CCIP selector) -- never a float.
//!
//! ## Offline-buildable, feature-gated live read (design SS6)
//!
//! The default build adjudicates a hop against a deterministic, std-only [`BridgeTape`] (a recorded
//! two-leg read), so it needs no network. The `live` feature adds [`LiveBridgeSource`] -- a real
//! `eth_getTransactionReceipt` reader that confirms the source burn/lock event on the source chain AND
//! the destination release/mint event on the destination chain, feeding the SAME algebra, the same
//! raw-JSON-RPC shape the settlement [`crate::LiveSource`] uses. CCIP on 0G is **MAINNET-only** (Galileo
//! CCIP is decommissioned) -> the live bridge read is OPERATOR-GATED; the offline tape proves the algebra
//! at $0.

use crate::{adjudicate, Ratio, ReadKey, Verdict};
use core::fmt;
use std::collections::BTreeMap;

/// A CCIP destination-chain selector (design WOW Feature 3 / 3b). The exact `u64` the source `ccipSend`
/// pins as `destChainSelector` -- a public protocol fact (the chain-selectors registry), carried so a hop
/// records WHICH lane it rode. Pinned as exact integers (never a float) -- design SS3 principle 5.
///
/// These are the public 0G CCIP lane selectors from design WOW Feature 3b (the `chain-selectors` registry).
/// The verdict algebra is selector-independent -- the selector is for the audit trail + the mandate's
/// expected-destination pin (the agent gate asserts the EXPECTED selector before any burn).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
#[non_exhaustive]
pub enum DestSelector {
    /// Ethereum mainnet CCIP selector `5009297550715157269` (the USDC.E egress + the IN-lane source).
    Ethereum,
    /// 0G Aristotle mainnet CCIP selector `4426351306075016396` (the bridge-IN destination).
    ZeroG,
    /// Arbitrum One CCIP selector `4949039107694359620` (a w0G direct egress lane).
    Arbitrum,
    /// Base CCIP selector `15971525489660198786` (a w0G direct egress lane).
    Base,
    /// BNB CCIP selector `11344663589394136015` (a w0G direct egress lane).
    Bnb,
}

impl DestSelector {
    /// The exact `u64` CCIP chain selector value (a public protocol fact; design WOW Feature 3 / 3b).
    #[must_use]
    pub const fn value(&self) -> u64 {
        match self {
            DestSelector::Ethereum => 5_009_297_550_715_157_269,
            DestSelector::ZeroG => 4_426_351_306_075_016_396,
            DestSelector::Arbitrum => 4_949_039_107_694_359_620,
            DestSelector::Base => 15_971_525_489_660_198_786,
            DestSelector::Bnb => 11_344_663_589_394_136_015,
        }
    }

    /// A stable, human-readable label for the confirmation row (deterministic; design SS3 principle 4).
    #[must_use]
    pub const fn label(&self) -> &'static str {
        match self {
            DestSelector::Ethereum => "ethereum:5009297550715157269",
            DestSelector::ZeroG => "0g:4426351306075016396",
            DestSelector::Arbitrum => "arbitrum:4949039107694359620",
            DestSelector::Base => "base:15971525489660198786",
            DestSelector::Bnb => "bnb:11344663589394136015",
        }
    }
}

impl fmt::Display for DestSelector {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.label())
    }
}

/// Which bridged-asset lane a hop rode (design WOW Feature 3 / 3b; the hub-and-spoke section). A label for
/// the confirmation row, never part of the verdict algebra (the algebra is identical for every lane).
///
/// The lanes differ only in HOW value crosses (lock-and-mint USDC->USDC.E or w0G CCT lock->mint on the way
/// IN to the 0G hub; USDC.E burn->USDC release or w0G lock->mint on the way OUT to a spoke); the verifier
/// reads BOTH legs the same way for all of them.
///
/// ## Hub-and-spoke directionality (the hub-and-spoke section of the design)
///
/// 0G is the SECURED HUB; the other chains are SPOKES. **Inbound** lanes carry value FROM a spoke INTO the
/// hub (the autonomous direction -- value enters the chain we already watch + secure); **egress** lanes
/// carry value OUT of the hub TO a spoke (the risky direction -- value depends on a remote chain we do not
/// control, and is the hollow-egress-prone leg + the value-tiered outbound time-lock's domain). The
/// inbound lanes from Arbitrum + BNB are w0G CCT direct lanes (lock w0G on the spoke -> mint w0G on the 0G
/// hub); the Ethereum inbound lane is the USDC lock-and-mint lane.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
#[non_exhaustive]
pub enum BridgeLane {
    /// Bridge-IN (spoke -> hub): Ethereum -> 0G, native USDC locked -> USDC.E minted on 0G (1:1 lock-and-mint).
    UsdcInbound,
    /// Bridge-IN (spoke -> hub): Arbitrum -> 0G, w0G locked on Arbitrum -> w0G minted on the 0G hub (CCT direct).
    W0gInboundArbitrum,
    /// Bridge-IN (spoke -> hub): BNB -> 0G, w0G locked on BNB -> w0G minted on the 0G hub (CCT direct).
    W0gInboundBnb,
    /// Bridge-OUT (hub -> spoke): 0G -> Ethereum, USDC.E burned -> native USDC released on Ethereum (CCTP).
    UsdcEgress,
    /// Bridge-OUT (hub -> spoke): 0G -> {Eth/Arb/Base/BNB}, w0G locked on 0G -> w0G minted on the spoke (CCT direct).
    W0gEgress,
}

impl BridgeLane {
    /// The canonical, stable, snake_case string for the journal/UI (deterministic).
    #[must_use]
    pub const fn canonical_string(&self) -> &'static str {
        match self {
            BridgeLane::UsdcInbound => "usdc-inbound",
            BridgeLane::W0gInboundArbitrum => "w0g-inbound-arbitrum",
            BridgeLane::W0gInboundBnb => "w0g-inbound-bnb",
            BridgeLane::UsdcEgress => "usdc-egress",
            BridgeLane::W0gEgress => "w0g-egress",
        }
    }

    /// `true` iff this lane is an EGRESS lane (value leaving the 0G hub TO a spoke) -- the hollow-egress-prone
    /// direction (design WOW Feature 3b: egress burns on 0G and depends on a remote chain we don't control,
    /// and is the value-tiered outbound time-lock's domain). The inbound lanes mint INTO the hub we already
    /// watch + secure; the egress lanes are where value gets stuck.
    #[must_use]
    pub const fn is_egress(&self) -> bool {
        matches!(self, BridgeLane::UsdcEgress | BridgeLane::W0gEgress)
    }

    /// `true` iff this lane is an INBOUND lane (value entering the 0G hub FROM a spoke) -- the AUTONOMOUS
    /// direction (the hub-and-spoke section: bridge-IN into the secured hub is autonomous). The exact
    /// complement of [`Self::is_egress`]: every lane is either inbound (into the hub) or egress (out of it).
    #[must_use]
    pub const fn is_inbound(&self) -> bool {
        matches!(
            self,
            BridgeLane::UsdcInbound | BridgeLane::W0gInboundArbitrum | BridgeLane::W0gInboundBnb
        )
    }

    /// The SPOKE chain selector this lane connects to the 0G hub (the non-hub end of the lane). For an
    /// inbound lane it is the SOURCE spoke; for an egress lane the hub-and-spoke model has many possible
    /// destinations, so an egress lane returns `None` (its spoke is the hop's pinned `dest_selector`, not a
    /// lane-fixed value). Used by the per-spoke isolated-cap audit trail (the hub-and-spoke section).
    #[must_use]
    pub const fn spoke_selector(&self) -> Option<DestSelector> {
        match self {
            BridgeLane::UsdcInbound => Some(DestSelector::Ethereum),
            BridgeLane::W0gInboundArbitrum => Some(DestSelector::Arbitrum),
            BridgeLane::W0gInboundBnb => Some(DestSelector::Bnb),
            // An egress lane's spoke is the hop's pinned destination selector, not fixed by the lane.
            BridgeLane::UsdcEgress | BridgeLane::W0gEgress => None,
        }
    }
}

impl fmt::Display for BridgeLane {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.canonical_string())
    }
}

/// The source leg of a hop -- INDEPENDENTLY observed from the SOURCE chain (the `ccipSend` / burn / lock
/// event). The verifier's own read, never the bridge UI.
///
/// `burned` is the amount the source provably removed from circulation on the source chain (burned for the
/// USDC.E egress / locked for w0G / locked for the inbound lane), in the bridged token's MINOR units
/// (exact-integer, design SS3 principle 5). A `burned` of `0` under a present source leg means "the source
/// tx is on-record but moved nothing" (a hollow source) -- distinct from the *absence* of a source read,
/// which is modelled one level up as `None`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct SourceLeg {
    /// The amount burned/locked on the source chain, MINOR units (exact-integer). `0` == on-record, moved
    /// nothing.
    burned: i128,
}

impl SourceLeg {
    /// Record an independently-observed source-leg burn/lock of `burned` minor units.
    #[must_use]
    pub const fn new(burned: i128) -> SourceLeg {
        SourceLeg { burned }
    }

    /// The amount burned/locked on the source chain, in minor units.
    #[must_use]
    pub const fn burned(&self) -> i128 {
        self.burned
    }
}

/// The destination leg of a hop -- INDEPENDENTLY observed from the DESTINATION chain (the OffRamp
/// `releaseOrMint` / mint event). The verifier's own read of the OTHER chain, never the CCIP-explorer API.
///
/// `released` is the amount the destination provably delivered to the receiver, in the bridged token's
/// MINOR units (exact-integer). A `released` of `0` is the **HOLLOW-EGRESS** input: the destination leg is
/// on-record (we READ it) but delivered NOTHING (auto-exec failed / manual-exec pending / the message is
/// Ready-for-manual-execution-FAILURE). This is distinct from the *absence* of a destination read (the hop
/// genuinely still in-flight, unreadable), which is modelled one level up as `None` -> `Unverified`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct DestLeg {
    /// The amount released/minted on the destination chain, MINOR units (exact-integer). `0` == on-record
    /// (read), delivered nothing (the HOLLOW-EGRESS input).
    released: i128,
}

impl DestLeg {
    /// Record an independently-observed destination-leg release/mint of `released` minor units.
    #[must_use]
    pub const fn new(released: i128) -> DestLeg {
        DestLeg { released }
    }

    /// An on-record destination leg that released NOTHING -- the HOLLOW-EGRESS input (read, but empty).
    #[must_use]
    pub const fn empty() -> DestLeg {
        DestLeg { released: 0 }
    }

    /// The amount released/minted on the destination chain, in minor units.
    #[must_use]
    pub const fn released(&self) -> i128 {
        self.released
    }
}

/// The independently-observed outcome of ONE bridge hop -- the **Observation** (design SS3 principle 1).
///
/// This is the verifier's own read of BOTH legs: the source burn/lock confirmed on the source chain, AND
/// the destination release/mint confirmed on the destination chain. The destination leg is `Option`: a
/// `None` destination means the destination leg could NOT be read (the hop is still in-flight / unreadable
/// -> `Unverified`), distinct from a present-but-empty [`DestLeg`] (read, released nothing -> the
/// HOLLOW-EGRESS catch). The two-leg shape is what makes the hollow-egress trap catchable: a source-only
/// read can never settle a hop.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct HopObservation {
    /// The source burn/lock leg, INDEPENDENTLY read from the source chain.
    source: SourceLeg,
    /// The destination release/mint leg, INDEPENDENTLY read from the destination chain, or `None` when
    /// the destination leg could not be read (the hop is still in-flight -> `Unverified`).
    dest: Option<DestLeg>,
}

impl HopObservation {
    /// Record a hop observation from BOTH legs: the source burn + the destination release (or `None` when
    /// the destination leg is unreadable -- the hop is still in-flight).
    #[must_use]
    pub const fn new(source: SourceLeg, dest: Option<DestLeg>) -> HopObservation {
        HopObservation { source, dest }
    }

    /// A hop where the source burned `burned` and the destination released `released` (both legs read).
    #[must_use]
    pub const fn bridged(burned: i128, released: i128) -> HopObservation {
        HopObservation { source: SourceLeg::new(burned), dest: Some(DestLeg::new(released)) }
    }

    /// The HOLLOW-EGRESS hop: the source burned `burned`, but the destination leg was READ and released
    /// NOTHING (auto-exec failed / manual-exec pending). The centerpiece input (design WOW Feature 3b).
    #[must_use]
    pub const fn hollow_egress(burned: i128) -> HopObservation {
        HopObservation { source: SourceLeg::new(burned), dest: Some(DestLeg::empty()) }
    }

    /// A still-in-flight hop: the source burned `burned`, but the destination leg could NOT be read yet
    /// (`None` -> `Unverified`). Distinct from hollow-egress (read-but-empty).
    #[must_use]
    pub const fn in_flight(burned: i128) -> HopObservation {
        HopObservation { source: SourceLeg::new(burned), dest: None }
    }

    /// The independently-read source burn/lock leg.
    #[must_use]
    pub const fn source(&self) -> SourceLeg {
        self.source
    }

    /// The independently-read destination release/mint leg, or `None` if the destination is unreadable.
    #[must_use]
    pub const fn dest(&self) -> Option<DestLeg> {
        self.dest
    }
}

/// The agent's recorded claim about ONE bridge hop -- the **Claim** half of two-source truth (design SS3
/// principle 1). Never trusted on its own; adjudicated against the verifier's own two-leg read.
///
/// All amounts are exact `i128` minor units of the bridged token (design SS3 principle 5):
///
/// - `lane` -- which bridged-asset lane the hop rode (audit-trail label; the verdict algebra is
///   lane-independent).
/// - `dest_selector` -- the EXPECTED CCIP destination selector the agent pinned in `ccipSend` (the lane
///   the mandate bounds the egress to). Carried for the audit trail; the verdict algebra is
///   selector-independent (the mandate gate, not the verdict, asserts the expected destination pre-send).
/// - `sent` -- the amount the agent sent on the source (the amount it expects to arrive, 1:1). The
///   destination release is adjudicated against this with the exact-integer tolerance band.
/// - `min_release` -- the ON-CHAIN minimum-release floor the agent bound the egress with (the lane's
///   tolerance, e.g. CCIP fee-skim allowance). A *settled* hop must have `released >= min_release`; a
///   release below the floor is a loud `mismatch`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct HopClaim {
    /// Which bridged-asset lane this hop rode (audit-trail label).
    lane: BridgeLane,
    /// The EXPECTED CCIP destination selector the agent pinned (audit-trail label).
    dest_selector: DestSelector,
    /// The amount sent on the source (minor units) -- the destination release is adjudicated against this.
    sent: i128,
    /// The on-chain minimum-release floor the agent bound the egress with (minor units). A settled hop's
    /// destination release must be at or above this.
    min_release: i128,
}

impl HopClaim {
    /// Build a hop claim from the lane, the expected destination selector, the `sent` amount, and the
    /// on-chain `min_release` floor.
    #[must_use]
    pub const fn new(
        lane: BridgeLane,
        dest_selector: DestSelector,
        sent: i128,
        min_release: i128,
    ) -> HopClaim {
        HopClaim { lane, dest_selector, sent, min_release }
    }

    /// The lane this hop rode.
    #[must_use]
    pub const fn lane(&self) -> BridgeLane {
        self.lane
    }

    /// The expected CCIP destination selector the agent pinned.
    #[must_use]
    pub const fn dest_selector(&self) -> DestSelector {
        self.dest_selector
    }

    /// The amount sent on the source (minor units) -- the claim the destination release is adjudicated
    /// against.
    #[must_use]
    pub const fn sent(&self) -> i128 {
        self.sent
    }

    /// The on-chain minimum-release floor (minor units) -- a settled hop's release must be at or above it.
    #[must_use]
    pub const fn min_release(&self) -> i128 {
        self.min_release
    }
}

/// The result of verifying ONE bridge hop: the claim, the independent two-leg observation (or `None`s if
/// unreadable), and the minted [`Verdict`].
///
/// This is the bridge analogue of [`crate::route::RouteReport`]: it carries enough to *reproduce and
/// audit* the verdict -- the lane, the expected destination selector, the claimed `sent`, the on-chain
/// floor, the observed source burn and destination release (or `None` -- the loud absence), and the
/// verdict the verifier minted -- and nothing else.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HopReport {
    /// The canonical `0x`-lowercase SOURCE transaction hash this hop report is about (the `ccipSend` tx).
    pub source_hash: String,
    /// The canonical `0x`-lowercase DESTINATION transaction hash, or `None` when the destination leg is
    /// not yet readable (the hop is still in-flight).
    pub dest_hash: Option<String>,
    /// Which bridged-asset lane the hop rode.
    pub lane: BridgeLane,
    /// The expected CCIP destination selector the agent pinned.
    pub dest_selector: DestSelector,
    /// The amount sent on the source (minor units) -- the agent's claim.
    pub sent: i128,
    /// The on-chain minimum-release floor the agent bound the egress with (minor units).
    pub min_release: i128,
    /// The independently-read source burn/lock (minor units), or `None` when the source could not be read.
    pub burned: Option<i128>,
    /// The independently-read destination release/mint (minor units), or `None` when the destination leg
    /// could not be read (the loud absence that adjudicates to [`Verdict::Unverified`] -- still in-flight).
    pub released: Option<i128>,
    /// The minted verdict -- the only place a bridge verdict is created (the [`Verdict`] monopoly).
    pub verdict: Verdict,
}

impl HopReport {
    /// The canonical verdict string (design SS2 alphabet): `settled / hollow / mismatch / unverified`.
    #[must_use]
    pub fn verdict_string(&self) -> &'static str {
        self.verdict.canonical_string()
    }

    /// `true` iff this hop is the HOLLOW-EGRESS defect: a present source burn but a destination leg that
    /// was READ and released nothing (the centerpiece, design WOW Feature 3b). Distinct from `unverified`
    /// (destination unreadable / still in-flight). Used by the loud audit surface to prescribe the heal
    /// (manually execute the pending CCIP message at the OffRamp).
    #[must_use]
    pub fn is_hollow_egress(&self) -> bool {
        matches!(self.verdict, Verdict::Hollow)
            && matches!(self.burned, Some(b) if b > 0)
            && self.released == Some(0)
    }
}

/// Adjudicate ONE bridge hop: do BOTH independently-read legs confirm the hop -- the source burned the
/// amount AND the destination released it at/above the floor, within the exact-integer tolerance band?
///
/// The bridge-settlement algebra (design SS3 principle 1, two-source truth; principle 5, exact-integer
/// money; design WOW Feature 3 / 3b, the HOLLOW-EGRESS catch), evaluated strictly in order:
///
/// 1. `observed == None`                          -> [`Verdict::Unverified`]  (the keystone -- never
///    fabricate; an unreadable hop can never become a fabricated `settled`).
/// 2. source `burned == 0`                        -> [`Verdict::Hollow`]      (the source is on-record but
///    moved nothing -- a hollow source; no value ever left, so nothing could arrive).
/// 3. destination leg is `None` (UNREADABLE)      -> [`Verdict::Unverified`]  (the hop is still in-flight;
///    the source burned but the destination leg cannot be read yet -- loud, never a fabricated settle, and
///    crucially NOT a hollow-egress defect, because we have not READ the destination as empty).
/// 4. destination `released == 0` (READ, EMPTY)   -> [`Verdict::Hollow`]      (the **HOLLOW-EGRESS** catch
///    -- the centerpiece: source burned, destination read + delivered NOTHING. Value left, did not arrive.
///    LOUD; heal = manually execute the pending CCIP message at the OffRamp).
/// 5. destination `released < min_release`        -> [`Verdict::Mismatch`]    (a short release -- below the
///    on-chain floor the agent set; the lane's own bound was violated. Checked BEFORE the band).
/// 6. `|released - sent| <= band`                 -> [`Verdict::Settled`]     (within tolerance of the
///    amount sent -- the value provably left the source AND arrived on the destination).
/// 7. else                                        -> [`Verdict::Mismatch`]    (above the floor but outside
///    the tolerance band of the amount sent -- a wrong-asset arrival / fee-skim beyond tolerance).
///
/// The verdict is minted HERE -- through [`crate::adjudicate`] for the band check (steps 6/7) and the
/// same crate-private [`Verdict`] constructors elsewhere -- so the [`Verdict`] monopoly (design SS3
/// principle 2) is preserved: no caller outside the crate can construct a bridge verdict, only obtain one.
///
/// Note the layered safety: a hollow source is caught at step (2) before any destination math; a still-
/// in-flight hop (destination unreadable) is `unverified` at step (3) BEFORE the hollow-egress check, so a
/// hop that is merely still-arriving is NEVER mislabelled a hollow-egress defect; and the read-but-empty
/// destination is the loud hollow-egress at step (4) BEFORE any amount comparison, so a stuck egress can
/// never settle even if a stray `released` were near `sent`.
#[must_use]
pub fn adjudicate_hop(claim: &HopClaim, observed: Option<HopObservation>, tol: Ratio) -> Verdict {
    // (1) Keystone (design SS3 principle 3): no read at all -> Unverified, never a fabricated Settled.
    let Some(obs) = observed else {
        return Verdict::unverified();
    };

    // (2) A hollow SOURCE: the source tx is on-record but burned/locked nothing -> Hollow. No value left
    // the source, so nothing could arrive; caught before any destination math.
    if obs.source().burned() == 0 {
        return Verdict::hollow();
    }

    // (3) The destination leg is UNREADABLE (still in-flight) -> Unverified. The source burned, but we
    // cannot READ the destination yet -- the hop is genuinely still arriving. This is a loud honest
    // absence (never a fabricated settle), and it is checked BEFORE the hollow-egress catch so a still-
    // in-flight hop is NEVER mislabelled a defect.
    let Some(dest) = obs.dest() else {
        return Verdict::unverified();
    };

    let released = dest.released();

    // (4) The HOLLOW-EGRESS catch (the centerpiece, design WOW Feature 3b): the source burned, the
    // destination leg was READ, and it released NOTHING -> Hollow. Value left the source and did NOT
    // arrive (auto-exec failed / manual-exec pending). Checked BEFORE any amount comparison so a stuck
    // egress can NEVER settle. This is distinct from (3) "unreadable": here we DID read the destination
    // and it is empty.
    if released == 0 {
        return Verdict::hollow();
    }

    // (5) A short release below the on-chain min-release floor the agent set -> Mismatch. The lane's own
    // bound was violated; checked BEFORE the softer band so a below-floor release can never settle.
    if released < claim.min_release() {
        return Verdict::mismatch();
    }

    // (6) + (7) Band check against the amount SENT -- the exact-integer settlement algebra, reused verbatim
    // (design SS3 principle 1 + 5). Within band -> Settled (value left AND arrived); outside -> Mismatch.
    // The verdict is minted by `adjudicate` (the value leg's algebra), preserving the verdict monopoly.
    adjudicate(claim.sent(), Some(released), tol)
}

// =================================================================================================
// The bridge read seam -- the independent two-leg Observation source (mirrors the settlement `Source`).
// =================================================================================================

/// The independent bridge-read seam -- the **Observation** source for a bridge hop (design SS3 principle
/// 1).
///
/// `read_hop` returns `Some(observation)` when the SOURCE leg answered (the source burn/lock event was
/// found + decoded), pairing it with the destination leg (present when the destination release was read,
/// `None` when the destination is still unreadable). It returns `None` only when the SOURCE leg itself
/// could not be read (off-tape / unreadable source) -- never a fabricated observation (design SS3
/// principle 3). A taped replay and a live two-chain `eth_getTransactionReceipt` reader both satisfy it,
/// so swapping one for the other never changes what a bridge verdict MEANS.
///
/// `read_hop` takes `&mut self` so a live implementation may hold and mutate connections; [`BridgeTape`]
/// does not need the mutability but honors the same signature so the two are drop-in interchangeable.
pub trait BridgeSource {
    /// Read the independently-confirmed two-leg outcome of the hop whose SOURCE tx is `source_key` and
    /// (when known) whose DESTINATION tx is `dest_key`. `None` is the loud honest absence of the SOURCE
    /// leg (design SS3 principle 3); a present observation with a `None` destination leg is a still-
    /// in-flight hop (the destination is unreadable).
    fn read_hop(&mut self, source_key: &ReadKey, dest_key: Option<&ReadKey>) -> Option<HopObservation>;
}

/// A deterministic, std-only replay of recorded two-leg bridge reads -- the default (offline) source.
///
/// Design SS3 principle 4 + SS6 (offline-by-default): an ordered [`BTreeMap`] from the SOURCE [`ReadKey`]
/// to a recorded [`HopObservation`] (which itself carries both legs). A keyed read replays its exact
/// recording; an unrecorded source key is `None` (we have no recording, so we refuse to invent one --
/// design SS3 principle 3). Because the map is ordered and the lookup is pure, the same tape always
/// answers a given source key identically, with no network and no wall-clock -- the tape IS the recorded
/// two-chain truth, frozen.
#[derive(Debug, Clone, Default)]
pub struct BridgeTape {
    tape: BTreeMap<ReadKey, HopObservation>,
}

impl BridgeTape {
    /// An empty tape -- every bridge read is `None` (unverified).
    #[must_use]
    pub fn new() -> BridgeTape {
        BridgeTape { tape: BTreeMap::new() }
    }

    /// Record a hop observation keyed by the SOURCE tx hash, returning the tape for chaining. Re-recording
    /// a source key overwrites it (the tape is the single source of recorded truth for that hop).
    #[must_use]
    pub fn with(mut self, source_key: ReadKey, obs: HopObservation) -> BridgeTape {
        self.tape.insert(source_key, obs);
        self
    }

    /// Record a hop observation keyed by the SOURCE tx hash, in place.
    pub fn record(&mut self, source_key: ReadKey, obs: HopObservation) {
        self.tape.insert(source_key, obs);
    }

    /// How many hop reads are recorded on this tape.
    #[must_use]
    pub fn len(&self) -> usize {
        self.tape.len()
    }

    /// `true` iff the tape has no recorded hop reads.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.tape.is_empty()
    }
}

impl BridgeSource for BridgeTape {
    fn read_hop(&mut self, source_key: &ReadKey, _dest_key: Option<&ReadKey>) -> Option<HopObservation> {
        // The tape is keyed by the SOURCE tx; the recorded observation already carries both legs (the
        // destination leg is baked into the recording -- present, empty, or absent). The dest key is part
        // of the live read's two-chain lookup, but for the deterministic tape it is implied by the source
        // recording, so it is not consulted here.
        self.tape.get(source_key).copied()
    }
}

/// Verify ONE bridge hop end-to-end: read BOTH legs from `source`, adjudicate vs the claim.
///
/// This is the bridge analogue of [`crate::verify_tx`] / [`crate::route::verify_route_leg`]: the agent's
/// [`HopClaim`] is the Claim, the chain-confirmed source burn + destination release is the Observation,
/// and [`adjudicate_hop`] mints the verdict. An unreadable source degrades to [`Verdict::Unverified`]; a
/// read-but-empty destination is the loud HOLLOW-EGRESS [`Verdict::Hollow`] -- never a fabricated `settled`
/// (design SS3 principle 3). It returns a [`HopReport`] carrying the inputs that produced the verdict.
#[must_use]
pub fn verify_hop(
    source_key: &ReadKey,
    dest_key: Option<&ReadKey>,
    claim: &HopClaim,
    tol: Ratio,
    source: &mut dyn BridgeSource,
) -> HopReport {
    let observed = source.read_hop(source_key, dest_key);
    let verdict = adjudicate_hop(claim, observed, tol);
    HopReport {
        source_hash: source_key.tx_hash().to_string(),
        dest_hash: dest_key.map(|k| k.tx_hash().to_string()),
        lane: claim.lane(),
        dest_selector: claim.dest_selector(),
        sent: claim.sent(),
        min_release: claim.min_release(),
        burned: observed.map(|o| o.source().burned()),
        released: observed.and_then(|o| o.dest().map(|d| d.released())),
        verdict,
    }
}

/// Verify a MULTI-hop bridge journey: a journey is settled ONLY if EVERY hop is independently settled.
///
/// Design WOW Feature 3b: "A multi-hop journey is **settled only if every hop is independently settled** --
/// hop-1 on Ethereum says nothing about hop-2 to Base." This is the multi-hop kill-shot: it verifies each
/// hop with [`verify_hop`] and returns the per-hop reports PLUS the single composed verdict, which is
/// `Settled` IFF all hops settled, and otherwise the FIRST non-settled hop's verdict (the loud first
/// failure -- never a fabricated whole-journey settled when any hop did not settle, e.g. hop-1 settles,
/// hop-2 to Base is hollow-egress -> the journey is hollow, never "done").
///
/// `hops` pairs each hop's (source key, optional destination key, claim), in journey order. An empty
/// journey is NOT a settled journey -- it is `Unverified` (nothing on-record confirming any hop), never a
/// vacuous `settled` (design SS3 principle 3).
#[must_use]
pub fn verify_bridge(
    hops: &[(ReadKey, Option<ReadKey>, HopClaim)],
    tol: Ratio,
    source: &mut dyn BridgeSource,
) -> (Vec<HopReport>, Verdict) {
    let reports: Vec<HopReport> = hops
        .iter()
        .map(|(source_key, dest_key, claim)| {
            verify_hop(source_key, dest_key.as_ref(), claim, tol, source)
        })
        .collect();

    // An empty journey asserts no settlement -> Unverified (never a vacuous settled).
    let Some(first) = reports.first() else {
        return (reports, Verdict::unverified());
    };

    // The composed verdict: Settled IFF every hop settled; else the FIRST non-settled hop's verdict (the
    // loud first failure). This can NEVER be a fabricated whole-journey settled when any hop did not settle.
    let composed = if reports.iter().all(|r| r.verdict.is_settled()) {
        Verdict::settled()
    } else {
        reports
            .iter()
            .find(|r| !r.verdict.is_settled())
            .map_or(first.verdict, |r| r.verdict)
    };
    (reports, composed)
}

// =================================================================================================
// LiveBridgeSource -- the real two-chain eth_getTransactionReceipt reader. Behind `live` ONLY (SS6).
// =================================================================================================

/// A live two-chain bridge reader -- compiled **only** behind the `live` cargo feature.
///
/// The real-network counterpart to [`BridgeTape`]: it POSTs `eth_getTransactionReceipt(source_hash)` to
/// the SOURCE chain's RPC and confirms the `ccipSend` / burn / lock event, AND POSTs
/// `eth_getTransactionReceipt(dest_hash)` to the DESTINATION chain's RPC and confirms the OffRamp
/// release/mint event -- NEVER the bridge / CCIP-explorer REST API. It is feature-gated so the default
/// build pulls in no network dependency and stays fully offline (design SS6). Both endpoints are supplied
/// by the caller (from `OG_RPC` / the destination chain's RPC env), never hardcoded.
///
/// CCIP on 0G is **MAINNET-only** (Galileo CCIP is decommissioned) -> the live bridge read is
/// OPERATOR-GATED; the offline tape proves the algebra at $0.
///
/// ## How it stays honest (design SS3 principle 3, never fabricate)
///
/// - A `null` SOURCE receipt (unknown / unmined source tx) -> `None` (no source read -> Unverified).
/// - A SOURCE receipt with `status == 0x0` (reverted) -> `Some(HopObservation::new(SourceLeg::new(0),
///   ...))` -- the source burned nothing (a hollow source), never an `Unavailable` and never a fabricated
///   nonzero.
/// - A successful SOURCE receipt whose logs match the burn/lock topic -> decode the burned amount; any
///   malformed / out-of-`i128`-range data -> `None` (loud), never a wrapped (fabricated) amount.
/// - A successful SOURCE receipt with NO burn/lock event -> `SourceLeg::new(0)` (a hollow source).
/// - NO destination hash supplied (the hop is still in-flight, destination unknown) -> `dest = None` ->
///   Unverified (the loud "still arriving", NOT a hollow-egress defect).
/// - A `null` DESTINATION receipt (the destination tx is unknown/unmined) -> `dest = None` -> Unverified.
/// - A DESTINATION receipt with `status == 0x0` (reverted release) -> `Some(DestLeg::empty())` -- the
///   HOLLOW-EGRESS input (read, released nothing).
/// - A successful DESTINATION receipt whose logs match the release/mint topic -> decode the released
///   amount; malformed / out-of-range -> `None` (loud), never a fabricated amount.
/// - A successful DESTINATION receipt with NO release/mint event -> `DestLeg::empty()` (read, empty -> the
///   HOLLOW-EGRESS catch), distinct from "unreadable".
///
/// The caller supplies the lane's BURN/LOCK and RELEASE/MINT event `topic0`s (public protocol facts, from
/// the CCIP pool ABI), so no lane-specific topic is baked into the verifier -- the read stays clean-room +
/// generic.
#[cfg(feature = "live")]
#[derive(Debug, Clone)]
pub struct LiveBridgeSource {
    /// The SOURCE chain JSON-RPC endpoint (e.g. 0G for an egress hop; Ethereum for an inbound hop).
    source_endpoint: String,
    /// The DESTINATION chain JSON-RPC endpoint (e.g. Ethereum for an egress hop; 0G for an inbound hop).
    dest_endpoint: String,
    /// The lane's BURN/LOCK event `topic0` (lowercase `0x` + 64 hex) on the source chain. The decoded
    /// amount is the burned/locked amount.
    burn_topic0: String,
    /// The lane's RELEASE/MINT event `topic0` (lowercase `0x` + 64 hex) on the destination chain. The
    /// decoded amount is the released/minted amount.
    release_topic0: String,
}

#[cfg(feature = "live")]
impl LiveBridgeSource {
    /// Build a live two-chain bridge reader against the source + destination RPC endpoints and the lane's
    /// burn/lock and release/mint event topics. The topics are public protocol facts (the CCIP pool's
    /// burn/release event signatures), supplied by the caller -- never hardcoded, so the verifier stays
    /// lane-generic + clean-room.
    #[must_use]
    pub fn new(
        source_endpoint: impl Into<String>,
        dest_endpoint: impl Into<String>,
        burn_topic0: impl Into<String>,
        release_topic0: impl Into<String>,
    ) -> LiveBridgeSource {
        LiveBridgeSource {
            source_endpoint: source_endpoint.into(),
            dest_endpoint: dest_endpoint.into(),
            burn_topic0: burn_topic0.into().trim().to_ascii_lowercase(),
            release_topic0: release_topic0.into().trim().to_ascii_lowercase(),
        }
    }

    /// The configured SOURCE chain JSON-RPC endpoint.
    #[must_use]
    pub fn source_endpoint(&self) -> &str {
        &self.source_endpoint
    }

    /// The configured DESTINATION chain JSON-RPC endpoint.
    #[must_use]
    pub fn dest_endpoint(&self) -> &str {
        &self.dest_endpoint
    }

    /// POST one JSON-RPC call to `endpoint` and return the `result` value, or `None` on any
    /// transport/RPC failure.
    fn rpc_call(endpoint: &str, method: &str, params: serde_json::Value) -> Option<serde_json::Value> {
        let body = serde_json::json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": method,
            "params": params,
        });
        let response = ureq::post(endpoint)
            .set("content-type", "application/json")
            .send_json(body)
            .ok()?;
        let value: serde_json::Value = response.into_json().ok()?;
        if value.get("error").is_some() {
            return None;
        }
        value.get("result").cloned()
    }

    /// `true` iff the log's `topic0` equals `topic` (case-insensitive).
    fn log_topic0_matches(log: &serde_json::Value, topic: &str) -> bool {
        log.get("topics")
            .and_then(serde_json::Value::as_array)
            .and_then(|t| t.first())
            .and_then(serde_json::Value::as_str)
            .map(|t| t.eq_ignore_ascii_case(topic))
            == Some(true)
    }

    /// Read the SOURCE burn/lock leg from the source chain. `None` only when the source receipt itself is
    /// unreadable (null / malformed status). A reverted or event-less source is a hollow source
    /// (`SourceLeg::new(0)`), never fabricated.
    fn read_source(&self, source_key: &ReadKey) -> Option<SourceLeg> {
        let receipt = Self::rpc_call(
            &self.source_endpoint,
            "eth_getTransactionReceipt",
            serde_json::json!([source_key.tx_hash()]),
        )?;
        if receipt.is_null() {
            return None; // unknown / unmined source tx -> no source read -> Unverified
        }
        match receipt.get("status").and_then(serde_json::Value::as_str) {
            Some("0x0") => return Some(SourceLeg::new(0)), // reverted source -> burned nothing (hollow)
            Some("0x1") => {}
            _ => return None, // missing / malformed status -> loud absence
        }
        let logs = receipt.get("logs").and_then(serde_json::Value::as_array)?;
        for log in logs {
            if Self::log_topic0_matches(log, &self.burn_topic0) {
                let data = log.get("data").and_then(serde_json::Value::as_str)?;
                let burned = decode_bridge_amount(data)?;
                return Some(SourceLeg::new(burned));
            }
        }
        // Success but NO burn/lock event -> on-record, burned nothing (a hollow source).
        Some(SourceLeg::new(0))
    }

    /// Read the DESTINATION release/mint leg from the destination chain. `None` (still in-flight ->
    /// Unverified) when there is no dest hash or the dest receipt is unreadable. A reverted or event-less
    /// destination is the HOLLOW-EGRESS input (`DestLeg::empty()`), read-but-empty, never fabricated.
    fn read_dest(&self, dest_key: Option<&ReadKey>) -> Option<DestLeg> {
        let dest_key = dest_key?; // no dest hash -> still in-flight -> None -> Unverified
        let receipt = Self::rpc_call(
            &self.dest_endpoint,
            "eth_getTransactionReceipt",
            serde_json::json!([dest_key.tx_hash()]),
        )?;
        if receipt.is_null() {
            return None; // unknown / unmined dest tx -> still in-flight -> Unverified
        }
        match receipt.get("status").and_then(serde_json::Value::as_str) {
            Some("0x0") => return Some(DestLeg::empty()), // reverted release -> read, empty (HOLLOW-EGRESS)
            Some("0x1") => {}
            _ => return None, // missing / malformed status -> still in-flight (loud absence)
        }
        let logs = receipt.get("logs").and_then(serde_json::Value::as_array)?;
        for log in logs {
            if Self::log_topic0_matches(log, &self.release_topic0) {
                let data = log.get("data").and_then(serde_json::Value::as_str)?;
                let released = decode_bridge_amount(data)?;
                return Some(DestLeg::new(released));
            }
        }
        // Success but NO release/mint event -> on-record, released nothing -> the HOLLOW-EGRESS catch
        // (read, empty), distinct from "unreadable".
        Some(DestLeg::empty())
    }
}

/// Decode a bridged amount from a burn/lock or release/mint event data blob: the first 32-byte word as a
/// `uint256`.
///
/// The bridged amount is the first non-indexed word of the CCIP pool's burn/release event data (the
/// canonical shape for a `Burned(...)`/`Released(...)`/`Minted(...)` event carrying a `uint256 amount`).
/// Returns the amount as a non-negative `i128` of minor units, or `None` for a malformed blob or an
/// out-of-`i128`-range magnitude (never a wrapped/fabricated amount; design SS3 principle 3 + 5).
#[cfg(feature = "live")]
fn decode_bridge_amount(data_hex: &str) -> Option<i128> {
    let body = data_hex.trim().strip_prefix("0x").or_else(|| data_hex.trim().strip_prefix("0X"))?;
    if body.len() < 64 || !body.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None; // need at least one 32-byte word (the uint256 amount)
    }
    let word = &body[0..64];
    // A bridged amount far inside i128 for any realistic balance; the high 16 bytes must be zero
    // (positive, in range). Anything else is out of i128 range -> None (never wrapped).
    let high = &word[0..32];
    let low = &word[32..64];
    if !high.bytes().all(|b| b == b'0') {
        return None;
    }
    let low_val = u128::from_str_radix(low, 16).ok()?;
    if low_val > i128::MAX as u128 {
        return None;
    }
    Some(low_val as i128)
}

#[cfg(feature = "live")]
impl BridgeSource for LiveBridgeSource {
    fn read_hop(&mut self, source_key: &ReadKey, dest_key: Option<&ReadKey>) -> Option<HopObservation> {
        // (1) The SOURCE leg is the gate: if the source itself is unreadable, the whole hop is Unverified.
        let source = self.read_source(source_key)?;
        // (2) The DESTINATION leg is read independently on the OTHER chain. A None destination is a still-
        // in-flight hop (Unverified); a present-but-empty destination is the HOLLOW-EGRESS catch.
        let dest = self.read_dest(dest_key);
        Some(HopObservation::new(source, dest))
    }
}

/// Render a [`HopReport`] as a single deterministic human-readable line (for the journal/UI).
impl fmt::Display for HopReport {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let dest_hash = self.dest_hash.as_deref().unwrap_or("<in-flight>");
        let burned = match self.burned {
            Some(v) => v.to_string(),
            None => "<unavailable>".to_string(),
        };
        let released = match self.released {
            Some(v) => v.to_string(),
            None => "<in-flight>".to_string(),
        };
        write!(
            f,
            "BRIDGE {} dest_selector={} src={} dst={} sent={} min_release={} burned={} released={} -> {}",
            self.lane,
            self.dest_selector,
            self.source_hash,
            dest_hash,
            self.sent,
            self.min_release,
            burned,
            released,
            self.verdict_string(),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SRC_A: &str = "0xaa11111111111111111111111111111111111111111111111111111111111111";
    const SRC_B: &str = "0xbb22222222222222222222222222222222222222222222222222222222222222";
    const SRC_C: &str = "0xcc33333333333333333333333333333333333333333333333333333333333333";
    const DST_A: &str = "0xdd44444444444444444444444444444444444444444444444444444444444444";
    const DST_B: &str = "0xee55555555555555555555555555555555555555555555555555555555555555";

    fn key(h: &str) -> ReadKey {
        ReadKey::new(h).expect("test hash is well-formed")
    }

    fn band_15pct() -> Ratio {
        Ratio::new(15, 100).expect("15/100 is a well-formed ratio")
    }

    fn claim(lane: BridgeLane, sel: DestSelector) -> HopClaim {
        // sent 1_000_000, floor 990_000 (a 1% release tolerance).
        HopClaim::new(lane, sel, 1_000_000, 990_000)
    }

    // --- the FOUR verdicts (the alphabet, design SS2) reused for a bridge hop --------------------

    #[test]
    fn settled_when_both_legs_read_and_release_is_within_band_and_above_floor() {
        // source burned 1_000_000, dest released 1_000_000: >= floor(990_000) AND |1_000_000-1_000_000|=0
        // <= band -> Settled (value left AND arrived).
        let v = adjudicate_hop(
            &claim(BridgeLane::UsdcEgress, DestSelector::Ethereum),
            Some(HopObservation::bridged(1_000_000, 1_000_000)),
            band_15pct(),
        );
        assert_eq!(v, Verdict::Settled);
    }

    #[test]
    fn hollow_egress_is_the_centerpiece_source_burned_dest_read_empty() {
        // THE HOLLOW-EGRESS CATCH (design WOW Feature 3b): source burned 1_000_000, destination leg READ
        // and released NOTHING -> Hollow, NEVER settled. Value left 0G and did not arrive on the dest.
        let v = adjudicate_hop(
            &claim(BridgeLane::UsdcEgress, DestSelector::Ethereum),
            Some(HopObservation::hollow_egress(1_000_000)),
            band_15pct(),
        );
        assert_eq!(v, Verdict::Hollow, "burned-on-source, empty-on-dest is the hollow-egress catch");
        assert_ne!(v, Verdict::Settled, "a hollow egress must NEVER be a fabricated settle");
    }

    #[test]
    fn unverified_when_source_burned_but_dest_is_unreadable_still_in_flight() {
        // The source burned, but the destination leg cannot be READ yet -> the hop is still in-flight ->
        // Unverified (NOT hollow-egress -- we did not read the destination as empty). This is the key
        // distinction: still-arriving is never mislabelled a defect.
        let v = adjudicate_hop(
            &claim(BridgeLane::UsdcEgress, DestSelector::Ethereum),
            Some(HopObservation::in_flight(1_000_000)),
            band_15pct(),
        );
        assert_eq!(v, Verdict::Unverified, "a still-in-flight hop is unverified, never a defect");
        assert_ne!(v, Verdict::Hollow, "an UNREADABLE destination is not the hollow-egress defect");
        assert_ne!(v, Verdict::Settled);
    }

    #[test]
    fn hollow_when_the_source_itself_burned_nothing() {
        // A hollow SOURCE: the source tx is on-record but burned/locked nothing -> Hollow (no value left,
        // so nothing could arrive), caught before any destination math.
        let v = adjudicate_hop(
            &claim(BridgeLane::UsdcEgress, DestSelector::Ethereum),
            Some(HopObservation::bridged(0, 0)),
            band_15pct(),
        );
        assert_eq!(v, Verdict::Hollow, "a source that burned nothing is hollow");
    }

    #[test]
    fn mismatch_when_dest_release_is_below_the_on_chain_floor() {
        // dest released 980_000 < floor 990_000 -> Mismatch (a short release; the lane's bound violated).
        // Checked BEFORE the band, so a below-floor release can never settle even if near sent.
        let v = adjudicate_hop(
            &claim(BridgeLane::W0gEgress, DestSelector::Base),
            Some(HopObservation::bridged(1_000_000, 980_000)),
            band_15pct(),
        );
        assert_eq!(v, Verdict::Mismatch);
    }

    #[test]
    fn mismatch_when_above_floor_but_outside_the_band() {
        // dest released 1_300_000 >= floor 990_000, but |1_300_000-1_000_000|=300_000 > band(150_000) ->
        // Mismatch (a wrong-asset arrival / over-release beyond tolerance).
        let v = adjudicate_hop(
            &claim(BridgeLane::UsdcInbound, DestSelector::ZeroG),
            Some(HopObservation::bridged(1_000_000, 1_300_000)),
            band_15pct(),
        );
        assert_eq!(v, Verdict::Mismatch);
    }

    #[test]
    fn unverified_when_no_observation_at_all_never_settled() {
        // THE KEYSTONE (design SS3 principle 3): no source read at all -> Unverified, never a fabricated
        // settled, no matter the claim.
        let v = adjudicate_hop(&claim(BridgeLane::UsdcEgress, DestSelector::Ethereum), None, band_15pct());
        assert_eq!(v, Verdict::Unverified);
        assert_ne!(v, Verdict::Settled);
    }

    #[test]
    fn settled_at_the_floor_boundary() {
        // dest released exactly == floor, and within band -> Settled (the floor is inclusive: >=).
        // sent 1_000_000, floor 990_000, released 990_000: 990_000 >= 990_000 AND |990_000-1_000_000|=
        // 10_000 <= band(150_000) -> Settled.
        let v = adjudicate_hop(
            &claim(BridgeLane::UsdcEgress, DestSelector::Ethereum),
            Some(HopObservation::bridged(1_000_000, 990_000)),
            band_15pct(),
        );
        assert_eq!(v, Verdict::Settled);
    }

    #[test]
    fn the_hollow_egress_catch_dominates_a_stray_nonzero_is_irrelevant_when_dest_empty() {
        // Defense-in-depth: a hollow-egress (dest read empty) is Hollow regardless of how large the source
        // burn was -- the destination releasing 0 is the catch, checked before any amount comparison.
        let v = adjudicate_hop(
            &claim(BridgeLane::UsdcEgress, DestSelector::Ethereum),
            Some(HopObservation::hollow_egress(999_999_999)),
            band_15pct(),
        );
        assert_eq!(v, Verdict::Hollow, "a read-empty destination is hollow no matter the source burn");
    }

    #[test]
    fn adjudicate_hop_is_deterministic() {
        // Same inputs -> identical verdict, every call (design SS3 principle 4).
        let c = claim(BridgeLane::UsdcEgress, DestSelector::Ethereum);
        for _ in 0..8 {
            assert_eq!(adjudicate_hop(&c, Some(HopObservation::bridged(1_000_000, 1_000_000)), band_15pct()), Verdict::Settled);
            assert_eq!(adjudicate_hop(&c, Some(HopObservation::hollow_egress(1_000_000)), band_15pct()), Verdict::Hollow);
            assert_eq!(adjudicate_hop(&c, Some(HopObservation::in_flight(1_000_000)), band_15pct()), Verdict::Unverified);
            assert_eq!(adjudicate_hop(&c, Some(HopObservation::bridged(1_000_000, 980_000)), band_15pct()), Verdict::Mismatch);
            assert_eq!(adjudicate_hop(&c, None, band_15pct()), Verdict::Unverified);
        }
    }

    // --- the bridge tape (offline, deterministic) ------------------------------------------------

    #[test]
    fn tape_hit_verifies_and_off_tape_is_unverified() {
        let c = claim(BridgeLane::UsdcEgress, DestSelector::Ethereum);
        let mut tape = BridgeTape::new().with(key(SRC_A), HopObservation::bridged(1_000_000, 1_000_000));

        let report = verify_hop(&key(SRC_A), Some(&key(DST_A)), &c, band_15pct(), &mut tape);
        assert_eq!(report.verdict, Verdict::Settled);
        assert_eq!(report.verdict_string(), "settled");
        assert_eq!(report.burned, Some(1_000_000));
        assert_eq!(report.released, Some(1_000_000));
        assert_eq!(report.source_hash, SRC_A);
        assert_eq!(report.dest_hash.as_deref(), Some(DST_A));
        assert_eq!(report.lane, BridgeLane::UsdcEgress);

        // An off-tape source hop is Unverified (never a fabricated settled).
        let report2 = verify_hop(&key(SRC_B), Some(&key(DST_B)), &c, band_15pct(), &mut tape);
        assert_eq!(report2.verdict, Verdict::Unverified);
        assert_eq!(report2.burned, None);
        assert_eq!(report2.released, None);
        assert_ne!(report2.verdict, Verdict::Settled);
    }

    #[test]
    fn empty_tape_makes_every_hop_unverified() {
        let mut tape = BridgeTape::new();
        assert!(tape.is_empty());
        assert_eq!(tape.len(), 0);
        let report = verify_hop(&key(SRC_A), Some(&key(DST_A)), &claim(BridgeLane::UsdcInbound, DestSelector::ZeroG), band_15pct(), &mut tape);
        assert_eq!(report.verdict, Verdict::Unverified);
    }

    #[test]
    fn bridge_tape_read_is_deterministic_and_record_overwrites() {
        let mut tape = BridgeTape::new();
        tape.record(key(SRC_A), HopObservation::bridged(1, 1));
        tape.record(key(SRC_A), HopObservation::bridged(2, 2)); // overwrites
        assert_eq!(tape.read_hop(&key(SRC_A), None), Some(HopObservation::bridged(2, 2)));
        assert_eq!(tape.len(), 1);
        let first = tape.read_hop(&key(SRC_A), None);
        for _ in 0..8 {
            assert_eq!(tape.read_hop(&key(SRC_A), None), first);
        }
    }

    #[test]
    fn bridge_tape_is_a_dyn_source() {
        // The seam is object-safe: a BridgeTape works through &mut dyn BridgeSource, so a live + a taped
        // reader are drop-in interchangeable behind one trait.
        let mut tape = BridgeTape::new().with(key(SRC_A), HopObservation::bridged(5, 5));
        let dynamic: &mut dyn BridgeSource = &mut tape;
        assert_eq!(dynamic.read_hop(&key(SRC_A), None), Some(HopObservation::bridged(5, 5)));
        assert_eq!(dynamic.read_hop(&key(SRC_B), None), None);
    }

    #[test]
    fn hop_report_flags_the_hollow_egress_defect() {
        // The HopReport.is_hollow_egress helper distinguishes the hollow-egress defect (source burned,
        // dest read empty) from a plain unverified (dest unreadable) -- so the loud audit prescribes the
        // heal (manual-exec) only for a real stuck egress.
        let c = claim(BridgeLane::UsdcEgress, DestSelector::Ethereum);
        let mut tape = BridgeTape::new()
            .with(key(SRC_A), HopObservation::hollow_egress(1_000_000))
            .with(key(SRC_B), HopObservation::in_flight(1_000_000));

        let hollow = verify_hop(&key(SRC_A), Some(&key(DST_A)), &c, band_15pct(), &mut tape);
        assert_eq!(hollow.verdict, Verdict::Hollow);
        assert!(hollow.is_hollow_egress(), "a burned-source/empty-dest hop IS the hollow-egress defect");

        let in_flight = verify_hop(&key(SRC_B), None, &c, band_15pct(), &mut tape);
        assert_eq!(in_flight.verdict, Verdict::Unverified);
        assert!(!in_flight.is_hollow_egress(), "a still-in-flight hop is NOT a hollow-egress defect");
    }

    // --- the multi-hop journey composition (settled IFF every hop settled) -----------------------

    #[test]
    fn multi_hop_journey_settles_only_when_every_hop_settles() {
        // A two-hop journey (0G -> Ethereum, then Ethereum -> Base) settles ONLY if BOTH hops settle.
        let mut tape = BridgeTape::new()
            .with(key(SRC_A), HopObservation::bridged(1_000_000, 1_000_000))
            .with(key(SRC_B), HopObservation::bridged(1_000_000, 995_000));
        let hops = [
            (key(SRC_A), Some(key(DST_A)), claim(BridgeLane::UsdcEgress, DestSelector::Ethereum)),
            (key(SRC_B), Some(key(DST_B)), claim(BridgeLane::UsdcEgress, DestSelector::Base)),
        ];
        let (reports, composed) = verify_bridge(&hops, band_15pct(), &mut tape);
        assert_eq!(reports.len(), 2);
        assert!(reports.iter().all(|r| r.verdict == Verdict::Settled));
        assert_eq!(composed, Verdict::Settled);
    }

    #[test]
    fn multi_hop_journey_with_one_hollow_egress_hop_is_not_settled() {
        // The multi-hop kill-shot (design WOW Feature 3b): hop 1 (0G->Eth) settles, hop 2 (Eth->Base) is
        // hollow-egress -> the WHOLE journey is NOT settled; the composed verdict is the FIRST non-settled
        // hop's verdict (hollow). A stuck second hop can never make the journey a fabricated settled.
        let mut tape = BridgeTape::new()
            .with(key(SRC_A), HopObservation::bridged(1_000_000, 1_000_000))
            .with(key(SRC_B), HopObservation::hollow_egress(1_000_000));
        let hops = [
            (key(SRC_A), Some(key(DST_A)), claim(BridgeLane::UsdcEgress, DestSelector::Ethereum)),
            (key(SRC_B), Some(key(DST_B)), claim(BridgeLane::UsdcEgress, DestSelector::Base)),
        ];
        let (reports, composed) = verify_bridge(&hops, band_15pct(), &mut tape);
        assert_eq!(reports[0].verdict, Verdict::Settled);
        assert_eq!(reports[1].verdict, Verdict::Hollow, "the second hop is hollow-egress");
        assert!(reports[1].is_hollow_egress());
        assert_eq!(composed, Verdict::Hollow, "a journey with a hollow-egress hop is NOT settled");
        assert_ne!(composed, Verdict::Settled);
    }

    #[test]
    fn multi_hop_journey_with_an_in_flight_hop_is_unverified_not_settled() {
        // Hop 1 settles, hop 2 is still in-flight (dest unreadable) -> composed = unverified (never
        // settled, and never a hollow-egress defect -- the second hop is merely still arriving).
        let mut tape = BridgeTape::new()
            .with(key(SRC_A), HopObservation::bridged(1_000_000, 1_000_000))
            .with(key(SRC_C), HopObservation::in_flight(1_000_000));
        let hops = [
            (key(SRC_A), Some(key(DST_A)), claim(BridgeLane::UsdcEgress, DestSelector::Ethereum)),
            (key(SRC_C), None, claim(BridgeLane::UsdcEgress, DestSelector::Base)),
        ];
        let (reports, composed) = verify_bridge(&hops, band_15pct(), &mut tape);
        assert_eq!(reports[0].verdict, Verdict::Settled);
        assert_eq!(reports[1].verdict, Verdict::Unverified);
        assert!(!reports[1].is_hollow_egress());
        assert_eq!(composed, Verdict::Unverified);
        assert_ne!(composed, Verdict::Settled);
    }

    #[test]
    fn an_empty_journey_is_unverified_never_a_vacuous_settled() {
        // No hops -> the journey asserts no settlement -> Unverified (never a vacuous settled).
        let mut tape = BridgeTape::new();
        let (reports, composed) = verify_bridge(&[], band_15pct(), &mut tape);
        assert!(reports.is_empty());
        assert_eq!(composed, Verdict::Unverified);
        assert_ne!(composed, Verdict::Settled);
    }

    #[test]
    fn report_renders_for_the_journal() {
        let c = claim(BridgeLane::UsdcEgress, DestSelector::Ethereum);
        let mut tape = BridgeTape::new().with(key(SRC_A), HopObservation::bridged(1_000_000, 1_000_000));
        let report = verify_hop(&key(SRC_A), Some(&key(DST_A)), &c, band_15pct(), &mut tape);
        let line = report.to_string();
        assert!(line.contains("BRIDGE"));
        assert!(line.contains("usdc-egress"));
        assert!(line.contains("ethereum:5009297550715157269"));
        assert!(line.contains("burned=1000000"));
        assert!(line.contains("released=1000000"));
        assert!(line.contains("settled"));
        // A hollow-egress read renders the empty destination + the hollow verdict.
        let mut tape2 = BridgeTape::new().with(key(SRC_A), HopObservation::hollow_egress(1_000_000));
        let report2 = verify_hop(&key(SRC_A), Some(&key(DST_A)), &c, band_15pct(), &mut tape2);
        let line2 = report2.to_string();
        assert!(line2.contains("released=0"));
        assert!(line2.contains("hollow"));
        // A still-in-flight read renders the in-flight destination, never a number.
        let mut tape3 = BridgeTape::new().with(key(SRC_A), HopObservation::in_flight(1_000_000));
        let report3 = verify_hop(&key(SRC_A), None, &c, band_15pct(), &mut tape3);
        let line3 = report3.to_string();
        assert!(line3.contains("dst=<in-flight>"));
        assert!(line3.contains("released=<in-flight>"));
        assert!(line3.contains("unverified"));
    }

    #[test]
    fn dest_selectors_are_the_public_ccip_lane_values() {
        // Pinned exact CCIP selectors (public protocol facts from design WOW Feature 3 / 3b; conformance).
        assert_eq!(DestSelector::Ethereum.value(), 5_009_297_550_715_157_269);
        assert_eq!(DestSelector::ZeroG.value(), 4_426_351_306_075_016_396);
        assert_eq!(DestSelector::Arbitrum.value(), 4_949_039_107_694_359_620);
        assert_eq!(DestSelector::Base.value(), 15_971_525_489_660_198_786);
        assert_eq!(DestSelector::Bnb.value(), 11_344_663_589_394_136_015);
    }

    #[test]
    fn lane_labels_and_egress_flags_are_stable() {
        assert_eq!(BridgeLane::UsdcInbound.canonical_string(), "usdc-inbound");
        assert_eq!(BridgeLane::W0gInboundArbitrum.canonical_string(), "w0g-inbound-arbitrum");
        assert_eq!(BridgeLane::W0gInboundBnb.canonical_string(), "w0g-inbound-bnb");
        assert_eq!(BridgeLane::UsdcEgress.canonical_string(), "usdc-egress");
        assert_eq!(BridgeLane::W0gEgress.canonical_string(), "w0g-egress");
        assert!(!BridgeLane::UsdcInbound.is_egress(), "inbound mints into the hub we watch");
        assert!(BridgeLane::UsdcEgress.is_egress(), "usdc egress leaves the 0G hub");
        assert!(BridgeLane::W0gEgress.is_egress(), "w0g egress leaves the 0G hub");
    }

    #[test]
    fn hub_and_spoke_directionality_inbound_is_the_exact_complement_of_egress() {
        // The hub-and-spoke section: every lane is either inbound (INTO the 0G hub, the autonomous
        // direction) or egress (OUT to a spoke, the risky direction) -- is_inbound is the exact complement
        // of is_egress, so a lane can never be classed as both or neither.
        for lane in [
            BridgeLane::UsdcInbound,
            BridgeLane::W0gInboundArbitrum,
            BridgeLane::W0gInboundBnb,
            BridgeLane::UsdcEgress,
            BridgeLane::W0gEgress,
        ] {
            assert_ne!(lane.is_inbound(), lane.is_egress(), "{lane} is exactly one of inbound/egress");
        }
        // The new spoke->hub inbound lanes from Arbitrum + BNB are AUTONOMOUS (into the secured hub).
        assert!(BridgeLane::W0gInboundArbitrum.is_inbound(), "Arbitrum->0G is inbound (into the hub)");
        assert!(BridgeLane::W0gInboundBnb.is_inbound(), "BNB->0G is inbound (into the hub)");
        assert!(!BridgeLane::W0gInboundArbitrum.is_egress());
        assert!(!BridgeLane::W0gInboundBnb.is_egress());
    }

    #[test]
    fn inbound_lanes_carry_their_source_spoke_selector_egress_lanes_do_not() {
        // An inbound lane records WHICH spoke it bridges from the 0G hub (the per-spoke isolated-cap audit
        // trail); an egress lane's spoke is the hop's pinned dest_selector, not lane-fixed -> None.
        assert_eq!(BridgeLane::UsdcInbound.spoke_selector(), Some(DestSelector::Ethereum));
        assert_eq!(BridgeLane::W0gInboundArbitrum.spoke_selector(), Some(DestSelector::Arbitrum));
        assert_eq!(BridgeLane::W0gInboundBnb.spoke_selector(), Some(DestSelector::Bnb));
        assert_eq!(BridgeLane::UsdcEgress.spoke_selector(), None);
        assert_eq!(BridgeLane::W0gEgress.spoke_selector(), None);
    }

    // --- the live decoder (feature-gated): the amount codec is exact + never fabricates ----------

    #[cfg(feature = "live")]
    #[test]
    fn live_decode_amount_reads_the_first_uint256_word() {
        let amount = format!("{:0>64x}", 1_000_000u128);
        let data = format!("0x{amount}{}", "0".repeat(64)); // amount + a trailing word
        assert_eq!(super::decode_bridge_amount(&data), Some(1_000_000));
    }

    #[cfg(feature = "live")]
    #[test]
    fn live_decode_amount_rejects_malformed_and_oversized_never_fabricates() {
        assert_eq!(super::decode_bridge_amount("0x"), None, "empty blob is malformed");
        assert_eq!(super::decode_bridge_amount("0xzz"), None, "non-hex is malformed");
        // High bytes set -> out of i128 range -> None (never wrapped).
        let oversized = format!("0x{}{}", "f".repeat(32), "0".repeat(32));
        assert_eq!(super::decode_bridge_amount(&oversized), None);
    }

    #[cfg(feature = "live")]
    #[test]
    fn live_unreachable_endpoints_are_unverified_never_settled() {
        // The live reader is wired but pointed at unreachable endpoints: both reads fail, so the hop
        // degrades LOUDLY to Unverified (design SS3 principle 3), never a fabricated Settled.
        let mut src = LiveBridgeSource::new(
            "http://127.0.0.1:0",
            "http://127.0.0.1:0",
            "0x1111111111111111111111111111111111111111111111111111111111111111",
            "0x2222222222222222222222222222222222222222222222222222222222222222",
        );
        assert_eq!(src.source_endpoint(), "http://127.0.0.1:0");
        assert_eq!(src.dest_endpoint(), "http://127.0.0.1:0");
        let report = verify_hop(&key(SRC_A), Some(&key(DST_A)), &claim(BridgeLane::UsdcEgress, DestSelector::Ethereum), band_15pct(), &mut src);
        assert_eq!(report.verdict, Verdict::Unverified);
        assert_ne!(report.verdict, Verdict::Settled);
        assert_eq!(report.burned, None);
    }
}
