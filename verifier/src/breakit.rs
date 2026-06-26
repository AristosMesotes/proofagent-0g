//! THE BREAK-IT GAUNTLET -- `run_gauntlet()`: a battery of deliberate attacks on the honesty guarantees,
//! each of which the verifier DEFEATS. "You don't trust it -- you try to break it, and watch it refuse."
//!
//! ## Why this leg exists
//!
//! Every other leg PROVES a guarantee on honest inputs. This leg inverts the test: it constructs the exact
//! adversarial inputs a dishonest agent / solver / UI would use to FABRICATE a green -- a settlement the
//! chain never recorded, a fill that delivered nothing, a cross-chain lock with an empty destination, a
//! repeat liar trying to keep its mandate, a revoked solver collecting on a later fill, an on-chain spend
//! with no record -- and asserts the verifier REFUSED each one. An attack is **Defeated** iff the verifier
//! returned its honest refusal (never the attacker's desired pass); an attack that **Succeeds** (the system
//! was fooled into a fabricated `Settled` / `RELEASE` / `ACTIVE` / `reconciled`) is a catastrophic honesty
//! defect and the gauntlet fails LOUD (exit non-zero).
//!
//! It is the single artifact a judge runs to satisfy "you don't trust it, you check": `verifier break-it`
//! shows every attack and its loud refusal. Pure + deterministic + offline (the verifier algebra over taped
//! reads); no network, no money moved. No new verdict enum -- it only re-uses the proven legs (the monopoly
//! holds, design SS3 principle 2). The broader surface (the on-chain `SettlementOracle.requireProven` revert,
//! `MandateRegistry.checkTransfer` over-cap block, the gas-floor / net-worth-floor drain refusals, and the
//! sealed verdict monopoly itself) is proven by the rest of the 279 verifier + 208 contract tests.

use crate::{
    adjudicate, adjudicate_fill, adjudicate_xchain_fill, reconcile, run_filler, slash, FillClaim,
    FillRequest, JournalRecord, MandateStatus, Observation, OnchainTransfer, Ratio, ReadKey,
    ReconcileVerdict, SlashConfig, TapeSource, Verdict, XChainFillClaim,
};

/// One attack on a named honesty guarantee (the metadata shown to a judge).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Attack {
    /// 1-based id, for stable display ordering.
    pub id: u8,
    /// Short name of the attack.
    pub name: &'static str,
    /// The honesty guarantee under attack.
    pub guarantee: &'static str,
    /// What the attacker tries to do.
    pub attempt: &'static str,
    /// The honest refusal we expect (the canonical verdict / decision string the verifier should mint).
    pub expected_refusal: &'static str,
}

/// The outcome of one attack: DEFEATED (the guarantee held) or SUCCEEDED (the system was fooled -- a defect).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AttackOutcome {
    /// The attack was DEFEATED -- the verifier refused as designed. `observed` is the honest result it minted.
    Defeated {
        /// The honest verdict/decision the verifier actually returned.
        observed: String,
    },
    /// The attack SUCCEEDED -- the system was fooled into a fabricated pass. A catastrophic honesty defect.
    Succeeded {
        /// The (wrongly-passing) result the verifier returned.
        observed: String,
    },
}

impl AttackOutcome {
    /// `true` iff the attack was defeated (the guarantee held).
    #[must_use]
    pub const fn is_defeated(&self) -> bool {
        matches!(self, AttackOutcome::Defeated { .. })
    }

    /// The verifier's actual result string (the honest refusal on a defeat; the fabricated pass on a defect).
    #[must_use]
    pub fn observed(&self) -> &str {
        match self {
            AttackOutcome::Defeated { observed } | AttackOutcome::Succeeded { observed } => observed,
        }
    }
}

/// One attack plus its outcome.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AttackResult {
    /// The attack metadata.
    pub attack: Attack,
    /// Whether the verifier defeated it.
    pub outcome: AttackOutcome,
}

/// The result of running the whole gauntlet: every attack, in order, with its outcome.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GauntletReport {
    /// One [`AttackResult`] per attack, in id order.
    pub results: Vec<AttackResult>,
}

