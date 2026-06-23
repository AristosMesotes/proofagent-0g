"""
ProofAgent-0G demo video - frame renderer (Pillow).
Pure-deterministic: terminal sessions + title/explorer/rigor/end cards from REAL data.
Every on-screen datum is real and confirmable on chainscan-galileo.0g.ai. No screen capture.
"""
import os
from PIL import Image, ImageDraw, ImageFont

W, H = 1920, 1080

# ---- palette ----
BG=(8,11,18); PANEL=(13,17,23); TITLEBAR=(22,27,34); BORDER=(48,54,61)
TXT=(230,237,243); DIM=(139,148,158); PROMPT=(63,185,80)
GREEN=(63,185,80); RED=(248,81,73); CYAN=(88,166,255); GOLD=(245,197,24)
DOT_R=(255,95,86); DOT_Y=(255,189,46); DOT_G=(39,201,63)

# Fonts: Consolas (mono) + Segoe UI (sans), preinstalled on Windows. Override PA_FONT_DIR to
# point at any TTF dir on other OSes (e.g. JetBrains Mono + DejaVu Sans); falls back gracefully.
FONT_DIR = os.environ.get("PA_FONT_DIR", "C:\\Windows\\Fonts\\")
def _load(name, sz):
    try: return ImageFont.truetype(os.path.join(FONT_DIR, name), sz)
    except OSError:
        try: return ImageFont.truetype(name, sz)          # resolvable on the system font path
        except OSError: return ImageFont.load_default(sz)  # last-resort fallback (plainer, still renders)
def f_mono(sz,bold=False): return _load("consolab.ttf" if bold else "consola.ttf", sz)
def f_ui(sz,w="r"): return _load({"r":"segoeui.ttf","b":"segoeuib.ttf","sb":"seguisb.ttf","l":"segoeuil.ttf"}[w], sz)

def new_canvas():
    img=Image.new("RGB",(W,H),BG); return img,ImageDraw.Draw(img)

def watermark(d):
    d.text((W-50,38),"chainscan-galileo.0g.ai",font=f_ui(24),fill=(110,119,128),anchor="ra")

