//! The SLASHABLE MANDATE -- `slash(...)`: an honesty scoreboard over the settlement-truth journal that
//! AUTO-REVOKES the mandate after N consecutive DISHONEST verdicts. It converts honesty into *enforced
//! economics* -- the reputation gap the cross-chain intents market (LI.FI etc.) leaves open: a dishonest
//! solver keeps its mandate. ProofAgent slashes it.
//!
//! ## Honest by construction (design SS3 principle 1 / 2)
//!
//! The slasher reads ONLY the verifier's OWN minted verdicts (the journal -- never the agent's word). A
//! `settled` is demonstrated HONESTY (the chain confirmed the claim). A `hollow` / `mismatch` is
//! demonstrated DISHONESTY (the chain disagrees with the claim). An `unverified` is UNDETERMINED (the
//! verifier could not read it). The slash streak is the **trailing run of consecutive dishonest
//! verdicts**: a `hollow` / `mismatch` increments it, and ANY other verdict (`settled` proving honesty,
//! or `unverified` -- undetermined, not proof of dishonesty) BREAKS it. So only an UNBROKEN run of
//! demonstrated dishonesty slashes -- never an honest agent, never an unreadable gap.
//!
//! ## The decision is structural (design SS3 principle 3, never softened)
//!
//! At `streak >= revoke_after` the mandate is [`MandateStatus::Revoked`] -- a loud, deterministic
//! decision. The slasher mints no settlement verdict (it consumes them); it only projects the journal
//! into a standing. Pure + deterministic: same journal + same threshold => same standing, no clock, no
//! float.

use crate::{JournalRecord, Verdict};
use core::fmt;

/// How many consecutive dishonest verdicts (`hollow` / `mismatch`) revoke the mandate.
///
/// The field is private so a `SlashConfig` can only be built through [`SlashConfig::new`], which rejects
/// `0` -- a zero threshold would revoke a mandate that has shown NO dishonesty (even an empty journal),
/// which is not a slash, it is a misconfiguration.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct SlashConfig {
    revoke_after: u32,
}

impl SlashConfig {
    /// Build a slash threshold of `revoke_after` consecutive dishonest verdicts. `None` for `0` (a
    /// zero threshold would revoke with no demonstrated dishonesty -- a misconfiguration, not a slash).
    #[must_use]
    pub const fn new(revoke_after: u32) -> Option<SlashConfig> {
        if revoke_after == 0 {
            return None;
        }
        Some(SlashConfig { revoke_after })
    }

    /// The configured threshold (always `>= 1` by construction).
    #[must_use]
    pub const fn revoke_after(&self) -> u32 {
        self.revoke_after
    }
}

/// The mandate's standing under the slasher.
///
/// `#[non_exhaustive]` so a future standing forces a deliberate match; derived purely from the trailing
/// dishonest streak vs the threshold (see [`slash`]).
#[non_exhaustive]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum MandateStatus {
    /// The mandate stands -- the trailing dishonest streak is below the revoke threshold.
    Active,
    /// The mandate is AUTO-REVOKED -- the trailing dishonest streak reached the threshold. Loud.
    Revoked,
}

impl MandateStatus {
    /// The canonical, stable, UPPERCASE string (deterministic; design SS3 principle 4).
    #[must_use]
    pub const fn canonical_string(&self) -> &'static str {
        match self {
            MandateStatus::Active => "ACTIVE",
            MandateStatus::Revoked => "REVOKED",
        }
    }

    /// `true` only for `Active`. The honest "may the agent still spend?" check.
    #[must_use]
    pub const fn is_active(&self) -> bool {
        matches!(self, MandateStatus::Active)
    }
}

impl fmt::Display for MandateStatus {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.canonical_string())
    }
}

