"""
Synthesize a royalty-free music bed (numpy) and mix it UNDER the narration with
sidechain ducking, so the voice stays clear. Idempotent: always mixes from the
clean (no-music) backup, so re-running never stacks music.
"""
import os, sys, subprocess, wave, shutil, math, array

SR = 48000
HERE = os.path.dirname(os.path.abspath(__file__))
OUT  = os.path.join(HERE, "out")
TWOPI = 2*math.pi

# vi - IV - I - V in A minor: warm, serious-but-hopeful, classic cinematic/tech bed
CHORDS = [
    dict(notes=[220.00, 261.63, 329.63], sub=110.00),   # Am
    dict(notes=[174.61, 220.00, 261.63], sub=87.31),    # F
    dict(notes=[261.63, 329.63, 392.00], sub=130.81),   # C
    dict(notes=[196.00, 246.94, 293.66], sub=98.00),    # G
]

def build_segments(chord_dur=4.0, cf=1.3):
    """Synthesize one waveform per chord once (reused for every repetition + both videos)."""
    seg_n = int((chord_dur+cf)*SR); rin = int(cf*SR)
    env = [1.0]*seg_n
    for i in range(rin):
        env[i] = 0.5 - 0.5*math.cos(math.pi*i/rin)
        env[seg_n-1-i] = 0.5 - 0.5*math.cos(math.pi*i/rin)
    segs = []
    for ch in CHORDS:
        namp = 1.0/len(ch["notes"]); sub = ch["sub"]; seg = [0.0]*seg_n
        for idx in range(seg_n):
            t = idx/SR; s = 0.0
            for f in ch["notes"]:
                for det in (0.997, 1.003):
                    ff = f*det
                    s += namp*0.5*(math.sin(TWOPI*ff*t) + 0.18*math.sin(TWOPI*2*ff*t) + 0.07*math.sin(TWOPI*3*ff*t))
            s += 0.40*math.sin(TWOPI*sub*t)
            seg[idx] = s*env[idx]
        segs.append(seg)
    return segs, seg_n

def synth(dur, segs, seg_n, chord_dur=4.0):
    n_chords = int(dur/chord_dur) + 2
    total = int((n_chords*chord_dur+seg_n/SR+1)*SR)
    buf = [0.0]*total
    for k in range(n_chords):
        seg = segs[k % len(segs)]; s0 = int(k*chord_dur*SR)
        for j in range(seg_n): buf[s0+j] += seg[j]
    N = int(dur*SR); buf = buf[:N]
    fi, fo = int(2.0*SR), int(3.0*SR)
    for i in range(N):
        g = 0.82 + 0.18*math.sin(TWOPI*i/SR/14.0)            # slow swell
        if i < fi: g *= i/fi
        elif i >= N-fo: g *= (N-i)/fo
        buf[i] *= g
    peak = max((abs(x) for x in buf), default=1.0) or 1.0
    scale = 0.89/peak
    d = int(0.011*SR)                                        # Haas width
    out = array.array('h', bytes(4*N))                       # interleaved L,R int16
    for i in range(N):
        L = buf[i]*scale
        R = buf[i-d]*scale if i-d >= 0 else 0.0
        out[2*i]   = int(max(-1.0, min(1.0, L))*32767)
        out[2*i+1] = int(max(-1.0, min(1.0, R))*32767)
    return out

def write_wav(path, frames_i16):
    with wave.open(path, "wb") as w:
        w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR); w.writeframes(frames_i16.tobytes())

_SEGS = None
def bed_for(dur):
    global _SEGS
    if _SEGS is None: _SEGS = build_segments()
    return synth(dur, _SEGS[0], _SEGS[1])

def dur_of(path):
    out = subprocess.run(["ffprobe","-v","error","-show_entries","format=duration",
                          "-of","default=nk=1:nw=1",path], capture_output=True, text=True).stdout
    return float(out.strip())

def add_music(clean_src, outp, vol=0.11):
    d = dur_of(clean_src)
    bed = os.path.join(HERE, "bed_tmp.wav"); write_wav(bed, bed_for(d))
    fc = ("[0:a]asplit=2[vo1][vok];"
          "[1:a]volume=%.3f[bed];"
          "[bed][vok]sidechaincompress=threshold=0.02:ratio=8:attack=5:release=320:makeup=1[bd];"
          "[vo1][bd]amix=inputs=2:normalize=0:duration=first,alimiter=limit=0.95[a]" % vol)
    subprocess.run(["ffmpeg","-y","-i",clean_src,"-i",bed,"-filter_complex",fc,
                    "-map","0:v","-map","[a]","-c:v","copy","-c:a","aac","-b:a","192k",
                    "-movflags","+faststart",outp], check=True,
                   capture_output=True, text=True)
    os.remove(bed); print("  music ->", os.path.basename(outp), "(%.1fs)" % d)

def main():
    nomusic = os.path.join(OUT, "nomusic"); os.makedirs(nomusic, exist_ok=True)
    for name in ["ProofAgent0G_master_16x9.mp4", "ProofAgent0G_hero_9x16.mp4"]:
        src = os.path.join(OUT, name); bak = os.path.join(nomusic, name)
        if not os.path.exists(bak): shutil.copy(src, bak)   # preserve clean original once
        tmp = os.path.join(OUT, "_m_"+name)
        add_music(bak, tmp)                                  # always mix from the clean backup
        os.replace(tmp, src)

if __name__ == "__main__":
    main()