def lower_third(d,text,accent=GOLD):
    bar_h=92; y0=H-bar_h-30
    d.rounded_rectangle([60,y0,W-60,y0+bar_h],radius=14,fill=(16,20,27))
    d.rectangle([60,y0,68,y0+bar_h],fill=accent)
    d.text((100,y0+bar_h//2),text,font=f_ui(34,"sb"),fill=TXT,anchor="lm")

# ---------------- terminal ----------------
def terminal(lines,title="proofagent - verifier",cap=None,cap_accent=GOLD,
             cursor_line=None,highlight_line=None,panel=(160,150,1760,770)):
    """lines: list, each is 'BLANK' or a list of (text,color,bold) segments."""
    img,d=new_canvas()
    px0,py0,px1,py1=panel
    d.rounded_rectangle([px0,py0,px1,py1],radius=16,fill=PANEL,outline=BORDER,width=2)
    d.rounded_rectangle([px0,py0,px1,py0+52],radius=16,fill=TITLEBAR)
    d.rectangle([px0,py0+36,px1,py0+54],fill=TITLEBAR)
    for i,c in enumerate((DOT_R,DOT_Y,DOT_G)):
        cx=px0+30+i*30; d.ellipse([cx-8,py0+18,cx+8,py0+34],fill=c)
    d.text(((px0+px1)//2,py0+26),title,font=f_ui(24,"sb"),fill=DIM,anchor="mm")
    mono=f_mono(32); monob=f_mono(32,True)
    x=px0+36; y=py0+88; lh=48
    for idx,line in enumerate(lines):
        if highlight_line==idx:
            d.rounded_rectangle([x-12,y-6,px1-40,y+40],radius=8,fill=(40,20,20) if cap_accent==RED else (40,34,8))
        if line=="BLANK": y+=lh; continue
        cx=x
        for (text,color,bold) in line:
            fnt=monob if bold else mono
            d.text((cx,y),text,font=fnt,fill=color); cx+=d.textlength(text,font=fnt)
        if cursor_line==idx:
            d.rectangle([cx+3,y+2,cx+19,y+38],fill=TXT)
        y+=lh
    watermark(d)
    if cap: lower_third(d,cap,cap_accent)
    return img

# ---------------- chips / title ----------------
def chip(d,box,label,sub,color):
    x0,y0,x1,y1=box
    d.rounded_rectangle(box,radius=18,fill=(16,20,27),outline=color,width=3)
    d.text(((x0+x1)//2,y0+58),label,font=f_ui(38,"b"),fill=color,anchor="mm")
    d.text(((x0+x1)//2,y0+120),sub,font=f_ui(25),fill=DIM,anchor="mm")

def title_card(title,tagline,chips=None,cap=None,title_size=120,ty=250):
    img,d=new_canvas()
    d.rectangle([0,0,W,6],fill=GOLD)
    d.text((W//2,ty),title,font=f_ui(title_size,"b"),fill=TXT,anchor="mm")
    d.text((W//2,ty+110),tagline,font=f_ui(46,"sb"),fill=GOLD,anchor="mm")
    if chips:
        n=len(chips); cw=480; gap=44; total=n*cw+(n-1)*gap; sx=(W-total)//2; y0=540
        for i,(lab,sub,col) in enumerate(chips):
            x0=sx+i*(cw+gap); chip(d,[x0,y0,x0+cw,y0+200],lab,sub,col)
    watermark(d)
    if cap: lower_third(d,cap)
    return img

# ---------------- explorer ----------------
def _browser_chrome(d,url):
    d.rounded_rectangle([160,120,W-160,960],radius=16,fill=PANEL,outline=BORDER,width=2)
    d.rounded_rectangle([160,120,W-160,186],radius=16,fill=TITLEBAR); d.rectangle([160,168,W-160,188],fill=TITLEBAR)
    for i,c in enumerate((DOT_R,DOT_Y,DOT_G)):
        d.ellipse([190+i*30-8,144,190+i*30+8,160],fill=c)
    d.rounded_rectangle([320,134,W-200,172],radius=12,fill=(13,17,23),outline=BORDER,width=1)
    d.text((344,153),url,font=f_mono(24),fill=CYAN,anchor="lm")

def explorer_card(url,header,badge,badge_color,rows,cap=None):
    img,d=new_canvas(); _browser_chrome(d,url)
    d.text((220,250),header,font=f_ui(46,"b"),fill=TXT,anchor="lm")
    if badge:
        bw=120+len(badge)*22
        d.rounded_rectangle([220,300,220+bw,356],radius=10,fill=(33,63,40) if badge_color==GREEN else (60,30,30))
        d.text((220+bw//2,328),badge,font=f_ui(30,"b"),fill=badge_color,anchor="mm")
    y=420
    for k,v,col in rows:
        d.text((220,y),k,font=f_ui(30),fill=DIM,anchor="lm")
        d.text((620,y),v,font=f_mono(30),fill=col,anchor="lm"); y+=70
    watermark(d)
    if cap: lower_third(d,cap,GREEN if badge_color==GREEN else (GOLD if badge_color==GOLD else RED))
    return img

# ---------------- settlements card ----------------
def settle_card(cap=None):
    img,d=new_canvas()
    _browser_chrome(d,"chainscan-galileo.0g.ai  -  independent settlements")
    d.text((220,250),"Real settlements  -  independently verified",font=f_ui(44,"b"),fill=TXT,anchor="lm")
    rows=[("0x8c59...bfb0","block 39,996,100","1,000,000 wei"),
          ("0xfb18...6290","block 39,996,470","1,000,000 wei"),
          ("0x4249...b4b6","block 40,232,225","1,000,000 wei")]
    y=350
    for h,blk,val in rows:
        d.rounded_rectangle([216,y-6,W-216,y+74],radius=12,fill=(16,20,27),outline=BORDER,width=2)
        d.rounded_rectangle([236,y+14,236+150,y+54],radius=8,fill=(33,63,40))
        d.text((236+75,y+34),"SETTLED",font=f_ui(24,"b"),fill=GREEN,anchor="mm")
        d.text((420,y+34),h,font=f_mono(30),fill=TXT,anchor="lm")
        d.text((860,y+34),blk,font=f_ui(26),fill=DIM,anchor="lm")
        d.text((W-240,y+34),val,font=f_mono(26),fill=GREEN,anchor="rm"); y+=96
    d.rounded_rectangle([216,y+10,W-216,y+96],radius=14,fill=(33,63,40),outline=GREEN,width=2)
    d.text((W//2,y+53),"3 of 3 independently verified  ->  settled  -  0 hollow  -  0 mismatch",font=f_ui(34,"b"),fill=GREEN,anchor="mm")
    watermark(d)
    if cap: lower_third(d,cap,GREEN)
    return img

# ---------------- console CTA ----------------
def console_cta(cap=None):
    img,d=new_canvas(); _browser_chrome(d,"aristosmesotes.github.io/proofagent-0g/dashboard.html  -  live, no wallet")
    d.text((W//2,300),"Verify it yourself.",font=f_ui(72,"b"),fill=TXT,anchor="mm")
    d.text((W//2,390),"In your browser. No wallet. No trust.",font=f_ui(44,"sb"),fill=GOLD,anchor="mm")
    chips=[("PASTE ANY HASH","the verifier reads 0G live"),
           ("RUN THE DRY-RUN","per-asset mandate gate, read-only"),
           ("RECONCILE ON-CHAIN","every verdict, two-source")]
    n=len(chips); cw=480; gap=40; total=n*cw+(n-1)*gap; sx=(W-total)//2; y0=510
    for i,(lab,sub) in enumerate(chips):
        x0=sx+i*(cw+gap)
        d.rounded_rectangle([x0,y0,x0+cw,y0+150],radius=16,fill=(16,20,27),outline=CYAN,width=2)
        d.text((x0+cw//2,y0+52),lab,font=f_ui(30,"b"),fill=CYAN,anchor="mm")
        d.text((x0+cw//2,y0+104),sub,font=f_ui(24),fill=DIM,anchor="mm")
    d.rounded_rectangle([W//2-640,750,W//2+640,830],radius=14,fill=(13,17,23),outline=BORDER,width=2)
    d.text((W//2,790),"aristosmesotes.github.io/proofagent-0g/dashboard.html",font=f_mono(30),fill=CYAN,anchor="mm")
    watermark(d)
    if cap: lower_third(d,cap,GOLD)
    return img

# ---------------- rigor card ----------------
def rigor_card(cap=None):
    img,d=new_canvas(); d.rectangle([0,0,W,6],fill=GOLD)
    d.text((W//2,128),"What you just verified",font=f_ui(64,"b"),fill=TXT,anchor="mm")
    rows=[("CAN'T LIE","an independent Rust verifier reads 0G: settled / hollow / mismatch / unverified",GREEN),
          ("CAN'T OVERSPEND","the live V4 mandate gates by asset - over-cap blocked pre-broadcast, the verifier proves it",GOLD),
          ("CAN'T DRAIN","a gas-floor and a net-worth-floor - each verifier-confirmed",CYAN),
          ("LIVE PROOF","3 of 3 real settlements, independently chain-verified - 0 hollow, 0 mismatch",GREEN),
          ("VERIFY IT YOURSELF","an interactive console - paste any hash, no wallet, no trust",GOLD)]
    y=232
    for lab,sub,col in rows:
        d.ellipse([300,y-2,330,y+28],outline=col,width=4); d.text((315,y+13),"+",font=f_ui(28,"b"),fill=col,anchor="mm")
        d.text((370,y-6),lab,font=f_ui(36,"b"),fill=col,anchor="lm")
        d.text((370,y+42),sub,font=f_ui(25),fill=DIM,anchor="lm"); y+=104
    d.rounded_rectangle([300,y+6,W-300,y+86],radius=14,fill=(16,20,27),outline=BORDER,width=2)
    d.text((W//2,y+46),"don't trust the agent  -  check the chain  -  every datum confirmable on 0G",font=f_ui(30,"sb"),fill=TXT,anchor="mm")
    d.text((W//2,y+136),"open source  -  AGPL-3.0  -  reproducible (VERIFY.md)",font=f_ui(28),fill=GOLD,anchor="mm")
    watermark(d)
    if cap: lower_third(d,cap)
    return img

# ---------------- end card ----------------
def end_card(cap=None):
    img,d=new_canvas(); d.rectangle([0,0,W,6],fill=GOLD)
    d.text((W//2,300),"You don't trust the agent.",font=f_ui(86,"b"),fill=TXT,anchor="mm")
    d.text((W//2,410),"You check the chain.",font=f_ui(86,"b"),fill=GOLD,anchor="mm")
    d.rounded_rectangle([W//2-470,560,W//2+470,660],radius=16,fill=(16,20,27),outline=GOLD,width=3)
    d.text((W//2,610),"Vote  ProofAgent-0G  -  0G Zero Cup",font=f_ui(44,"b"),fill=GOLD,anchor="mm")
    d.text((W//2,740),"verify it yourself  ->  chainscan-galileo.0g.ai",font=f_mono(34),fill=CYAN,anchor="mm")
    d.text((W//2,820),"the AI agent that can't lie, and can't overspend  -  on 0G",font=f_ui(32),fill=DIM,anchor="mm")
    return img

# ---------------- samples ----------------
if __name__=="__main__":
    out=os.path.join(os.path.dirname(__file__),"samples"); os.makedirs(out,exist_ok=True)
    rigor_card(cap="cap + gas-floor + net-worth-floor  -  AGPL-3.0").save(os.path.join(out,"sample_rigor.png"))
    end_card().save(os.path.join(out,"sample_end.png"))
    title_card("The verification trio","three independent axes - each provable on its own",
        chips=[("VERIFY CODE","fully open, AGPL-3.0, reproducible",CYAN),("BOUND SPEND","the on-chain mandate",GOLD),("PROVE SETTLE","the independent verifier",GREEN)],
        cap="THE TRIO  -  verify-the-code - bound-the-spend - prove-the-settlement",title_size=84,ty=250).save(os.path.join(out,"sample_trio.png"))
    print("wrote rigor/end/trio samples")
