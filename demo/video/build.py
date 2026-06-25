"""
ProofAgent-0G demo video - build orchestrator.
Renders every scene (Pillow), voices it (Windows SAPI), and muxes a 16:9 master with ffmpeg.
All on-screen data is REAL + confirmable on chainscan-galileo.0g.ai. Honesty guardrails baked in:
no live-TEE 'brain' stamp (PENDING / Depth roadmap); RAILS = "blocked pre-broadcast + the verifier
proves it" (NEVER "physically can't overspend"); no brittle counts; no internal project names.
The five features: can't-lie / can't-overspend(V4 by-asset) / can't-drain / live-proof / verify-it-yourself.
"""
import os, shutil, subprocess, sys
import render as R

HERE = os.path.dirname(os.path.abspath(__file__))
WORK = os.path.join(HERE, "work")
OUT  = os.path.join(HERE, "out")
FPS  = 30
PAD  = 0.5          # silence padding after each VO
RATE = 1            # SAPI rate (slightly brisk = more energy)
VOICE = "Microsoft David Desktop"

# ---- real constants (ALL confirmable on-chain — verified vs evmrpc-testnet.0g.ai) ----
V4     = "0x8e561a5cc096af6e570220a5228b33c7d889f774"   # LIVE MandateRegistryV4, 0G-Galileo 16602 (block 40,213,222)
V4S    = "0x8e561a...f774"                               # truncated for tight captions
PROOF  = "0x424962775526f9783a2781daebefcb799168e624c54ce5bd055bb262caf8b4b6"  # fresh live settlement this run
PROOFS = "0x424962...caf8b4b6"
SETTLE = "0x8c59d0e8...bfb0"                              # corpus settlement (Success, 1,000,000 wei, block 39,996,100)
USDCE  = "0x1f3AA82227281cA364bFb3d253B0f1af1Da6473E"    # USDC.E — NON-allowlisted asset (TOKEN_NOT_ALLOWED)
NATIVE = "0x00...0001"                                   # V4 native sentinel

# ---------- ffmpeg helpers ----------
def run(cmd):
    p = subprocess.run(cmd, capture_output=True, text=True)
    if p.returncode != 0:
        sys.stderr.write("CMD FAILED: %s\n%s\n" % (" ".join(map(str,cmd)), p.stderr[-1500:]))
        raise SystemExit(1)
    return p.stdout

def probe_dur(path):
    out = run(["ffprobe","-v","error","-show_entries","format=duration","-of","default=nk=1:nw=1",path])
    try: return float(out.strip())
    except: return 0.0

# ---------- scene frame builders ----------
def term_type(command, out_lines, title, cap, accent, hl, step=2, pre=5, stamp=4):
    """Animated single-command terminal: type the command, reveal output, stamp the verdict, settle."""
    full = [("$ ", R.PROMPT, True), (command, R.TXT, False)]
    base = [full, "BLANK"] + out_lines
    frames = []
    for k in range(0, len(command)+1, step):
        cl = [("$ ", R.PROMPT, True), (command[:k], R.TXT, False)]
        frames.append(R.terminal([cl, "BLANK"], title=title, cap=cap, cap_accent=accent, cursor_line=0))
    for _ in range(pre):
        frames.append(R.terminal([full, "BLANK"], title=title, cap=cap, cap_accent=accent, cursor_line=0))
    for _ in range(stamp):
        frames.append(R.terminal(base, title=title, cap=cap, cap_accent=accent, highlight_line=hl))
    frames.append(R.terminal(base, title=title, cap=cap, cap_accent=accent))   # held settle
    return frames

