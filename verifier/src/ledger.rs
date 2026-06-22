//! The ledger projection + the audit -- read-only views over the verdict journal.
//!
//! Design SS5a (the settlement-truth LEDGER): "`proofagent ledger` reads the journal and projects it,
//! per transaction: claimed vs chain-observed minor units, the verdict, and the exact-integer delta ...
//! It computes nothing new and mints no verdict -- it is a pure, deterministic *view* of the journalled
//! truth, in journal order." And: "`proofagent audit` reads the same journal and surfaces every
//! non-`settled` verdict -- hollow / mismatch / unverified -- LOUDLY, with a non-zero exit when any are
//! present."
//!
//! ## The ledger IS the settlement truth (design SS5a + the LEDGER doctrine)
//!
//! Both views read ONLY from the journal ([`crate::journal`]) -- never the agent's report, never the UI.
//! The journal can only contain verdicts the verifier minted (the verdict monopoly, design SS3
//! principle 2), so the ledger adds no new trust surface: it is a faithful projection of already-minted
//! truth. Neither view mints a verdict, heals a row, or downgrades a defect to success.
//!
//! ## Determinism (design SS3 principle 4)
//!
//! Every function here is pure over the input records: the projection preserves journal order, the
//! summary counts are computed by a single ordered pass, and nothing consults a clock or global state.
//! The same journal always projects to the same ledger and the same audit, byte-identically.

use crate::journal::JournalRecord;
use crate::Verdict;
use core::fmt;

/// A per-transaction ledger row -- the read-only projection of one journal record.
///
/// Design SS5a: "claimed vs chain-observed minor units, the verdict, and the exact-integer delta." This
/// is a thin, pure view; it borrows the record's fields and adds only the computed `delta`. It mints
/// nothing.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LedgerRow {
    /// The canonical `0x`-lowercase transaction hash.
    pub hash: String,
    /// The trade-kind label (journal only).
    pub kind: String,
    /// The agent's claimed amount in minor units (the **Claim**).
    pub claimed: i128,
    /// The independently-observed on-chain amount in minor units (the **Observation**), or `None`
    /// when the chain could not be read (the loud `unverified` absence).
    pub observed: Option<i128>,
    /// `claimed - observed`, exact integer, or `None` when the read was unavailable.
    pub delta: Option<i128>,
    /// Whether the hash was on-record in the corpus (vs. fabricated / unknown).
    pub recorded: bool,
    /// The minted verdict (design SS2 alphabet).
    pub verdict: Verdict,
}

impl LedgerRow {
    /// Project one journal record into a ledger row -- pure, mints nothing (design SS5a).
    #[must_use]
    pub fn from_record(rec: &JournalRecord) -> LedgerRow {
        LedgerRow {
            hash: rec.hash.clone(),
            kind: rec.kind.clone(),
            claimed: rec.claimed,
            observed: rec.observed,
            delta: rec.delta(),
            recorded: rec.recorded,
            verdict: rec.verdict,
        }
    }

    /// Render the observed amount for display: the exact integer, or the loud `unavailable`.
    #[must_use]
    pub fn observed_display(&self) -> String {
        match self.observed {
            Some(v) => v.to_string(),
            None => "unavailable".to_string(),
        }
    }

    /// Render the delta for display: the signed exact integer, or `unavailable` (never a fake `0`).
    #[must_use]
    pub fn delta_display(&self) -> String {
        match self.delta {
            Some(v) => v.to_string(),
            None => "unavailable".to_string(),
        }
    }
}

/// Project a whole journal into ledger rows, in journal order (design SS5a, deterministic).
#[must_use]
pub fn project(records: &[JournalRecord]) -> Vec<LedgerRow> {
    records.iter().map(LedgerRow::from_record).collect()
}

/// Per-verdict counts over a journal -- the ledger's summary (design SS5a §2 summary counts).
///
/// A single ordered pass; pure and deterministic. The four counts partition the journal exactly (every
/// record has exactly one of the four verdicts), so `total == settled + hollow + mismatch + unverified`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct LedgerSummary {
    /// Number of `settled` rows (the only honest success, design SS3 principle 3).
    pub settled: usize,
    /// Number of `hollow` rows.
    pub hollow: usize,
    /// Number of `mismatch` rows.
    pub mismatch: usize,
    /// Number of `unverified` rows.
    pub unverified: usize,
}

impl LedgerSummary {
    /// Tally the per-verdict counts over the records (single pass, deterministic).
    #[must_use]
    pub fn of(records: &[JournalRecord]) -> LedgerSummary {
        let mut s = LedgerSummary::default();
        for r in records {
            match r.verdict {
                Verdict::Settled => s.settled += 1,
                Verdict::Hollow => s.hollow += 1,
                Verdict::Mismatch => s.mismatch += 1,
                Verdict::Unverified => s.unverified += 1,
                // No wildcard: a new verdict variant must be counted deliberately here.
            }
        }
        s
    }