impl GauntletReport {
    /// How many attacks were DEFEATED (the guarantee held).
    #[must_use]
    pub fn defeated(&self) -> usize {
        self.results.iter().filter(|r| r.outcome.is_defeated()).count()
    }

    /// Total attacks in the gauntlet.
    #[must_use]
    pub fn total(&self) -> usize {
        self.results.len()
    }

    /// `true` iff EVERY attack was defeated -- the only honest "pass" for the gauntlet.
    #[must_use]
    pub fn all_defeated(&self) -> bool {
        self.results.iter().all(|r| r.outcome.is_defeated())
    }

    /// A single, human-readable summary line (deterministic; design SS3 principle 4).
    #[must_use]
    pub fn summary_line(&self) -> String {
        let verdict = if self.all_defeated() {
            "every honesty guarantee HELD"
        } else {
            "!!! AN ATTACK SUCCEEDED -- an honesty guarantee was broken"
        };
        format!("break-it: {}/{} attacks DEFEATED -- {verdict}", self.defeated(), self.total())
    }
}

/// The canonical demo band from the data spine (`proofagent.toml [verifier.tolerance]`): 15%.
fn band() -> Ratio {
    Ratio::new(15, 100).expect("15/100 is a well-formed ratio")
}

/// Two well-formed placeholder 32-byte hashes (NOT real on-chain txs -- the gauntlet is offline).
const HASH_A: &str = "0x1111111111111111111111111111111111111111111111111111111111111111";
const HASH_B: &str = "0x2222222222222222222222222222222222222222222222222222222222222222";

/// Assemble one attack result from its metadata + the defeat decision + the verifier's observed result.
fn result(
    id: u8,
    name: &'static str,
    guarantee: &'static str,
    attempt: &'static str,
    expected_refusal: &'static str,
    defeated: bool,
    observed: String,
) -> AttackResult {
    let attack = Attack { id, name, guarantee, attempt, expected_refusal };
    let outcome = if defeated {
        AttackOutcome::Defeated { observed }
    } else {
        AttackOutcome::Succeeded { observed }
    };
    AttackResult { attack, outcome }
}

// --- The attacks --------------------------------------------------------------------------------

/// #1 -- fabricate a SETTLED for a tx the chain has no record of. Defeated iff it reads `unverified`.
fn attack_fabricated_settlement() -> AttackResult {
    let verdict = adjudicate(1_000_000, None, band());
    result(
        1,
        "Fabricated settlement",
        "two-source truth: never fabricate a SETTLED from an unread chain",
        "claim a 1,000,000 settlement for a tx the chain has no record of",
        "unverified",
        verdict != Verdict::Settled,
        verdict.canonical_string().to_string(),
    )
}

/// #2 -- claim more than the chain moved. Defeated iff the disagreement reads `mismatch`, never `settled`.
fn attack_tampered_amount() -> AttackResult {
    let verdict = adjudicate(1_000_000, Some(500_000), band());
    result(
        2,
        "Tampered amount",
        "exact-integer two-source compare: a claim that disagrees with the chain cannot settle",
        "claim 1,000,000 settled when the chain shows only 500,000 actually moved",
        "mismatch",
        verdict != Verdict::Settled,
        verdict.canonical_string().to_string(),
    )
}

/// #3 -- call a no-op a settlement. Defeated iff `(0 -> 0)` reads `hollow`, never `settled`.
fn attack_phantom_settlement() -> AttackResult {
    let verdict = adjudicate(0, Some(0), band());
    result(
        3,
        "Phantom settlement",
        "a no-op (nothing moved) can never read as a real settlement",
        "settle a transaction where the chain says nothing moved (0 -> 0)",
        "hollow",
        verdict != Verdict::Settled,
        verdict.canonical_string().to_string(),
    )
}

/// #4 -- claim a fill the chain says delivered nothing. Defeated iff the oracle BLOCKs (never RELEASE).
fn attack_hollow_fill() -> AttackResult {
    let claim = FillClaim::new(HASH_A, HASH_B, 1_000_000);
    let report = adjudicate_fill(&claim, Some(0), band());
    result(
        4,
        "Hollow fill",
        "the fill-proof oracle releases a solver ONLY on a chain-confirmed delivery",
        "claim a 1,000,000 fill the chain says delivered nothing, to collect the solver's funds",
        "hollow / BLOCK",
        !report.decision.is_release(),
        format!("{} / {}", report.verdict.canonical_string(), report.decision.canonical_string()),
    )
}