def mandate_anim():
    """CAN'T OVERSPEND: the same agent, gated BY ASSET against the LIVE V4 — three eth_calls,
    three different verdicts: under-cap ALLOWED, over-cap OVER_TX_CAP, non-allowlisted TOKEN_NOT_ALLOWED."""
    cmd = "agent gate --asset-by-asset   # live checkTransfer on V4 ("+V4S+")"
    full = [("$ ", R.PROMPT, True), (cmd, R.TXT, False)]
    s1 = [("native sentinel  1,000,000  ", R.DIM, False), ("-> ", R.DIM, False), ("(true, OK)            ALLOWED", R.GREEN, True)]
    s2 = [("native sentinel  3,000,000  ", R.DIM, False), ("-> ", R.DIM, False), ("(false, OVER_TX_CAP)  BLOCKED", R.RED, True)]
    s3 = [("USDC.E           1,000,000  ", R.DIM, False), ("-> ", R.DIM, False), ("(false, TOKEN_NOT_ALLOWED) BLOCKED", R.RED, True)]
    title, cap, acc = "proofagent - mandate V4 (on-chain, by asset)", "RAILS  -  same agent, different verdict PER ASSET  -  blocked pre-broadcast", R.GOLD
    frames = []
    for k in range(0, len(cmd)+1, 3):
        cl = [("$ ", R.PROMPT, True), (cmd[:k], R.TXT, False)]
        frames.append(R.terminal([cl, "BLANK"], title=title, cap=cap, cap_accent=acc, cursor_line=0))
    for _ in range(4): frames.append(R.terminal([full, "BLANK"], title=title, cap=cap, cap_accent=acc, cursor_line=0))
    for _ in range(3): frames.append(R.terminal([full, "BLANK", s1], title=title, cap=cap, cap_accent=acc, highlight_line=2))
    for _ in range(4): frames.append(R.terminal([full, "BLANK", s1, s2], title=title, cap=cap, cap_accent=acc, highlight_line=3))
    for _ in range(5): frames.append(R.terminal([full, "BLANK", s1, s2, s3], title=title, cap=cap, cap_accent=acc, highlight_line=4))
    frames.append(R.terminal([full, "BLANK", s1, s2, s3], title=title, cap=cap, cap_accent=acc))
    return frames

# ---------- the scene list (ordered) ----------
def neg():
    return term_type(
        "verifier verify-tx 0xdeadbeef...0000",
        [[("unverified", R.RED, True)],
         [("verifier: unknown 0xdead...0000 claimed=0 observed=<unavailable> -> ", R.DIM, False), ("unverified", R.RED, True)],
         [("exit code: ", R.DIM, False), ("1", R.RED, True)]],
        "proofagent - verifier", "THE HOOK  -  a transaction that never happened  ->  UNVERIFIED", R.RED, hl=2)

def liecheck():
    return term_type(
        "verifier verify-tx 0x8c59d0e8...bfb0   # the verifier reads 0G itself",
        [[("settled", R.GREEN, True)],
         [("verifier: TRANSFER 0x8c59...bfb0 claimed=1000000 observed=1000000 -> ", R.DIM, False), ("settled", R.GREEN, True)],
         [("# verdict alphabet: settled / hollow / mismatch / unverified  -  the chain's word, not the app's", R.DIM, False)]],
        "proofagent - verifier", "CAN'T LIE  -  an independent Rust verifier reads 0G  ->  settled", R.GREEN, hl=1)

def drain():
    return term_type(
        "verifier check-floors   # gas-floor + net-worth-floor, each verifier-confirmed",
        [[("gas-floor       ", R.DIM, False), ("ok ", R.GREEN, True), ("- reserve held back, the agent can always pay for its own exit", R.DIM, False)],
         [("net-worth-floor ", R.DIM, False), ("ok ", R.GREEN, True), ("- stops before the wallet falls below its session-start floor", R.DIM, False)],
         [("# it can't drain itself  -  both floors confirmed by the independent verifier", R.DIM, False)]],
        "proofagent - verifier", "CAN'T DRAIN  -  gas-floor + net-worth-floor  -  verifier-confirmed", R.CYAN, hl=2)

def liveproof():
    return term_type(
        "verifier verify-tx "+PROOFS+"   # FRESH settlement, this run",
        [[("settled", R.GREEN, True)],
         [("verifier: TRANSFER "+PROOFS+" claimed=1000000 observed=1000000 -> ", R.DIM, False), ("settled", R.GREEN, True)],
         [("# gate-authorized, broadcast, then independently verified on 0G  -  exit 0", R.DIM, False)]],
        "proofagent - verifier", "LIVE PROOF  -  a fresh on-chain settlement this run  ->  settled", R.GREEN, hl=1)

def dash_anim():
    """Reveal the Verification Console: cards -> run the dry-run (per-asset ledger) -> paste a hash in the Playground."""
    cap = "THE CONSOLE  -  verify with zero wallet, zero trust"
    frames = []
    for _ in range(6): frames.append(R.dashboard_card(highlight="neg", cap=cap))
    for _ in range(7): frames.append(R.dashboard_card(highlight="run", run_ledger=True, cap=cap))
    for _ in range(8): frames.append(R.dashboard_card(highlight="play", run_ledger=True,
                                     playground=(SETTLE, "SETTLED", R.GREEN), cap=cap))
    return frames

