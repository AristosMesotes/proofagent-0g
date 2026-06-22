//! The verdict type -- the single most load-bearing type in the system.
//!
//! Design SS2 (the three proofs / settlement): the verifier reads the chain and stamps each
//! trade `settled / hollow / mismatch / unverified`. Those four are the entire verdict alphabet.
//!
//! Design SS3 principle 2 (verdict monopoly): "Only the verifier mints a verdict
//! (`settled / hollow / mismatch / unverified`). The agent, the LLM, and the web UI produce
//! claims and facts -- never a verdict. The verdict type's constructor is private to the verifier
//! crate."
//!
//! ## How the monopoly is enforced
//!
//! `Verdict` is a public, non-exhaustive enum so downstream code can *read*, *match*, and *Display*
//! a verdict -- but its variants cannot be *constructed* outside this crate:
//!
//! - The enum is `#[non_exhaustive]`, so external crates may not build a variant by literal
//!   (e.g. `Verdict::Settled` from outside is a compile error) nor exhaustively match without a
//!   wildcard arm.
//! - The only way to obtain a `Verdict` is a `pub(crate)` minting function below. Minting is
//!   therefore reachable only from inside the `verifier` crate -- the verdict monopoly.
//!
//! Per design SS3 principle 3 (never fabricate): an unavailable / unreadable result degrades
//! *loudly* to `Unverified` -- never silently to `Settled`. There is no `Default` impl precisely so
//! that "absence of a read" can never collapse into a fabricated success.

use core::fmt;

/// A settlement verdict minted by the verifier.
///
/// These are the only four outcomes (design SS2). The enum is `#[non_exhaustive]`: only the
/// `verifier` crate can mint a value (design SS3 principle 2, verdict monopoly).
#[non_exhaustive]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Verdict {
    /// The trade settled on-chain exactly as claimed (the money really moved, amounts match).
    Settled,
    /// The transaction exists and succeeded, but the expected economic effect is absent
    /// (a "hollow" success -- e.g. a receipt with no matching transfer / value).
    Hollow,
    /// The transaction settled, but the observed amount disagrees with the claim beyond tolerance.
    Mismatch,
    /// The chain could not confirm the claim (not found / unreadable / off-record).
    ///
    /// Per design SS3 principle 3 this is the *loud, honest* degrade target -- never a silent
    /// `Settled`. The NEG case (a fabricated hash) lands here.
    Unverified,
}

impl Verdict {
    /// The canonical, stable, snake_case string for this verdict.
    ///
    /// This is the wire/journal form. It is deterministic (design SS3 principle 4): the same
    /// verdict always renders to the same bytes, with no wall-clock and no locale.
    #[must_use]
    pub const fn canonical_string(&self) -> &'static str {
        match self {
            Verdict::Settled => "settled",
            Verdict::Hollow => "hollow",
            Verdict::Mismatch => "mismatch",
            Verdict::Unverified => "unverified",
            // No wildcard arm: adding a variant must force a deliberate canonical string here.
        }
    }

    /// `true` only for `Settled`. Convenience for the honest "did it really happen?" check
    /// without re-implementing the match (and without tempting callers to treat anything else
    /// as success).
    #[must_use]
    pub const fn is_settled(&self) -> bool {
        matches!(self, Verdict::Settled)
    }
}

impl fmt::Display for Verdict {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.canonical_string())
    }
}

// ---------------------------------------------------------------------------------------------
// The minting surface -- `pub(crate)` ONLY. This is the verdict monopoly (design SS3 principle 2).
// Adjudication logic inside the verifier crate calls these; nothing outside the crate can.
// ---------------------------------------------------------------------------------------------

// The minting functions are the verdict monopoly: crate-private constructors that only in-crate
// code may call. STEP VS2's `adjudicate(Claim, Observation)` (design SS3 principle 1) calls all four
// in the non-test build, so they are live -- no `dead_code` allowance is needed.
impl Verdict {
    /// Mint `Settled`. Crate-private: only the verifier may decide a trade settled.
    pub(crate) const fn settled() -> Verdict {
        Verdict::Settled
    }

    /// Mint `Hollow`. Crate-private.
    pub(crate) const fn hollow() -> Verdict {
        Verdict::Hollow
    }

    /// Mint `Mismatch`. Crate-private.
    pub(crate) const fn mismatch() -> Verdict {
        Verdict::Mismatch
    }

    /// Mint `Unverified`. Crate-private. The loud, honest degrade target (design SS3 principle 3).
    pub(crate) const fn unverified() -> Verdict {
        Verdict::Unverified
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn canonical_strings_are_exact_snake_case() {
        // Design SS2: the four-verdict alphabet, in its canonical snake_case journal form.
        assert_eq!(Verdict::settled().canonical_string(), "settled");
        assert_eq!(Verdict::hollow().canonical_string(), "hollow");
        assert_eq!(Verdict::mismatch().canonical_string(), "mismatch");
        assert_eq!(Verdict::unverified().canonical_string(), "unverified");
    }

    #[test]
    fn display_matches_canonical_string() {
        for v in [
            Verdict::settled(),
            Verdict::hollow(),
            Verdict::mismatch(),
            Verdict::unverified(),
        ] {
            assert_eq!(format!("{v}"), v.canonical_string());
        }
    }

    #[test]
    fn canonical_string_is_deterministic() {
        // Design SS3 principle 4 (deterministic): same verdict -> byte-identical string, every call.
        let a = Verdict::settled().canonical_string();
        let b = Verdict::settled().canonical_string();
        assert_eq!(a, b);
        // And a borrow-independent repeat across a fresh value.
        assert_eq!(Verdict::mismatch().canonical_string(), Verdict::mismatch().canonical_string());
    }

    #[test]
    fn all_four_strings_are_distinct() {
        let strings = [
            Verdict::settled().canonical_string(),
            Verdict::hollow().canonical_string(),
            Verdict::mismatch().canonical_string(),
            Verdict::unverified().canonical_string(),
        ];
        for i in 0..strings.len() {
            for j in (i + 1)..strings.len() {
                assert_ne!(strings[i], strings[j], "verdict strings must be distinct");
            }
        }
    }

    #[test]
    fn is_settled_only_for_settled() {
        // Design SS3 principle 3: nothing but Settled may read as success.
        assert!(Verdict::settled().is_settled());
        assert!(!Verdict::hollow().is_settled());
        assert!(!Verdict::mismatch().is_settled());
        assert!(!Verdict::unverified().is_settled());
    }

    #[test]
    fn strings_are_lowercase_snake_case() {
        for v in [
            Verdict::settled(),
            Verdict::hollow(),
            Verdict::mismatch(),
            Verdict::unverified(),
        ] {
            let s = v.canonical_string();
            assert!(!s.is_empty());
            assert!(
                s.chars().all(|c| c.is_ascii_lowercase() || c == '_'),
                "canonical string {s:?} must be lowercase snake_case"
            );
        }
    }
}
