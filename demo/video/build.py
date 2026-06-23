"""
ProofAgent-0G demo video - build orchestrator.
Renders every scene (Pillow), voices it (Windows SAPI), and muxes a 16:9 master with ffmpeg.
All on-screen data is REAL + confirmable on chainscan-galileo.0g.ai. Honesty guardrails baked in:
no live-TEE 'brain' stamp; the trio is verify-code / bound-spend / prove-settle; no brittle counts.
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

# ---- real constants (confirmable on-chain) ----
MAND   = "0x8e561a...f774"           # MandateRegistryV4 (LIVE on 16602)
SETTLE = "0x8c59d0e8...bfb0"
ACCRUE = "0x44e5...8556"

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

def v3_anim():
    cmd = "./demo/mandate_v3_period_cap.sh --accrue"
    full = [("$ ", R.PROMPT, True), (cmd, R.TXT, False)]
    s1 = [("STEP 1  ", R.CYAN, True), ("checkTransfer(1000000)            -> ", R.DIM, False), ("(true, OK)", R.GREEN, True)]
    s2 = [("STEP 2  ", R.CYAN, True), ("gateAndRecord(1000000)           -> accrue tx "+ACCRUE, R.GOLD, False)]
    s3 = [("STEP 3  ", R.CYAN, True), ("checkTransfer(1000000) [loop 2]  -> ", R.DIM, False), ("(false, OVER_PERIOD_CAP)", R.RED, True)]
    title, cap, acc = "proofagent - mandate V3 (period cap, on-chain)", "V3 lineage  -  period cap closes the looping-drain a flat cap passes (now folded into V4)", R.GOLD
    frames = []
    for k in range(0, len(cmd)+1, 3):
        cl = [("$ ", R.PROMPT, True), (cmd[:k], R.TXT, False)]
        frames.append(R.terminal([cl, "BLANK"], title=title, cap=cap, cap_accent=acc, cursor_line=0))
    for _ in range(4): frames.append(R.terminal([full, "BLANK"], title=title, cap=cap, cap_accent=acc, cursor_line=0))
    for _ in range(3): frames.append(R.terminal([full, "BLANK", s1], title=title, cap=cap, cap_accent=acc))
    for _ in range(3): frames.append(R.terminal([full, "BLANK", s1, s2], title=title, cap=cap, cap_accent=acc))
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
        "proofagent - verifier", "THE HOOK  -  a transaction that never happened  ->  UNVERIFIED", R.RED, hl=2, step=4, pre=2)

def rails():
    return term_type(
        "cast call MandateRegistry checkTransfer(agent, native, 3000000)",
        [[("(false, ", R.TXT, False), ("OVER_TX_CAP", R.RED, True), (")", R.TXT, False)],
         [("# over the per-tx cap - blocked pre-broadcast, zero gas, nothing sent", R.DIM, False)]],
        "proofagent - mandate (on-chain)", "RAILS  -  over-cap -> (false, OVER_TX_CAP)  -  nothing broadcast", R.GOLD, hl=2)

def settled():
    return term_type(
        "verifier verify-tx 0x8c59d0e8...bfb0",
        [[("settled", R.GREEN, True)],
         [("verifier: TRANSFER 0x8c59...bfb0 claimed=1000000 observed=1000000 -> ", R.DIM, False), ("settled", R.GREEN, True)],
         [("exit code: ", R.DIM, False), ("0", R.GREEN, True)]],
        "proofagent - verifier", "SETTLED  -  the verifier read the chain  ->  settled", R.GREEN, hl=2)

SCENES = [
 dict(id="01_neg",  frames=neg,  min=4.5,
      vo="Watch. I'll hand this A.I. agent a transaction that never happened. It reads the chain, finds nothing, and stamps it unverified. It won't rubber-stamp a lie. Most A.I. just says, trust me. This one proves it instead."),
 dict(id="02_title", frames=lambda:[R.title_card("ProofAgent-0G","the AI agent that can't lie, and can't overspend  -  on 0G")], min=4.0,
      vo="ProofAgent, on zero G. The A.I. agent that can't lie, and can't overspend. Three layers, each independently provable."),
 dict(id="03_trio", frames=lambda:[R.title_card("The verification trio","three independent axes - each provable on its own",
      chips=[("VERIFY CODE","fully open, AGPL-3.0, reproducible",R.CYAN),("BOUND SPEND","the on-chain mandate",R.GOLD),("PROVE SETTLE","the independent verifier",R.GREEN)],
      cap="THE TRIO  -  verify-the-code - bound-the-spend - prove-the-settlement",title_size=84)], min=5.0,
      vo="Three independent axes. Verify the code it runs - it's fully open, every line readable. Bound what it can spend. And prove what it settled, on-chain, with an independent verifier."),
 dict(id="04_rails", frames=rails, min=5.0,
      vo="The agent tries to spend over its cap. The on-chain mandate answers false, over transaction cap. Pre-broadcast, zero gas, nothing sent. It can't overspend - the mandate blocks it, and the verifier proves it."),
 dict(id="05_mand", frames=lambda:[R.explorer_card("https://chainscan-galileo.0g.ai/address/0x8e561a...f774","Contract  -  MandateRegistryV4","LIVE",R.GOLD,
      [("Address",MAND,R.TXT),("Type","verified contract",R.TXT),("Network","0G-Galileo (16602)",R.GOLD)],
      cap="MandateRegistryV4  -  live on 0G-Galileo (16602)")], min=3.6,
      vo="There's the mandate, live on zero G. Read it yourself."),
 dict(id="06_v3", frames=v3_anim, min=7.0,
      vo="A flat cap is fooled by looping small trades, so the mandate adds a per-period cap - proven here on the V3 contract, and now live in V4. The first transfer passes and accrues on-chain. The second is blocked, over period cap, even though the per-transaction cap would allow it. Looping-drain, closed."),
 dict(id="07_accrue", frames=lambda:[R.explorer_card("https://chainscan-galileo.0g.ai/tx/0x44e5...8556","Transaction  -  gateAndRecord","Success (0x1)",R.GREEN,
      [("Status","Success (0x1)",R.GREEN),("Block","40,044,471",R.TXT),("Method","gateAndRecord",R.TXT),("Network","0G-Galileo (16602)",R.GOLD)],
      cap="accrue tx 0x44e5...8556  -  on-chain")], min=3.2,
      vo="The accrual is right there on-chain."),
 dict(id="08_settled", frames=settled, min=5.0,
      vo="Now a real, capped transfer. The independent verifier reads zero G itself, status and value, and stamps it settled. Not the app's word. The chain's."),
 dict(id="09_settledtx", frames=lambda:[R.explorer_card("https://chainscan-galileo.0g.ai/tx/0x8c59d0e8...bfb0","Transaction Details","SETTLED",R.GREEN,
      [("Status","Success (0x1)",R.GREEN),("Block","39,996,100",R.TXT),("Value","1,000,000 wei",R.TXT),("Network","0G-Galileo (16602)",R.GOLD)],
      cap="0x8c59...bfb0  -  Success (0x1)  -  1,000,000 wei")], min=3.6,
      vo="Status, success. Value, one million wei. Confirmed on-chain."),
 dict(id="10_rigor", frames=lambda:[R.rigor_card(cap="cap + gas-floor + net-worth-floor  -  AGPL-3.0")], min=6.0,
      vo="So what did you just verify? The code is fully open and externally gated. The spend is hard-capped. The settlement is independently proven. Plus a gas-floor and a net-worth-floor, so it can't drain itself. Fully open, A-G-P-L three."),
 dict(id="11_end", frames=lambda:[R.end_card()], min=5.0,
      vo="The agent that can't lie, and can't overspend. Don't trust it. Check the chain. Verify it yourself, and vote ProofAgent in the zero G Zero Cup."),
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