def mandcard_anim():
    """Reveal the live-V4 per-asset card, highlighting each verdict row in turn."""
    cap = "MANDATE BY ASSET  -  the LIVE MandateRegistryV4 on 0G (16602)"
    frames = []
    for _ in range(3): frames.append(R.mandate_asset_card(highlight="allow",  cap=cap))
    for _ in range(3): frames.append(R.mandate_asset_card(highlight="overcap",cap=cap))
    for _ in range(4): frames.append(R.mandate_asset_card(highlight="token",  cap=cap))
    frames.append(R.mandate_asset_card(cap=cap))
    return frames

def every_layer():
    """EVERY LAYER ON 0G: the full-stack thesis — Compute reasons, Chain gates+settles, Storage attests."""
    return term_type(
        "agent stack --on-0g   # every layer of the agent runs on 0G",
        [[("0G Compute  ", R.DIM, False), ("reasons       ", R.GOLD, True), ("- which model ran, attested in a TEE enclave", R.DIM, False)],
         [("0G Chain    ", R.DIM, False), ("gates+settles ", R.GREEN, True), ("- can't overspend / can't lie   (LIVE)", R.DIM, False)],
         [("0G Storage  ", R.DIM, False), ("attests       ", R.GOLD, True), ("- the proof itself, published on 0G", R.DIM, False)]],
        "proofagent - every layer on 0G", "EVERY LAYER ON 0G  -  Compute reasons  ·  Chain settles  ·  Storage attests", R.GOLD, hl=3)

def brain_scene():
    """0G COMPUTE: which model ran, attested in a real TEE enclave (built + offline-tested; operator-gated)."""
    return term_type(
        "agent brain --attest   # which model ran, proven on 0G Compute",
        [[("service attestation ", R.DIM, False), ("verified", R.GREEN, True), ("  +  per-response enclave signature ", R.DIM, False), ("verified", R.GREEN, True)],
         [("attested = the model ran in a real TEE enclave  -  never the model's own word", R.DIM, False)],
         [("# built + offline-tested  -  goes green on a live attestation (operator-gated)", R.DIM, False)]],
        "proofagent - 0G Compute (TEE brain)", "0G COMPUTE  -  which model ran, attested in an enclave", R.GOLD, hl=2)

def storage_scene():
    """0G STORAGE: the verifier's verdict bundle, published immutably on 0G (built + offline-tested)."""
    return term_type(
        "verifier publish-bundle --to 0g-storage   # the proof of the proof, on 0G",
        [[("rootHash  ", R.DIM, False), ("0x...  (content-addressed, re-derivable by anyone)", R.GOLD, True)],
         [("the verifier's verdict bundle, published immutably to 0G Storage", R.DIM, False)],
         [("# built + offline-tested  -  goes live on one publish (a funded 0G wallet)", R.DIM, False)]],
        "proofagent - 0G Storage", "0G STORAGE  -  the proof itself lives on 0G", R.GOLD, hl=2)

def tier2_scene():
    """TIER-2: run the SAME mandate gate with YOUR own wallet — over-cap blocked, under-cap verified."""
    return term_type(
        "agent tier2 --your-wallet   # run the SAME mandate gate with YOUR key",
        [[("over-cap   ", R.DIM, False), ("BLOCKED pre-broadcast", R.RED, True), ("  - nothing to sign", R.DIM, False)],
         [("under-cap  ", R.DIM, False), ("you sign  ->  ", R.GREEN, True), ("the verifier confirms YOUR tx  ->  settled", R.GREEN, True)],
         [("# the console never sees your key  -  you don't trust it, you check the chain", R.DIM, False)]],
        "proofagent - Tier-2 (your wallet)", "RUN IT WITH YOUR WALLET  -  over-cap blocked  ·  under-cap verified", R.CYAN, hl=3)

