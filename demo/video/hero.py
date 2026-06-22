"""
ProofAgent-0G - 9:16 HERO clip (<=30s, NEG-only share-bait for community voting).
Native portrait 1080x1920. Reuses the build harness (render+SAPI+ffmpeg). Real data only.
"""
import os, shutil
from PIL import Image, ImageDraw
import render as R
import build as B

HERE = os.path.dirname(os.path.abspath(__file__))
OUT  = os.path.join(HERE, "out")
B.WORK = os.path.join(HERE, "work_hero")          # isolate from the master's work dir
PW, PH = 1080, 1920
NEG_HASH = "0xdeadbeef...0000"

def pc():
    img = Image.new("RGB", (PW, PH), R.BG); return img, ImageDraw.Draw(img)

def wrap(d, text, font, maxw):
    words = text.split(); lines=[]; cur=""
    for w in words:
        t = (cur+" "+w).strip()
        if d.textlength(t, font=font) <= maxw: cur=t
        else: lines.append(cur); cur=w
    if cur: lines.append(cur)
    return lines

def top_caption(d, text, color=R.TXT, y=210, size=66, maxw=940):
    fnt = R.f_ui(size, "b")
    for ln in wrap(d, text, fnt, maxw):
        d.text((PW//2, y), ln, font=fnt, fill=color, anchor="mm"); y += size+14
    return y

def watermark(d):
    d.text((PW//2, PH-70), "chainscan-galileo.0g.ai", font=R.f_ui(30), fill=(120,129,138), anchor="mm")

def p_term(d, lines, y0=720, h=620, title="proofagent - verifier", cursor_line=None, hl=None):
    px0,py0,px1,py1 = 70,y0,PW-70,y0+h
    d.rounded_rectangle([px0,py0,px1,py1], radius=18, fill=R.PANEL, outline=R.BORDER, width=2)
    d.rounded_rectangle([px0,py0,px1,py0+56], radius=18, fill=R.TITLEBAR); d.rectangle([px0,py0+38,px1,py0+58], fill=R.TITLEBAR)
    for i,c in enumerate((R.DOT_R,R.DOT_Y,R.DOT_G)):
        cx=px0+34+i*34; d.ellipse([cx-9,py0+19,cx+9,py0+37], fill=c)
    d.text(((px0+px1)//2,py0+28), title, font=R.f_ui(26,"sb"), fill=R.DIM, anchor="mm")
    mono=R.f_mono(40); monob=R.f_mono(40,True)
    x=px0+40; y=py0+100; lh=62
    for idx,line in enumerate(lines):
        if hl==idx: d.rounded_rectangle([x-14,y-8,px1-30,y+50], radius=10, fill=(46,22,22))
        if line=="BLANK": y+=lh; continue
        cx=x
        for (t,col,b) in line:
            fnt=monob if b else mono; d.text((cx,y), t, font=fnt, fill=col); cx+=d.textlength(t,font=fnt)
        if cursor_line==idx: d.rectangle([cx+4,y+4,cx+24,y+48], fill=R.TXT)
        y+=lh

# ---------------- hero scenes ----------------
def h1():  # typing the fabricated tx
    cmd = "verifier verify-tx "+NEG_HASH
    frames=[]
    for k in range(0, len(cmd)+1, 2):
        img,d=pc(); top_caption(d, "I gave an AI agent a transaction that NEVER happened.", R.TXT)
        cl=[("$ ", R.PROMPT, True), (cmd[:k], R.TXT, False)]
        p_term(d, [cl], cursor_line=0); watermark(d); frames.append(img)
    for _ in range(6):
        img,d=pc(); top_caption(d, "I gave an AI agent a transaction that NEVER happened.", R.TXT)
        p_term(d, [[("$ ", R.PROMPT, True), (cmd, R.TXT, False)]], cursor_line=0); watermark(d); frames.append(img)
    return frames

def h2():  # UNVERIFIED stamp
    cmd=[("$ ", R.PROMPT, True), ("verifier verify-tx "+NEG_HASH, R.TXT, False)]
    out=[cmd, "BLANK", [("unverified", R.RED, True)], [("exit code: ", R.DIM, False), ("1", R.RED, True)]]
    img,d=pc()
    top_caption(d, "It refused to rubber-stamp.", R.TXT)
    p_term(d, out, hl=2)
    d.rounded_rectangle([90,1440,PW-90,1620], radius=22, fill=(46,22,22), outline=R.RED, width=4)
    d.text((PW//2,1530), "UNVERIFIED", font=R.f_ui(96,"b"), fill=R.RED, anchor="mm")
    watermark(d); return [img]

def h3():  # checks the chain itself
    img,d=pc()
    top_caption(d, "It checks the chain itself.", R.TXT, y=300, size=72)
    top_caption(d, "No record  ->  no stamp.", R.GOLD, y=470, size=60)
    # mini explorer result
    d.rounded_rectangle([90,720,PW-90,1240], radius=18, fill=R.PANEL, outline=R.BORDER, width=2)
    d.text((PW//2,820), "chainscan-galileo.0g.ai", font=R.f_mono(34), fill=R.CYAN, anchor="mm")
    d.text((PW//2,930), NEG_HASH, font=R.f_mono(40,True), fill=R.DIM, anchor="mm")
    d.rounded_rectangle([260,1020,PW-260,1110], radius=12, fill=(46,22,22))
    d.text((PW//2,1065), "No matching transaction", font=R.f_ui(38,"b"), fill=R.RED, anchor="mm")
    d.text((PW//2,1380), "Most AI says: trust me.", font=R.f_ui(48,"sb"), fill=R.DIM, anchor="mm")
    d.text((PW//2,1460), "This one proves it - or won't.", font=R.f_ui(50,"b"), fill=R.TXT, anchor="mm")
    watermark(d); return [img]

def h4():  # title
    img,d=pc(); d.rectangle([0,0,PW,8], fill=R.GOLD)
    d.text((PW//2,760), "ProofAgent", font=R.f_ui(120,"b"), fill=R.TXT, anchor="mm")
    d.text((PW//2,890), "-0G", font=R.f_ui(120,"b"), fill=R.GOLD, anchor="mm")
    d.text((PW//2,1080), "the agent that can't lie,", font=R.f_ui(52,"sb"), fill=R.TXT, anchor="mm")
    d.text((PW//2,1150), "and can't overspend.", font=R.f_ui(52,"sb"), fill=R.TXT, anchor="mm")
    watermark(d); return [img]

def h5():  # CTA
    img,d=pc(); d.rectangle([0,0,PW,8], fill=R.GOLD)
    d.text((PW//2,560), "Check the chain,", font=R.f_ui(80,"b"), fill=R.TXT, anchor="mm")
    d.text((PW//2,670), "not the agent.", font=R.f_ui(80,"b"), fill=R.GOLD, anchor="mm")
    d.rounded_rectangle([110,900,PW-110,1060], radius=20, fill=(16,20,27), outline=R.GOLD, width=4)
    d.text((PW//2,955), "Vote  ProofAgent-0G", font=R.f_ui(56,"b"), fill=R.GOLD, anchor="mm")
    d.text((PW//2,1015), "0G Zero Cup", font=R.f_ui(44,"sb"), fill=R.GOLD, anchor="mm")
    d.text((PW//2,1240), "verify it yourself", font=R.f_ui(40), fill=R.DIM, anchor="mm")
    d.text((PW//2,1310), "chainscan-galileo.0g.ai", font=R.f_mono(40), fill=R.CYAN, anchor="mm")
    return [img]

HERO = [
 dict(id="h1", frames=h1, min=4.0, vo="I gave an A.I. agent a transaction that never happened."),
 dict(id="h2", frames=h2, min=5.0, vo="It read the chain, found nothing, and refused to confirm it."),
 dict(id="h3", frames=h3, min=6.5, vo="Most A.I. just tells you it worked. This one proves it, or won't."),
 dict(id="h4", frames=h4, min=3.5, vo="ProofAgent, on zero G. The agent that can't lie."),
 dict(id="h5", frames=h5, min=4.0, vo="Vote ProofAgent in the zero G Zero Cup."),
]

def main():
    if os.path.exists(B.WORK): shutil.rmtree(B.WORK)
    os.makedirs(B.WORK); os.makedirs(OUT, exist_ok=True)
    clips=[]; total=0.0
    for sc in HERO:
        mp4,d = B.build_scene(sc); clips.append(mp4); total+=d
    listf=os.path.join(B.WORK,"concat.txt")
    with open(listf,"w") as f:
        for c in clips: f.write("file '%s'\n" % c.replace("\\","/"))
    hero=os.path.join(OUT,"ProofAgent0G_hero_9x16.mp4")
    B.run(["ffmpeg","-y","-f","concat","-safe","0","-i",listf,
           "-c:v","libx264","-pix_fmt","yuv420p","-r","30","-crf","18","-preset","medium",
           "-c:a","aac","-b:a","192k","-movflags","+faststart",hero])
    print("\nHERO: %s  dur=%.2fs" % (hero, B.probe_dur(hero)))

if __name__ == "__main__":
    main()