    /// Total rows.
    #[must_use]
    pub fn total(&self) -> usize {
        self.settled + self.hollow + self.mismatch + self.unverified
    }

    /// Number of *defect* rows -- everything that is not `settled` (design SS3 principle 3 / SS8).
    ///
    /// This is the audit's headline: any non-zero value means the journal carries a verdict that is
    /// NOT an honest settlement, and the audit must surface it loudly with a non-zero exit.
    #[must_use]
    pub fn defects(&self) -> usize {
        self.hollow + self.mismatch + self.unverified
    }

    /// `true` iff every row settled (zero defects). A clean journal audits GREEN.
    #[must_use]
    pub fn is_clean(&self) -> bool {
        self.defects() == 0
    }

    /// A one-line status-at-a-glance (design SS5a §2). Deterministic, no clock.
    #[must_use]
    pub fn status_line(&self) -> String {
        let status = if self.total() == 0 {
            "EMPTY"
        } else if self.is_clean() {
            "GREEN"
        } else {
            "DEFECTS"
        };
        format!(
            "{status} -- {} verdict(s): {} settled / {} hollow / {} mismatch / {} unverified ({} defect(s))",
            self.total(),
            self.settled,
            self.hollow,
            self.mismatch,
            self.unverified,
            self.defects(),
        )
    }
}

/// The audit outcome -- the defect rows surfaced loudly, with the clean/dirty verdict (design SS5a).
///
/// The audit reads the same journal as the ledger and partitions it into the `settled` rows and the
/// *defect* rows (`hollow` / `mismatch` / `unverified`). It mints nothing and heals nothing -- it only
/// reports. A non-empty `defects` means the caller must exit non-zero (design SS3 principle 3 / SS8: a
/// defect is surfaced loud, never silently counted as success).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Audit {
    /// The per-verdict summary over the whole journal.
    pub summary: LedgerSummary,
    /// The defect rows (every non-`settled` row), in journal order -- the loud surface.
    pub defects: Vec<LedgerRow>,
}

impl Audit {
    /// Run the audit over a journal: tally the summary and collect every non-`settled` row, in order.
    ///
    /// Pure and deterministic (design SS3 principle 4). Surfaces defects; never heals or downgrades one.
    #[must_use]
    pub fn of(records: &[JournalRecord]) -> Audit {
        let summary = LedgerSummary::of(records);
        let defects = records
            .iter()
            .filter(|r| !r.is_settled())
            .map(LedgerRow::from_record)
            .collect();
        Audit { summary, defects }
    }

    /// `true` iff the journal is clean (no defect rows). A clean audit exits zero; a dirty one must
    /// exit non-zero (design SS3 principle 3 / SS8).
    #[must_use]
    pub fn is_clean(&self) -> bool {
        self.defects.is_empty()
    }
}

/// A loud, deterministic reason describing a single defect row, for the audit's surface.
///
/// Design SS8 (zero-loss): a defect must be surfaced LOUD and explained -- never silently counted as a
/// success. This renders why a given non-`settled` row failed, for the human-readable audit output.
pub fn defect_reason(row: &LedgerRow) -> &'static str {
    match row.verdict {
        Verdict::Settled => "settled (not a defect)",
        Verdict::Hollow => "HOLLOW: the tx is on-record but moved nothing (no economic effect)",
        Verdict::Mismatch => "MISMATCH: the chain-observed amount disagrees with the claim beyond tolerance",
        Verdict::Unverified => {
            "UNVERIFIED: the chain could not confirm the claim (off-record / unreadable / fabricated hash)"
        }
    }
}

impl fmt::Display for Audit {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        writeln!(f, "{}", self.summary.status_line())?;
        if self.defects.is_empty() {
            return write!(f, "audit GREEN -- every journalled verdict is `settled` (zero-loss).");
        }
        writeln!(f, "DEFECTS (surfaced loud -- never counted as success):")?;
        for d in &self.defects {
            writeln!(
                f,
                "  {} {} claimed={} observed={} delta={} -> {} :: {}",
                d.kind,
                d.hash,
                d.claimed,
                d.observed_display(),
                d.delta_display(),
                d.verdict.canonical_string(),
                defect_reason(d),
            )?;
        }
        write!(f, "audit RED -- {} defect(s) present; this is NOT a clean settlement record.", self.defects.len())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::journal::JournalRecord;
    use crate::VerifyReport;

    fn rec(kind: &str, claimed: i128, observed: Option<i128>, recorded: bool, verdict: Verdict) -> JournalRecord {
        JournalRecord::from_report(&VerifyReport {
            hash: format!("0x{:064x}", claimed.max(1) as u128),
            kind: kind.to_string(),
            claimed,
            observed,
            recorded,
            verdict,
        })
    }