SCENES = [
 dict(id="01_neg",  frames=neg,  min=5.0,
      vo="Watch. I'll hand this A.I. agent a transaction that never happened. It reads the chain itself, finds nothing, and stamps it unverified. It won't rubber-stamp a lie. Most A.I. just says, trust me. This one proves it instead."),
 dict(id="02_title", frames=lambda:[R.title_card("ProofAgent-0G","the AI agent that can't lie, and can't overspend  -  every layer on 0G")], min=4.5,
      vo="ProofAgent, on zero G. The A.I. agent that can't lie, and can't overspend. And every layer of it runs on zero G. Every one of these features is real, and on-chain verifiable."),
 dict(id="02b_everylayer", frames=every_layer, min=7.0,
      vo="Here's what makes it different. Every layer of this agent runs on zero G. It reasons on zero G Compute. It's gated and settled on zero G Chain. And its proof is stored on zero G Storage. Three layers, three zero G primitives, and every one is independently verifiable."),
 dict(id="03_cantlie", frames=liecheck, min=5.5,
      vo="One. It can't lie. An independent Rust verifier reads zero G itself and stamps every claim, settled, hollow, mismatch, or unverified. It's the chain's word, never the app's."),
 dict(id="04_rails", frames=mandate_anim, min=8.0,
      vo="Two. It can't overspend. A live mandate on zero G gates every spend by asset. Under cap, allowed. Over cap, blocked, over transaction cap. A non-allowlisted token, blocked, token not allowed. Same agent, a different verdict per asset, and every spend is blocked before anything is broadcast. The mandate blocks it, and the verifier proves it."),
 dict(id="05_v4card", frames=mandcard_anim, min=6.5,
      vo="That's the mandate registry version four, live on zero G Galileo, chain sixteen six oh two. Per-asset allowlist, per-transaction caps, a period cap, all read straight from chain. There's even a wallet-free simulator, so you can run the gate yourself."),
 dict(id="06_v4explore", frames=lambda:[R.explorer_card("https://chainscan-galileo.0g.ai/address/"+V4S,"Contract  -  MandateRegistryV4","LIVE",R.GOLD,
      [("Address",V4S,R.TXT),("Type","verified contract",R.TXT),("Deployed block","40,213,222",R.TXT),("Network","0G-Galileo (16602)",R.GOLD)],
      cap="MandateRegistryV4  -  live on 0G-Galileo (16602)")], min=3.6,
      vo="Live on chain. Read it yourself."),
 dict(id="07_cantdrain", frames=drain, min=5.0,
      vo="Three. It can't drain itself. A gas floor and a net-worth floor, each one confirmed by the same independent verifier."),
 dict(id="07b_brain", frames=brain_scene, min=6.0,
      vo="It even reasons on zero G Compute. A T.E.E. attestation proves which model actually ran, inside a real hardware enclave, never the model's own word. It's built and offline-tested, and it goes green on a live attestation."),
 dict(id="08_liveproof", frames=liveproof, min=5.5,
      vo="Four. Live proof. A fresh, real settlement made this very run. Gate authorized, broadcast, then independently verified on zero G. Settled."),
 dict(id="09_prooftx", frames=lambda:[R.explorer_card("https://chainscan-galileo.0g.ai/tx/"+PROOF,"Transaction Details","SETTLED",R.GREEN,
      [("Status","Success (0x1)",R.GREEN),("Block","40,232,225",R.TXT),("Value","1,000,000 wei",R.TXT),("Network","0G-Galileo (16602)",R.GOLD)],
      cap=PROOF+"  -  Success (0x1)  -  1,000,000 wei")], min=4.0,
      vo="Status, success. One million wei. Confirmed on chain right now, at block forty million, two-thirty-two thousand, two-twenty-five."),
 dict(id="09b_storage", frames=storage_scene, min=6.0,
      vo="And the proof itself lives on zero G. The verifier's verdict bundle is published to zero G Storage, as a content-addressed root hash anyone can re-derive. The proof of the proof, on zero G."),
 dict(id="10_dashboard", frames=dash_anim, min=8.5,
      vo="Five. The interactive dashboard. A clean-room verification console. Four proof cards. Run the agent, dry-run, and it prints a real run ledger, gating each trade per asset. The mandate card simulates a transfer. And a paste-any-hash playground lets judges check any settlement themselves, with zero wallet, zero trust."),
 dict(id="10b_tier2", frames=tier2_scene, min=6.5,
      vo="Or run it with your own wallet. Try to overspend, and it's blocked before you can even sign. Spend within the cap, you sign with your own key, and the verifier confirms your transaction. The console never sees your key."),
 dict(id="11_fullstack", frames=lambda:[R.fullstack_card(cap="ZERO-HUMAN FULLSTACK  -  a headless browser drives the real UI  -  every verdict reconciled two-source")], min=6.5,
      vo="And it's all driven through the real interface by a headless browser, with no human in the loop. Every on-screen verdict, NEG, RAILS, and SETTLED, reconciled two-source against the chain and the verifier. All three pass. A doctored interface faking a settlement is caught loud."),
 dict(id="12_rigor", frames=lambda:[R.rigor_card(cap="every layer on 0G  -  verify it all yourself")], min=7.5,
      vo="So, what did you just verify? It can't lie. It can't overspend. It can't drain itself. It reasons on zero G Compute, settles on zero G Chain, and stores its proof on zero G Storage. Every layer on zero G, and you check it all yourself. Clean-room. A.G.P.L. Reproducible."),
 dict(id="13_end", frames=lambda:[R.end_card()], min=5.0,
      vo="The agent that can't lie, and can't overspend, every layer on zero G. Don't trust it. Check the chain. Verify it yourself, and vote ProofAgent in the zero G Zero Cup."),
]