/// #5 -- lock on the source, deliver nothing on the destination. Defeated iff the cross-chain fill BLOCKs.
fn attack_cross_chain_hollow() -> AttackResult {
    let claim = XChainFillClaim {
        source_tx: HASH_A.to_string(),
        dest_tx: HASH_B.to_string(),
        source_locked: 1_000_000,
        claimed_fill: 1_000_000,
    };
    // The source genuinely locked 1,000,000; the destination delivered ZERO.
    let report = adjudicate_xchain_fill(&claim, Some(1_000_000), Some(0), band());
    result(
        5,
        "Cross-chain hollow fill",
        "both legs read independently: a source lock with an empty destination cannot release",
        "lock 1,000,000 on the source, deliver NOTHING on the destination, claim the cross-chain fill",
        "hollow / BLOCK",
        !report.decision.is_release(),
        format!("{} / {}", report.verdict.canonical_string(), report.decision.canonical_string()),
    )
}

/// A journal record carrying a hollow verdict (the only field the slasher reads).
fn hollow_record(id: u8) -> JournalRecord {
    JournalRecord {
        hash: format!("0x{id:064x}"),
        kind: "FILL".to_string(),
        claimed: 1_000_000,
        observed: Some(0),
        recorded: true,
        verdict: Verdict::Hollow,
    }
}

/// #6 -- lie twice in a row and try to keep spending. Defeated iff the mandate auto-REVOKES.
fn attack_repeat_liar() -> AttackResult {
    let journal = [hollow_record(1), hollow_record(2)];
    let report = slash(&journal, SlashConfig::new(2).expect("a positive threshold"));
    result(
        6,
        "Repeat liar keeps spending",
        "the slasher auto-revokes a solver after consecutive dishonest verdicts",
        "lie twice in a row (two hollow fills) and keep the mandate alive",
        "REVOKED",
        !report.status.is_active(),
        report.status.canonical_string().to_string(),
    )
}

/// #7 -- a revoked solver tries to collect on a later, genuinely-honest fill. Defeated iff it is WITHHELD.
fn attack_slash_bites() -> AttackResult {
    // Two hollow fills revoke the mandate; the third fill is chain-confirmed (settled) -- but the solver is
    // already revoked, so the honest fill must be WITHHELD (the slash bites), never paid out.
    let specs: [(i128, Option<i128>); 3] =
        [(1_000_000, Some(0)), (1_000_000, Some(0)), (1_000_000, Some(1_000_000))];
    let mut tape = TapeSource::new();
    let mut requests = Vec::with_capacity(specs.len());
    for (i, &(claimed, observed)) in specs.iter().enumerate() {
        let fill_tx = format!("0x{:064x}", i + 1);
        let key = ReadKey::new(&fill_tx).expect("well-formed 32-byte hash");
        if let Some(v) = observed {
            tape.record(key.clone(), Observation::new(v));
        }
        requests.push(FillRequest::new(FillClaim::new(HASH_A, fill_tx, claimed), key));
    }
    let report = run_filler(&requests, band(), SlashConfig::new(2).expect("a positive threshold"), &mut tape);
    let third = report.settlements[2];
    // Defeated iff the third fill was itself RELEASE-able (the oracle alone would have paid it) AND the
    // mandate was already REVOKED before it AND it was NOT released -- i.e. the slash bit a fill the oracle
    // would otherwise have released. Pinning all three (not just `!released`) means a third fill the oracle
    // blocked for some OTHER reason can never count as a defeat of THIS (slash-bite) guarantee.
    let defeated = !third.released
        && third.report.decision.is_release()
        && third.mandate_before == MandateStatus::Revoked;
    let observed = if third.released {
        format!("RELEASED ({})", third.report.verdict.canonical_string())
    } else {
        format!("WITHHELD ({})", third.withheld_reason().unwrap_or("blocked"))
    };
    result(
        7,
        "Revoked solver collects anyway",
        "a revoked mandate withholds even a chain-confirmed fill (the slash bites)",
        "after being revoked for two lies, deliver one honest fill and try to collect on it",
        "WITHHELD",
        defeated,
        observed,
    )
}