/// The slasher's report over a journal: the mandate standing, the trailing dishonest streak vs the
/// threshold, and the per-verdict counts (the honesty scoreboard).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SlashReport {
    /// The mandate standing (ACTIVE / REVOKED).
    pub status: MandateStatus,
    /// The trailing run of consecutive dishonest verdicts (`hollow` / `mismatch`).
    pub consecutive_dishonest: u32,
    /// The configured revoke threshold.
    pub revoke_after: u32,
    /// Total verdicts in the journal.
    pub total: usize,
    /// Count of `settled` verdicts (demonstrated honesty).
    pub settled: usize,
    /// Count of `hollow` verdicts (demonstrated dishonesty).
    pub hollow: usize,
    /// Count of `mismatch` verdicts (demonstrated dishonesty).
    pub mismatch: usize,
    /// Count of `unverified` verdicts (undetermined).
    pub unverified: usize,
}

impl SlashReport {
    /// A single, human-readable status line for the journal/CLI (deterministic).
    #[must_use]
    pub fn status_line(&self) -> String {
        format!(
            "slash: status={} streak={}/{} (settled={} hollow={} mismatch={} unverified={} over {} verdicts)",
            self.status,
            self.consecutive_dishonest,
            self.revoke_after,
            self.settled,
            self.hollow,
            self.mismatch,
            self.unverified,
            self.total,
        )
    }
}

