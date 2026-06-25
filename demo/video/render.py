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

# ---------------- rigor card (the 5 crucial features) ----------------
def rigor_card(cap=None):
    img,d=new_canvas(); d.rectangle([0,0,W,6],fill=GOLD)
    d.text((W//2,130),"What you just verified",font=f_ui(66,"b"),fill=TXT,anchor="mm")
    rows=[("CAN'T LIE","an independent Rust verifier reads 0G: settled / hollow / mismatch / unverified",GREEN),
          ("CAN'T OVERSPEND","the LIVE MandateRegistryV4 gates BY ASSET - over-cap blocked pre-broadcast, the verifier proves it",GOLD),
          ("CAN'T DRAIN","gas-floor + net-worth-floor - each verifier-confirmed",CYAN),
          ("LIVE PROOF","a fresh on-chain settlement this run - gate-authorized, verified settled",GREEN),
          ("VERIFY IT YOURSELF","an interactive console - paste any hash, zero wallet, zero trust",GOLD)]
    y=246
    for lab,sub,col in rows:
        d.ellipse([268,y-2,298,y+28],outline=col,width=4); d.text((283,y+13),"+",font=f_ui(26,"b"),fill=col,anchor="mm")
        d.text((336,y-4),lab,font=f_ui(36,"b"),fill=col,anchor="lm")
        d.text((336,y+42),sub,font=f_ui(25),fill=DIM,anchor="lm"); y+=110
    # footer
    d.rounded_rectangle([280,y+6,W-280,y+86],radius=14,fill=(16,20,27),outline=BORDER,width=2)
    d.text((W//2,y+46),"100% on 0G   -   clean-room   -   AGPL-3.0   -   reproducible (VERIFY.md)",font=f_ui(34,"sb"),fill=GOLD,anchor="mm")
    d.text((W//2,y+138),"don't trust it  ->  check the chain  -  hundreds of tests - Rust - Solidity - TypeScript",font=f_ui(27),fill=DIM,anchor="mm")
    watermark(d)
    if cap: lower_third(d,cap)
    return img

# ---------------- interactive dashboard (the Verification Console) ----------------
def dashboard_card(highlight=None, run_ledger=False, playground=None, cap=None):
    """A clean-room rendering of the live Verification Console: 4 proof cards + the
    'Run the agent (dry-run)' + a paste-any-hash Playground. highlight in {neg,brain,rails,settle,run,play}."""
    img,d=new_canvas(); _browser_chrome(d,"http://localhost:3100/dashboard.html")
    # header rail
    d.text((220,238),"ProofAgent-0G",font=f_ui(40,"b"),fill=TXT,anchor="lm")
    d.text((220,286),"0G Aristotle  -  Verification Console   -   can't lie, can't overspend",font=f_ui(24),fill=DIM,anchor="lm")
    # network pill (right)
    d.rounded_rectangle([W-470,222,W-200,260],radius=10,fill=(33,63,40))
    d.ellipse([W-452,234,W-440,246],fill=GREEN)
    d.text((W-430,241),"0G Galileo  -  live",font=f_ui(24,"sb"),fill=GREEN,anchor="lm")
    # rollup strip
    d.rounded_rectangle([220,308,W-200,352],radius=8,fill=(16,20,27),outline=BORDER,width=1)
    d.text((240,330),"3 reconciled  -  1 pending(brain)  -  0 mismatch   -   reconciled vs 0G RPC + verifier",
           font=f_mono(24),fill=GREEN,anchor="lm")
    # four proof cards
    cards=[("neg","NEG","refuse a fabricated tx","UNVERIFIED",RED),
           ("brain","BRAIN","which model ran (0G TEE)","PENDING",GOLD),
           ("rails","RAILS","it cannot overspend","RECONCILED",GREEN),
           ("settle","SETTLEMENT","the trade really happened","SETTLED",GREEN)]
    cw=395; gap=18; x0=220; cy=380; ch=176
    for i,(cid,lab,sub,verdict,col) in enumerate(cards):
        cx=x0+i*(cw+gap)
        sel = (highlight==cid)
        fillc = (16,20,27)
        d.rounded_rectangle([cx,cy,cx+cw,cy+ch],radius=14,fill=fillc,
                            outline=(col if sel else BORDER),width=(4 if sel else 2))
        d.text((cx+22,cy+34),lab,font=f_ui(28,"b"),fill=TXT,anchor="lm")
        d.text((cx+22,cy+72),sub,font=f_ui(21),fill=DIM,anchor="lm")
        bw=70+len(verdict)*15
        bxc=(33,63,40) if col==GREEN else ((60,30,30) if col==RED else (52,42,8))
        d.rounded_rectangle([cx+22,cy+100,cx+22+bw,cy+138],radius=9,fill=bxc)
        d.text((cx+22+bw//2,cy+119),verdict,font=f_ui(24,"b"),fill=col,anchor="mm")
    # run-the-agent (dry-run) panel
    ry=580
    rsel = (highlight=="run")
    d.rounded_rectangle([220,ry,W-200,ry+ (250 if run_ledger else 92)],radius=14,fill=(16,20,27),
                        outline=(CYAN if rsel else BORDER),width=(4 if rsel else 2))
    d.text((244,ry+30),"Run the agent (dry-run)",font=f_ui(28,"b"),fill=TXT,anchor="lm")
    d.text((244,ry+66),"gate 3 intents per asset  -  no wallet, no signing, nothing broadcast",font=f_ui(22),fill=DIM,anchor="lm")
    d.rounded_rectangle([W-470,ry+24,W-224,ry+68],radius=10,fill=(20,36,52),outline=CYAN,width=2)
    d.text((W-347,ry+46),"Run dry-run  >",font=f_ui(24,"b"),fill=CYAN,anchor="mm")
    if run_ledger:
        rows=[("native sentinel  1,000,000","(true, OK)","ALLOWED",GREEN),
              ("native sentinel  3,000,000","(false, OVER_TX_CAP)","BLOCKED",RED),
              ("USDC.E  1,000,000","(false, TOKEN_NOT_ALLOWED)","BLOCKED",RED)]
        yy=ry+96
        for asset,reason,dec,col in rows:
            d.text((260,yy),asset,font=f_mono(23),fill=TXT,anchor="lm")
            d.text((760,yy),reason,font=f_mono(23),fill=col,anchor="lm")
            d.text((W-300,yy),dec,font=f_mono(23,True),fill=col,anchor="lm"); yy+=40
        d.text((260,yy+4),'RUN LEDGER  ->  DEFECTS  -  3 unverified  (dry-run broadcasts nothing)',font=f_mono(22),fill=DIM,anchor="lm")
    # playground
    py=ry+(270 if run_ledger else 112)
    psel=(highlight=="play")
    d.rounded_rectangle([220,py,W-200,py+118],radius=14,fill=(16,20,27),
                        outline=(GREEN if psel else BORDER),width=(4 if psel else 2))
    d.text((244,py+32),"Playground  -  paste ANY 0G tx hash",font=f_ui(28,"b"),fill=TXT,anchor="lm")
    ph = playground[0] if playground else "0x____  paste a hash, get an independent verdict"
    pv = playground[1] if playground else None
    pc = playground[2] if playground else DIM
    d.rounded_rectangle([244,py+58,W-470,py+102],radius=10,fill=(13,17,23),outline=BORDER,width=1)
    d.text((262,py+80),ph,font=f_mono(24),fill=(TXT if pv else DIM),anchor="lm")
    if pv:
        bw=70+len(pv)*16
        d.rounded_rectangle([W-450,py+58,W-450+bw,py+102],radius=10,fill=(33,63,40) if pc==GREEN else (60,30,30))
        d.text((W-450+bw//2,py+80),pv,font=f_ui(24,"b"),fill=pc,anchor="mm")
    else:
        d.rounded_rectangle([W-360,py+58,W-224,py+102],radius=10,fill=(20,36,52),outline=GREEN,width=2)
        d.text((W-292,py+80),"Check",font=f_ui(24,"b"),fill=GREEN,anchor="mm")
    watermark(d)
    if cap: lower_third(d,cap,GREEN)
    return img

# ---------------- mandate-by-asset card (per-asset table + checkTransfer sim) ----------------
def mandate_asset_card(highlight=None, cap=None):
    """The live MandateRegistryV4 read straight from chain: per-asset allowlist + caps + the
    wallet-free checkTransfer simulator. highlight in {allow, overcap, token}."""
    img,d=new_canvas(); _browser_chrome(d,"https://chainscan-galileo.0g.ai/address/0x8e561a...f774")
    d.text((220,250),"MandateRegistryV4  -  mandate BY ASSET",font=f_ui(44,"b"),fill=TXT,anchor="lm")
    d.rounded_rectangle([220,296,520,348],radius=10,fill=(33,63,40))
    d.text((370,322),"LIVE on 0G  -  16602",font=f_ui(26,"b"),fill=GREEN,anchor="mm")
    d.text((540,322),"0x8e561a...f774   -   perTxCap 2,000,000   -   periodCap 1,500,000 / 3600s",font=f_mono(24),fill=DIM,anchor="lm")
    # column headers
    hy=400
    d.text((240,hy),"ASSET",font=f_ui(24,"b"),fill=DIM,anchor="lm")
    d.text((720,hy),"ALLOWLIST",font=f_ui(24,"b"),fill=DIM,anchor="lm")
    d.text((1050,hy),"PER-TX CAP",font=f_ui(24,"b"),fill=DIM,anchor="lm")
    d.text((1400,hy),"checkTransfer",font=f_ui(24,"b"),fill=DIM,anchor="lm")
    rows=[("allow","native sentinel  0x00...0001","allowed",GREEN,"2,000,000","under cap","(true, OK)  ALLOWED",GREEN),
          ("overcap","native sentinel  0x00...0001","allowed",GREEN,"2,000,000","3,000,000","(false, OVER_TX_CAP)",RED),
          ("token","USDC.E  0x1f3AA82...473E","not on list",DIM,"—","1,000,000","(false, TOKEN_NOT_ALLOWED)",RED)]
    y=448
    for cid,asset,allow,acol,cap_v,probe,ans,ansc in rows:
        sel=(highlight==cid)
        if sel:
            d.rounded_rectangle([200,y-14,W-200,y+58],radius=10,
                                fill=(20,38,24) if ansc==GREEN else (40,20,20))
        d.text((240,y+22),asset,font=f_mono(26),fill=(TXT if allow=="allowed" else DIM),anchor="lm")
        d.text((720,y+22),allow,font=f_ui(26,"sb"),fill=acol,anchor="lm")
        d.text((1050,y+22),cap_v,font=f_mono(26),fill=(TXT if cap_v!="—" else DIM),anchor="lm")
        d.text((1400,y+22),ans,font=f_mono(24,True),fill=ansc,anchor="lm")
        y+=96
    # the simulator strip
    sy=y+24
    d.rounded_rectangle([220,sy,W-200,sy+150],radius=14,fill=(16,20,27),outline=BORDER,width=2)
    d.text((244,sy+38),"wallet-free checkTransfer simulator  -  zero gas, zero signing",font=f_ui(28,"b"),fill=TXT,anchor="lm")
    d.text((244,sy+86),"same agent  -  different decision per asset  ->  the gate is enforced BY ASSET",font=f_ui(26,"sb"),fill=GOLD,anchor="lm")
    d.text((244,sy+124),"reconciled vs the deployed contract's own eth_call  -  the chain is the baseline, never the UI",font=f_ui(22),fill=DIM,anchor="lm")
    watermark(d)
    if cap: lower_third(d,cap,GOLD)
    return img

# ---------------- Zero-human (headless-driven) fullstack reconciliation card ----------------
def fullstack_card(cap=None):
    img,d=new_canvas(); d.rectangle([0,0,W,6],fill=GOLD)
    d.text((W//2,150),"Driven through the real UI  -  no human in the loop",font=f_ui(58,"b"),fill=TXT,anchor="mm")
    d.text((W//2,224),"headless browser clicks every control  -  each on-screen verdict reconciled two-source vs the chain",
           font=f_ui(30,"sb"),fill=DIM,anchor="mm")
    rows=[("NEG","Run the NEG case","UNVERIFIED","verifier verify-tx  ->  unverified","PASS",RED),
          ("RAILS","over-cap checkTransfer","OVER_TX_CAP","independent eth_call  ->  OVER_TX_CAP","PASS",GOLD),
          ("SETTLED","Check on-chain","SETTLED","verifier verify-tx  ->  settled","PASS",GREEN)]
    y=350; rh=150
    for lab,click,verdict,recon,passv,col in rows:
        d.rounded_rectangle([260,y,W-260,y+rh-22],radius=16,fill=(16,20,27),outline=BORDER,width=2)
        d.rectangle([260,y,272,y+rh-22],fill=col)
        d.text((320,y+38),lab,font=f_ui(40,"b"),fill=col,anchor="lm")
        d.text((320,y+92),"UI verdict  "+verdict+"     -     reconciled: "+recon,font=f_mono(26),fill=TXT,anchor="lm")
        # PASS chip on the right
        d.rounded_rectangle([W-440,y+38,W-300,y+92],radius=12,fill=(33,63,40))
        d.text((W-370,y+65),passv,font=f_ui(34,"b"),fill=GREEN,anchor="mm")
        y+=rh
    d.text((W//2,y+30),"a doctored UI faking 'settled' is caught LOUD (exit 1)  -  unreachable source = infra-gated, never faked",
           font=f_ui(28),fill=DIM,anchor="mm")
    watermark(d)
    if cap: lower_third(d,cap,GREEN)
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
    rigor_card(cap="cap + gas-floor + net-worth-floor  -  clean-room  -  AGPL-3.0").save(os.path.join(out,"sample_rigor.png"))
    end_card().save(os.path.join(out,"sample_end.png"))
    title_card("The verification trio","three independent axes - each provable on its own",
        chips=[("VERIFY CODE","clean-room, open, AGPL-3.0",CYAN),("BOUND SPEND","the on-chain mandate",GOLD),("PROVE SETTLE","the independent verifier",GREEN)],
        cap="THE TRIO  -  verify-the-code - bound-the-spend - prove-the-settlement",title_size=84,ty=250).save(os.path.join(out,"sample_trio.png"))
    print("wrote rigor/end/trio samples")
