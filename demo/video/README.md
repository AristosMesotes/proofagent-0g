# ProofAgent-0G — Demo Video

📺 **Watch:** the [`demo` release](../../releases/tag/demo) assets — `ProofAgent0G_master_16x9.mp4` (the ~2-min submission cut), `ProofAgent0G_hero_9x16.mp4` (a ~24s vertical short), and `thumbnail.png` (the title-card hero image). Generated locally by `build.py` / `hero.py`.

Deterministically generated — **every frame is rendered from real, on-chain-confirmed data**. No screen recording, no mockups, nothing faked. The video practices the product's own thesis: *don't trust the narrator, check the chain.*

## Verify it yourself (0G-Galileo, chain 16602)
- RPC `https://evmrpc-testnet.0g.ai` · Explorer `https://chainscan-galileo.0g.ai`
- SETTLED tx `0x8c59d0e8…bfb0` → Success, block 39,996,100, **1,000,000 wei**
- accrue tx `0x44e5…8556` → Success, block 40,044,471
- **MandateRegistryV4 (live gate)** `0x8e561a…f774` · V3 (superseded) `0xC24A32…02BD2` (both live, have code)

## What's shown
**master (16:9):** NEG (a fabricated tx → `UNVERIFIED`) → the verification trio → RAILS (`OVER_TX_CAP`, nothing broadcast) → V3 period-cap (`OVER_PERIOD_CAP`) → SETTLED (a real capped transfer → independent verifier → `settled`) → CTA.
**short (9:16):** the NEG-only vertical cut for socials.

## Reproduce
Requires Python 3 + Pillow, and ffmpeg on PATH. Voiceover uses the Windows SAPI engine (`voice.ps1`); on other OSes substitute any TTS that writes a WAV. Fonts default to Consolas + Segoe UI — set `PA_FONT_DIR` to override.
```
python build.py    # -> the 16:9 master + thumbnail.png
python hero.py     # -> the 9:16 short
```
- `render.py` — frame primitives (terminal / cards / explorer panels)
- `build.py` — scene list + narration + ffmpeg assembly (master)
- `hero.py` — the vertical short
- `music.py` — a synthesized, royalty-free pad, sidechain-ducked under the narration
- `voice.ps1` — SAPI text→WAV

## Honesty
No fabricated settlement (the SETTLED tx is a real transfer); no live-TEE "brain" claim (that layer is roadmap); AGPL-3.0-or-later. No secrets ever on screen.