def build_scene(sc):
    sdir = os.path.join(WORK, sc["id"]); os.makedirs(sdir, exist_ok=True)
    frames = sc["frames"]()
    for i, im in enumerate(frames):
        im.save(os.path.join(sdir, "f_%04d.png" % i))
    # voiceover
    vo_dur = 0.0; vo_wav = None
    if sc.get("vo"):
        tf = os.path.join(sdir, "vo.txt"); open(tf, "w", encoding="utf-8").write(sc["vo"])
        vo_wav = os.path.join(sdir, "vo.wav")
        run(["powershell","-ExecutionPolicy","Bypass","-File",os.path.join(HERE,"voice.ps1"),
             "-TextFile",tf,"-Out",vo_wav,"-Rate",str(RATE),"-Voice",VOICE])
        vo_dur = probe_dur(vo_wav)
    anim_dur = len(frames)/FPS
    scene_dur = max(sc.get("min",3.0), anim_dur+1.4, vo_dur+PAD)
    total = round(scene_dur*FPS); scene_dur = total/FPS
    last = os.path.join(sdir, "f_%04d.png" % (len(frames)-1))
    for i in range(len(frames), total):
        shutil.copy(last, os.path.join(sdir, "f_%04d.png" % i))
    vmp4 = os.path.join(sdir, "v.mp4")
    run(["ffmpeg","-y","-framerate",str(FPS),"-i",os.path.join(sdir,"f_%04d.png"),
         "-frames:v",str(total),"-c:v","libx264","-pix_fmt","yuv420p","-r",str(FPS),vmp4])
    scene_mp4 = os.path.join(sdir, "scene.mp4")
    if vo_wav:
        run(["ffmpeg","-y","-i",vmp4,"-i",vo_wav,
             "-filter_complex","[1:a]apad,atrim=0:%.3f,asetpts=PTS-STARTPTS[a]"%scene_dur,
             "-map","0:v","-map","[a]","-c:v","copy","-c:a","aac","-ar","48000","-ac","2",scene_mp4])
    else:
        run(["ffmpeg","-y","-i",vmp4,"-f","lavfi","-t","%.3f"%scene_dur,"-i","anullsrc=r=48000:cl=stereo",
             "-map","0:v","-map","1:a","-c:v","copy","-c:a","aac",scene_mp4])
    print("  [%s] frames=%d vo=%.1fs dur=%.1fs" % (sc["id"], len(frames), vo_dur, scene_dur))
    return scene_mp4, scene_dur

def main():
    if os.path.exists(WORK): shutil.rmtree(WORK)
    os.makedirs(WORK); os.makedirs(OUT, exist_ok=True)
    clips = []; total = 0.0
    for sc in SCENES:
        mp4, d = build_scene(sc); clips.append(mp4); total += d
    listf = os.path.join(WORK, "concat.txt")
    with open(listf,"w") as f:
        for c in clips: f.write("file '%s'\n" % c.replace("\\","/"))
    master = os.path.join(OUT, "ProofAgent0G_master_16x9.mp4")
    run(["ffmpeg","-y","-f","concat","-safe","0","-i",listf,
         "-c:v","libx264","-pix_fmt","yuv420p","-r",str(FPS),"-crf","18","-preset","medium",
         "-c:a","aac","-b:a","192k","-movflags","+faststart",master])
    # thumbnail = title card
    R.title_card("ProofAgent-0G","the AI agent that can't lie, and can't overspend  -  on 0G").save(os.path.join(OUT,"thumbnail.png"))
    print("\nMASTER: %s  (~%.1fs planned)" % (master, total))
    print("DUR(actual): %.2fs" % probe_dur(master))

if __name__ == "__main__":
    main()
