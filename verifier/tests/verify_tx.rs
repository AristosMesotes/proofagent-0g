//! Integration test for the verify-tx leg (design SS5 the loop · SS2 settlement proof + the NEG case).
//!
//! These exercise the crate's PUBLIC surface exactly as the `verifier verify-tx` binary does: parse a
//! data spine into a [`SpineConfig`], bind the offline [`verifier::TapeSource`] it describes, and run
//! [`verifier::verify_tx`] to mint a [`verifier::Verdict`]. The headline case is a tape that yields a
//! `Settled`; the **NEG case** (design SS2, STEP VS5 -- the hero invariant) proves that pointing the
//! verifier at a *fabricated* hash, or at a recorded claim whose chain read is unavailable, degrades
//! *loudly* to `Unverified`, NEVER a fabricated `Settled` (design SS3 principle 3).

use verifier::{verify_tx, Source, SpineConfig, Verdict, VerifyError};

const HASH_SETTLED: &str = "0xabc0000000000000000000000000000000000000000000000000000000000001";
const HASH_OFFTAPE: &str = "0xdef0000000000000000000000000000000000000000000000000000000000002";
// A wholly fabricated hash that appears in NO corpus entry -- the NEG case the demo points at.
const HASH_FABRICATED: &str = "0x1110000000000000000000000000000000000000000000000000000000000003";

/// A spine whose single corpus entry records BOTH a claim (1000) and an independent on-chain read
/// (1100) -- within the 15% band -- so the offline tape replays a genuine settlement. A second entry
/// records a claim with NO observed read (the off-tape NEG case).
fn settling_spine() -> SpineConfig {
    let text = format!(
        "\
[chain]
id = 16661

[verifier.tolerance]
num = 15
den = 100

[[verifier.corpus]]
kind = \"BUY\"
hash = \"{HASH_SETTLED}\"
claimed = \"1000\"
observed = \"1100\"

[[verifier.corpus]]
kind = \"SELL\"
hash = \"{HASH_OFFTAPE}\"
claimed = \"1000\"
"
    );
    SpineConfig::parse(&text).expect("the integration spine is well-formed")
}

#[test]
fn verify_tx_against_a_tape_yields_settled() {
    // THE STEP'S REQUIRED TEST: a Tape (built from the spine's recorded read) yields a SETTLED.
    let config = settling_spine();
    let mut tape = config.tape_source();
    let report = verify_tx(HASH_SETTLED, &config, &mut tape as &mut dyn Source)
        .expect("a recorded claim adjudicates to a verdict");

    assert_eq!(report.verdict, Verdict::Settled, "in-band recorded read must settle");
    assert_eq!(report.verdict_string(), "settled");
    assert_eq!(report.kind, "BUY");
    assert_eq!(report.claimed, 1_000);
    assert_eq!(report.observed, Some(1_100));
    assert_eq!(report.hash, HASH_SETTLED);
}

#[test]
fn verify_tx_recorded_claim_with_unavailable_read_is_unverified_not_settled() {
    // The other NEG sub-case (design SS2): a claim IS on-record, but the chain read is off-tape (no
    // recorded `observed`). The honest degrade is still UNVERIFIED -- NEVER a fabricated SETTLED
    // (design SS3 principle 3). Unlike the fabricated-hash case, this one is `recorded == true`.
    let config = settling_spine();
    let mut tape = config.tape_source();
    let report = verify_tx(HASH_OFFTAPE, &config, &mut tape as &mut dyn Source).unwrap();

    assert_eq!(report.verdict, Verdict::Unverified);
    assert_eq!(report.observed, None);
    assert_ne!(report.verdict, Verdict::Settled);
    assert!(report.recorded, "the claim was on-record; only the independent read was unavailable");
}