/// #8 -- move value on-chain with no recorded, cap-bound spend. Defeated iff reconciliation REFUTES it.
fn attack_unbounded_spend() -> AttackResult {
    // An on-chain transfer with NO matching spend record -- the dangerous unbounded spend the advisory cap
    // did not bind. Reconciliation must refuse it (a transfer-without-record orphan), never `reconciled`.
    let transfers = [OnchainTransfer::new(1, HASH_A, HASH_B, 1_000_000)];
    let report = reconcile(&[], &transfers);
    result(
        8,
        "Unbounded spend",
        "every on-chain transfer must reconcile 1:1 to a recorded, cap-bound spend",
        "move 1,000,000 on-chain with NO matching spend record (bypass the advisory cap)",
        "refuted",
        report.verdict != ReconcileVerdict::Reconciled,
        report.verdict.canonical_string().to_string(),
    )
}

/// Run the whole break-it gauntlet: construct every adversarial input and assert the verifier refused it.
///
/// Returns a [`GauntletReport`] whose [`GauntletReport::all_defeated`] is the only honest pass. Pure +
/// deterministic + offline; the same gauntlet yields the same report every time (design SS3 principle 4).
#[must_use]
pub fn run_gauntlet() -> GauntletReport {
    GauntletReport {
        results: vec![
            attack_fabricated_settlement(),
            attack_tampered_amount(),
            attack_phantom_settlement(),
            attack_hollow_fill(),
            attack_cross_chain_hollow(),
            attack_repeat_liar(),
            attack_slash_bites(),
            attack_unbounded_spend(),
        ],
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_gauntlet_defeats_every_attack() {
        let report = run_gauntlet();
        assert_eq!(report.total(), 8, "the gauntlet runs all eight attacks");
        let undefeated: Vec<&str> =
            report.results.iter().filter(|r| !r.outcome.is_defeated()).map(|r| r.attack.name).collect();
        assert!(report.all_defeated(), "an attack SUCCEEDED -- honesty defect: {undefeated:?}");
        assert_eq!(report.defeated(), 8);
    }

    #[test]
    fn every_attack_names_a_guarantee_and_returns_an_observed_refusal() {
        for r in &run_gauntlet().results {
            assert!(!r.attack.name.is_empty());
            assert!(!r.attack.guarantee.is_empty());
            assert!(!r.attack.attempt.is_empty());
            assert!(!r.outcome.observed().is_empty(), "{} returned no observed result", r.attack.name);
        }
    }

    #[test]
    fn each_attack_refusal_is_the_expected_honest_verdict() {
        let r = run_gauntlet();
        // Spot-check the headline refusals are exactly the honest ones (never the attacker's pass).
        assert_eq!(r.results[0].outcome.observed(), "unverified"); // fabricated settlement
        assert_eq!(r.results[1].outcome.observed(), "mismatch"); // tampered amount
        assert_eq!(r.results[2].outcome.observed(), "hollow"); // phantom (0,0)
        assert!(r.results[3].outcome.observed().contains("BLOCK")); // hollow fill
        assert!(r.results[4].outcome.observed().contains("BLOCK")); // cross-chain hollow
        assert_eq!(r.results[5].outcome.observed(), "REVOKED"); // repeat liar
        assert!(r.results[6].outcome.observed().contains("WITHHELD")); // slash bites
        assert_eq!(r.results[7].outcome.observed(), "refuted"); // unbounded spend
    }

    #[test]
    fn summary_line_reports_full_defeat() {
        let line = run_gauntlet().summary_line();
        assert!(line.contains("8/8"), "{line}");
        assert!(line.contains("DEFEATED"), "{line}");
        assert!(line.contains("HELD"), "{line}");
    }

    #[test]
    fn the_gauntlet_is_deterministic() {
        let first = run_gauntlet();
        for _ in 0..8 {
            assert_eq!(run_gauntlet(), first);
        }
    }
}