/// Project a settlement journal into a mandate standing: REVOKE after `config.revoke_after` consecutive
/// dishonest verdicts (`hollow` / `mismatch`). Pure, deterministic, reads only the verifier's verdicts.
///
/// The trailing dishonest streak counts backward from the most recent verdict: a `hollow` / `mismatch`
/// increments it; ANY other verdict (`settled` / `unverified`) breaks it. The mandate is REVOKED iff the
/// streak reached the threshold -- a structural, never-softened decision (design SS3 principle 3).
#[must_use]
pub fn slash(records: &[JournalRecord], config: SlashConfig) -> SlashReport {
    // Per-verdict counts -- the honesty scoreboard (one ordered pass, no clock, no global state).
    let (mut settled, mut hollow, mut mismatch, mut unverified) = (0usize, 0usize, 0usize, 0usize);
    for r in records {
        match r.verdict {
            Verdict::Settled => settled += 1,
            Verdict::Hollow => hollow += 1,
            Verdict::Mismatch => mismatch += 1,
            Verdict::Unverified => unverified += 1,
            // No wildcard: a new verdict variant must force a deliberate tally here.
        }
    }

    // The trailing run of consecutive dishonest verdicts: count backward, stop at the first non-dishonest
    // verdict (settled proves honesty; unverified is undetermined -- neither resets to slash nor counts).
    let mut streak: u32 = 0;
    for r in records.iter().rev() {
        match r.verdict {
            Verdict::Hollow | Verdict::Mismatch => streak += 1,
            _ => break,
        }
    }

    let status = if streak >= config.revoke_after {
        MandateStatus::Revoked
    } else {
        MandateStatus::Active
    };

    SlashReport {
        status,
        consecutive_dishonest: streak,
        revoke_after: config.revoke_after,
        total: records.len(),
        settled,
        hollow,
        mismatch,
        unverified,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Build a journal record carrying a given verdict (the only field the slasher reads). The
    /// `JournalRecord` fields are public, so we construct one directly -- varying only the verdict.
    fn rec(verdict: Verdict) -> JournalRecord {
        let observed = match verdict {
            Verdict::Settled => Some(1_000),
            Verdict::Hollow => Some(0),
            Verdict::Mismatch => Some(10_000),
            Verdict::Unverified => None,
        };
        JournalRecord {
            hash: "0x8c59d0e8beabc492f24e1726903388a852c964137790c47920b2cbbe3ef5bfb0".to_string(),
            kind: "BUY".to_string(),
            claimed: 1_000,
            observed,
            recorded: true,
            verdict,
        }
    }

    fn after(n: u32) -> SlashConfig {
        SlashConfig::new(n).expect("a positive threshold")
    }

    #[test]
    fn config_rejects_zero_threshold() {
        // A 0 threshold would revoke with NO demonstrated dishonesty -- a misconfiguration.
        assert_eq!(SlashConfig::new(0), None);
        assert_eq!(after(2).revoke_after(), 2);
    }

    #[test]
    fn empty_journal_is_active() {
        let r = slash(&[], after(2));
        assert_eq!(r.status, MandateStatus::Active);
        assert_eq!(r.consecutive_dishonest, 0);
        assert!(r.status.is_active());
    }

    #[test]
    fn an_honest_journal_is_active() {
        let j = [rec(Verdict::Settled), rec(Verdict::Settled), rec(Verdict::Settled)];
        let r = slash(&j, after(2));
        assert_eq!(r.status, MandateStatus::Active);
        assert_eq!(r.consecutive_dishonest, 0);
        assert_eq!(r.settled, 3);
    }

    #[test]
    fn one_hollow_is_below_threshold_active() {
        let j = [rec(Verdict::Settled), rec(Verdict::Hollow)];
        let r = slash(&j, after(2));
        assert_eq!(r.status, MandateStatus::Active, "1 < 2 -> still active");
        assert_eq!(r.consecutive_dishonest, 1);
    }

    #[test]
    fn two_consecutive_dishonest_revokes_the_kill_demo() {
        // THE KILLER DEMO: two hollow fills in a row -> the mandate is AUTO-REVOKED.
        let j = [rec(Verdict::Settled), rec(Verdict::Hollow), rec(Verdict::Hollow)];
        let r = slash(&j, after(2));
        assert_eq!(r.status, MandateStatus::Revoked, "2 consecutive dishonest -> REVOKED");
        assert_eq!(r.consecutive_dishonest, 2);
        assert!(!r.status.is_active(), "a revoked agent can no longer spend");
    }

    #[test]
    fn mixed_dishonest_streak_revokes() {
        // hollow then mismatch (both dishonest, consecutive) reaches the threshold.
        let j = [rec(Verdict::Hollow), rec(Verdict::Mismatch)];
        let r = slash(&j, after(2));
        assert_eq!(r.status, MandateStatus::Revoked);
        assert_eq!(r.consecutive_dishonest, 2);
    }

    #[test]
    fn a_settled_breaks_the_streak() {
        // hollow, settled, hollow -> the trailing run is just the last hollow (the settled broke it).
        let j = [rec(Verdict::Hollow), rec(Verdict::Settled), rec(Verdict::Hollow)];
        let r = slash(&j, after(2));
        assert_eq!(r.status, MandateStatus::Active, "an honest settlement breaks the dishonest run");
        assert_eq!(r.consecutive_dishonest, 1);
    }

    #[test]
    fn a_trailing_settled_resets_to_zero() {
        // Two dishonest then an honest settlement at the end -> streak 0 (the agent redeemed itself).
        let j = [rec(Verdict::Hollow), rec(Verdict::Hollow), rec(Verdict::Settled)];
        let r = slash(&j, after(2));
        assert_eq!(r.status, MandateStatus::Active);
        assert_eq!(r.consecutive_dishonest, 0);
    }

    #[test]
    fn an_unverified_breaks_the_streak_undetermined_never_slashes() {
        // hollow, unverified, hollow -> the trailing run is just the last hollow; the unverified (the
        // verifier could not read) is undetermined -- it never counts toward a slash.
        let j = [rec(Verdict::Hollow), rec(Verdict::Unverified), rec(Verdict::Hollow)];
        let r = slash(&j, after(2));
        assert_eq!(r.status, MandateStatus::Active);
        assert_eq!(r.consecutive_dishonest, 1);
        assert_eq!(r.unverified, 1);
    }

    #[test]
    fn slash_is_deterministic() {
        let j = [rec(Verdict::Hollow), rec(Verdict::Hollow)];
        for _ in 0..8 {
            assert_eq!(slash(&j, after(2)).status, MandateStatus::Revoked);
        }
    }

    #[test]
    fn status_line_renders_the_scoreboard() {
        let j = [rec(Verdict::Hollow), rec(Verdict::Hollow)];
        let line = slash(&j, after(2)).status_line();
        assert!(line.contains("REVOKED"));
        assert!(line.contains("streak=2/2"));
        assert!(line.contains("hollow=2"));
    }
}