#[test]
fn verify_tx_fabricated_hash_stamps_unverified_never_settled() {
    // ===========================================================================================
    // THE HERO INVARIANT (design SS2, the NEG case; STEP VS5). The single most important demo:
    // point the verifier at a FABRICATED transaction hash -- one that appears in NO corpus entry --
    // and it stamps UNVERIFIED. It is reading the chain (its on-record corpus + independent read),
    // not rubber-stamping: with nothing on-record confirming a settlement, the only honest verdict
    // is `unverified`. It must NEVER be a fabricated `settled` (design SS3 principle 3).
    // ===========================================================================================
    let config = settling_spine();
    let mut tape = config.tape_source();
    let report = verify_tx(HASH_FABRICATED, &config, &mut tape as &mut dyn Source)
        .expect("a fabricated hash is a verdict (Unverified), not a usage error");

    assert_eq!(report.verdict, Verdict::Unverified, "a fabricated hash MUST stamp Unverified");
    assert_eq!(report.verdict_string(), "unverified");
    assert_ne!(report.verdict, Verdict::Settled, "a fabricated hash must NEVER read as settled");
    assert!(!report.recorded, "a fabricated hash is off-record (no corpus claim)");
    assert_eq!(report.observed, None, "no adjudicable observation for an unrecorded claim");
    assert_eq!(report.claimed, 0, "no claim is recorded for a fabricated hash");
    assert_eq!(report.kind, verifier::UNKNOWN_KIND, "the journal marks it `unknown`, not a trade");
    assert_eq!(report.hash, HASH_FABRICATED, "the canonical hash is echoed for the journal");
}

#[test]
fn verify_tx_fabricated_hash_cannot_be_settled_even_by_a_stray_tape_reading() {
    // Adversarial NEG case: even if the offline tape happens to carry a reading keyed by the
    // fabricated hash, there is NO recorded claim to adjudicate against -- so the verifier still
    // stamps UNVERIFIED, never `settled`. A stray observation cannot manufacture a settlement out of
    // a hash the corpus never claimed (design SS2 + SS3 principle 3, never fabricate).
    let config = settling_spine();
    let mut tape = config.tape_source();
    // Plant a reading on the tape for the fabricated hash -- the corpus still has no claim for it.
    tape.record(
        verifier::ReadKey::new(HASH_FABRICATED).unwrap(),
        verifier::Observation::new(1_000),
    );
    let report = verify_tx(HASH_FABRICATED, &config, &mut tape as &mut dyn Source).unwrap();
    assert_eq!(report.verdict, Verdict::Unverified, "no claim -> Unverified, stray reading or not");
    assert_ne!(report.verdict, Verdict::Settled);
    assert!(!report.recorded);
    assert_eq!(report.observed, None, "an unrecorded claim never reads a tape observation");
}

#[test]
fn verify_tx_malformed_hash_is_the_only_usage_error() {
    // A string that is not a 32-byte transaction hash AT ALL is the one remaining usage error
    // (`BadHash`) -- distinct from the `unverified` NEG case. The verifier cannot point a non-hash at
    // the chain, so it never prints a verdict for it; it surfaces a loud usage failure instead.
    let config = settling_spine();
    let mut tape = config.tape_source();
    let err = verify_tx("0xnot-a-hash", &config, &mut tape as &mut dyn Source).unwrap_err();
    assert!(matches!(err, VerifyError::BadHash { .. }), "a non-hash string is BadHash");
}

#[test]
fn verify_tx_is_deterministic_across_repeated_runs() {
    // Design SS3 principle 4: the same spine + the same hash reproduce a byte-identical report.
    let config = settling_spine();
    let mut first_tape = config.tape_source();
    let first = verify_tx(HASH_SETTLED, &config, &mut first_tape as &mut dyn Source).unwrap();
    for _ in 0..8 {
        let mut tape = config.tape_source();
        let again = verify_tx(HASH_SETTLED, &config, &mut tape as &mut dyn Source).unwrap();
        assert_eq!(again, first, "same inputs -> identical report");
    }
}