    #[test]
    fn project_preserves_order_and_computes_delta() {
        let recs = vec![
            rec("TRANSFER", 1_000_000, Some(1_000_000), true, Verdict::Settled),
            rec("BUY", 1_000, Some(1_300), true, Verdict::Mismatch),
            rec("FAKE", 0, None, false, Verdict::Unverified),
        ];
        let rows = project(&recs);
        assert_eq!(rows.len(), 3);
        assert_eq!(rows[0].delta, Some(0));
        assert_eq!(rows[0].verdict, Verdict::Settled);
        assert_eq!(rows[1].delta, Some(-300));
        assert_eq!(rows[2].delta, None, "unavailable read -> no delta");
        assert_eq!(rows[2].observed_display(), "unavailable");
        assert_eq!(rows[2].delta_display(), "unavailable");
    }

    #[test]
    fn summary_partitions_the_journal_exactly() {
        let recs = vec![
            rec("A", 1, Some(1), true, Verdict::Settled),
            rec("B", 2, Some(2), true, Verdict::Settled),
            rec("C", 0, Some(0), true, Verdict::Hollow),
            rec("D", 3, Some(9), true, Verdict::Mismatch),
            rec("E", 0, None, false, Verdict::Unverified),
        ];
        let s = LedgerSummary::of(&recs);
        assert_eq!(s.settled, 2);
        assert_eq!(s.hollow, 1);
        assert_eq!(s.mismatch, 1);
        assert_eq!(s.unverified, 1);
        assert_eq!(s.total(), 5);
        assert_eq!(s.defects(), 3);
        assert!(!s.is_clean());
        assert!(s.status_line().starts_with("DEFECTS"));
    }

    #[test]
    fn a_clean_journal_audits_green_and_is_clean() {
        let recs = vec![
            rec("TRANSFER", 1_000_000, Some(1_000_000), true, Verdict::Settled),
            rec("TRANSFER", 1_000_000, Some(1_000_000), true, Verdict::Settled),
        ];
        let audit = Audit::of(&recs);
        assert!(audit.is_clean());
        assert!(audit.defects.is_empty());
        assert_eq!(audit.summary.settled, 2);
        assert!(audit.summary.status_line().starts_with("GREEN"));
        assert!(audit.to_string().contains("audit GREEN"));
    }

    #[test]
    fn audit_surfaces_every_defect_loudly_and_is_not_clean() {
        // The NEG row (unverified) + a mismatch must BOTH surface; the audit must NOT be clean.
        let recs = vec![
            rec("TRANSFER", 1_000_000, Some(1_000_000), true, Verdict::Settled),
            rec("FAKE", 0, None, false, Verdict::Unverified),
            rec("BUY", 1_000, Some(1_300), true, Verdict::Mismatch),
        ];
        let audit = Audit::of(&recs);
        assert!(!audit.is_clean(), "a journal with any non-settled row is NOT clean");
        assert_eq!(audit.defects.len(), 2);
        // Order preserved: the unverified row comes before the mismatch row.
        assert_eq!(audit.defects[0].verdict, Verdict::Unverified);
        assert_eq!(audit.defects[1].verdict, Verdict::Mismatch);
        let text = audit.to_string();
        assert!(text.contains("audit RED"));
        assert!(text.contains("UNVERIFIED"));
        assert!(text.contains("MISMATCH"));
    }

    #[test]
    fn empty_journal_status_is_empty_and_clean() {
        let audit = Audit::of(&[]);
        assert!(audit.is_clean(), "an empty journal has no defects");
        assert_eq!(audit.summary.total(), 0);
        assert!(audit.summary.status_line().starts_with("EMPTY"));
    }

    #[test]
    fn ledger_views_are_deterministic() {
        let recs = vec![
            rec("TRANSFER", 1_000_000, Some(1_000_000), true, Verdict::Settled),
            rec("BUY", 1_000, Some(1_300), true, Verdict::Mismatch),
        ];
        let first_rows = project(&recs);
        let first_audit = Audit::of(&recs);
        for _ in 0..8 {
            assert_eq!(project(&recs), first_rows);
            assert_eq!(Audit::of(&recs), first_audit);
            assert_eq!(LedgerSummary::of(&recs).status_line(), first_audit.summary.status_line());
        }
    }

    #[test]
    fn defect_reason_is_specific_per_verdict() {
        let m = LedgerRow::from_record(&rec("B", 1_000, Some(1_300), true, Verdict::Mismatch));
        assert!(defect_reason(&m).contains("MISMATCH"));
        let h = LedgerRow::from_record(&rec("S", 0, Some(0), true, Verdict::Hollow));
        assert!(defect_reason(&h).contains("HOLLOW"));
        let u = LedgerRow::from_record(&rec("F", 0, None, false, Verdict::Unverified));
        assert!(defect_reason(&u).contains("UNVERIFIED"));
    }
}
