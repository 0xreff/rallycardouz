#!/usr/bin/env python3
"""
Turn Engine Simulator recordings into the seamless loops the game plays.

    python tools/make_engine_loops.py recordings public/assets/audio/engine

Needs:  pip install numpy scipy      (ffmpeg on PATH is optional: it lets you
                                       use mp3/m4a/flac/ogg as well as wav)

------------------------------------------------------------------------------
1. RECORDING (Engine Simulator Community Edition, Windows)
------------------------------------------------------------------------------
Engine Simulator has no audio export, so capture what it plays:
Audacity -> Host "Windows WASAPI" -> Device "<your speakers> (loopback)", or OBS
"Audio Output Capture". Mono or stereo is fine.

Per recording:
  - A = ignition, S = hold starter until it runs, D = dyno on, H = RPM hold on.
  - Hold G and scroll the mouse wheel to set the hold RPM (read it off the
    DYNO. SPEED gauge).
  - Z + scroll lowers the volume if the recording clips (keep peaks under 0 dB).
  - R = full throttle -> record ~8 s  ->  save as  on_<rpm>.wav
  - Q = lowest throttle, same RPM -> record ~8 s -> save as off_<rpm>.wav
  - Do this for about 7 RPMs from idle to the limiter, e.g.
        1000 1800 2600 3500 4400 5400 6500
    (the closer the points, the less pitch-shifting the game has to do).
  - Optional extras:
        limiter.wav   full throttle with the RPM hold set ABOVE the rev limit,
                      so the engine bounces off the limiter (8 s)
        start.wav     starter + engine catching (one-shot, not looped)
        stall.wav     engine dying (one-shot, not looped)

Files may be wav/flac/mp3/m4a/ogg (non-wav needs ffmpeg).

------------------------------------------------------------------------------
2. WHAT THIS SCRIPT DOES
------------------------------------------------------------------------------
  - drops the first/last 0.7 s (key presses, starter, fades)
  - picks the steadiest stretch, then builds a seamless loop: the loop point is
    searched (+-0.1 s) so the engine's waveform lines up across the seam, and the
    seam is crossfaded
  - one global gain for all clips (peak = -3 dBFS), so quieter low-RPM loops stay
    quieter than the high-RPM ones
  - writes 16-bit mono 44.1 kHz wav files + manifest.json
  - prints an ADVISORY check that each file's pitch matches the RPM in its name
"""
import argparse
import json
import re
import shutil
import subprocess
import sys
from pathlib import Path

import numpy as np
from scipy import signal
from scipy.io import wavfile

SR = 44100
EXTS = {".wav", ".flac", ".mp3", ".m4a", ".ogg", ".aac"}
TARGET_PEAK = 10 ** (-3 / 20)  # -3 dBFS


# ----------------------------------------------------------------------------
# reading / writing
# ----------------------------------------------------------------------------
def load_audio(path: Path) -> np.ndarray:
    """Return mono float32 at 44.1 kHz."""
    if shutil.which("ffmpeg"):
        cmd = ["ffmpeg", "-loglevel", "error", "-i", str(path), "-ac", "1", "-ar", str(SR), "-f", "f32le", "-"]
        out = subprocess.run(cmd, capture_output=True)
        if out.returncode == 0 and out.stdout:
            return np.frombuffer(out.stdout, dtype=np.float32).copy()
    if path.suffix.lower() != ".wav":
        sys.exit(f"{path.name}: install ffmpeg to read {path.suffix} files (or export as .wav)")
    sr, data = wavfile.read(path)
    if data.dtype == np.int16:
        x = data.astype(np.float32) / 32768
    elif data.dtype == np.int32:
        x = data.astype(np.float32) / 2147483648
    elif data.dtype == np.uint8:
        x = (data.astype(np.float32) - 128) / 128
    else:
        x = data.astype(np.float32)
    if x.ndim == 2:
        x = x.mean(axis=1)
    if sr != SR:
        g = np.gcd(sr, SR)
        x = signal.resample_poly(x, SR // g, sr // g).astype(np.float32)
    return x


def write_wav(path: Path, x: np.ndarray) -> None:
    wavfile.write(path, SR, np.round(np.clip(x, -1, 1) * 32767).astype(np.int16))


# ----------------------------------------------------------------------------
# loop building
# ----------------------------------------------------------------------------
def steadiest_window(x: np.ndarray, length: int) -> np.ndarray:
    """The `length`-sample stretch whose short-term loudness varies the least."""
    if len(x) <= length:
        return x
    hop = SR // 2
    blk = SR // 10
    rms = np.sqrt(np.convolve(x * x, np.ones(blk) / blk, mode="valid"))[::blk // 2]
    best, best_i = None, 0
    per = max(1, length // (blk // 2))
    for start in range(0, len(x) - length + 1, hop):
        seg = rms[start // (blk // 2): start // (blk // 2) + per]
        if len(seg) < 2:
            continue
        score = np.std(seg) / (np.mean(seg) + 1e-9)
        if best is None or score < best:
            best, best_i = score, start
    return x[best_i: best_i + length]


def make_loop(x: np.ndarray, loop_s: float, xfade_s: float, trim_s: float, name: str) -> np.ndarray:
    x = x - np.mean(x)
    x = x[int(trim_s * SR): len(x) - int(trim_s * SR)]
    loop_n, xf_n, search = int(loop_s * SR), int(xfade_s * SR), int(0.1 * SR)
    need = loop_n + xf_n + search
    if len(x) < need:
        sys.exit(f"{name}: only {len(x)/SR:.1f}s usable after trimming, need {need/SR:.1f}s. "
                 f"Record longer, or lower --loop-seconds.")
    seg = steadiest_window(x, need)

    # Find the loop end `s` whose continuation best matches the start (compared on
    # the low band, where the engine's firing pattern lives).
    sos = signal.butter(4, 600, "lowpass", fs=SR, output="sos")
    lo = signal.sosfiltfilt(sos, seg)
    head = lo[:xf_n]
    region = lo[loop_n - search: loop_n + search + xf_n]
    corr = signal.correlate(region, head, mode="valid", method="fft")
    energy = np.sqrt(np.convolve(region * region, np.ones(xf_n), mode="valid") * np.sum(head * head)) + 1e-12
    score = corr / energy
    k = int(np.argmax(score))
    s = loop_n - search + k
    quality = float(score[k])
    if quality < 0.3:
        print(f"  ! {name}: weak periodic match ({quality:.2f}); the recording may not be steady "
              f"(RPM hold off? engine hunting?). The loop may sound wobbly.")

    # Crossfade: the audio that would CONTINUE after the loop end (seg[s:s+X]) is
    # faded out over the loop start. Aligned/correlated signal -> linear fade keeps
    # the level steady; uncorrelated -> equal-power.
    fo = np.linspace(1.0, 0.0, xf_n, dtype=np.float32)
    fi = 1.0 - fo
    if quality < 0.6:
        fo, fi = np.cos(fi * np.pi / 2), np.sin(fi * np.pi / 2)
    out = seg[:s].copy()
    out[:xf_n] = seg[s: s + xf_n] * fo + seg[:xf_n] * fi
    return out.astype(np.float32)


def trim_silence(x: np.ndarray, db: float = -50.0) -> np.ndarray:
    thr = 10 ** (db / 20) * max(1e-9, float(np.max(np.abs(x))))
    idx = np.nonzero(np.abs(x) > thr)[0]
    if len(idx) == 0:
        return x
    a, b = max(0, idx[0] - int(0.02 * SR)), min(len(x), idx[-1] + int(0.1 * SR))
    y = x[a:b].copy()
    f = min(len(y) // 2, int(0.01 * SR))
    y[:f] *= np.linspace(0, 1, f, dtype=np.float32)
    y[-f:] *= np.linspace(1, 0, f, dtype=np.float32)
    return y


# ----------------------------------------------------------------------------
# checks
# ----------------------------------------------------------------------------
def seam_jump(loop: np.ndarray) -> float:
    """Wrap-around step relative to a typical step. ~1 = inaudible seam."""
    typical = float(np.median(np.abs(np.diff(loop)))) + 1e-9
    return abs(float(loop[0] - loop[-1])) / typical


def implied_rpm(loop: np.ndarray, rpm: float, cylinders: int = 6):
    """Advisory: does the pitch fit the labelled RPM? Returns (estimated rpm, ratio to label).

    Every steady engine sound is a harmonic series of rpm/120 Hz (one 4-stroke cycle
    = two crank turns), whatever the cylinder count or firing pattern. So take the
    strongest spectral peaks and see how well they sit on that comb. The label is
    accepted when they fit it; it is only questioned when they clearly do NOT fit it
    and clearly DO fit a different rate within +-20 %. A clean series can also fit a
    finer comb by coincidence (e.g. a label 7/6 too low), which this cannot catch.
    `cylinders` is kept only so old callers still work.
    """
    f, p = signal.welch(loop - np.mean(loop), SR, nperseg=2 * SR)
    db = 10 * np.log10(p + 1e-20)
    band = (f >= 20) & (f <= 1500)
    ff, dd = f[band], db[band]
    idx, _ = signal.find_peaks(dd, prominence=6, distance=max(1, int(10 / (f[1] - f[0]))))
    idx = idx[dd[idx] > dd[idx].max() - 25] if len(idx) else idx   # ignore noise-floor bumps
    top = idx[np.argsort(dd[idx])[::-1][:12]]
    peaks = ff[top]
    if len(peaks) < 4:
        return rpm, 1.0

    def fit(r: float) -> float:
        k = peaks / (rpm / 120.0 * r)
        res = np.abs(k - np.round(k))
        return float(np.mean(np.clip(1 - res / 0.1, 0, 1)))

    if fit(1.0) >= 0.7:
        return rpm, 1.0
    best_r, best = 1.0, 0.0
    for r in sorted(np.arange(0.80, 1.2001, 0.002), key=lambda v: abs(v - 1)):
        sc = fit(r)
        if sc > best + 1e-9:
            best, best_r = sc, float(r)
    if best < 0.8:
        return rpm, 1.0   # nothing fits convincingly: cannot tell, do not accuse
    return rpm * best_r, best_r


# ----------------------------------------------------------------------------
def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("recordings", type=Path)
    ap.add_argument("out", type=Path)
    ap.add_argument("--loop-seconds", type=float, default=3.0, help="loop length (default 3.0)")
    ap.add_argument("--crossfade", type=float, default=0.25, help="seam crossfade seconds (default 0.25)")
    ap.add_argument("--trim", type=float, default=0.7, help="seconds dropped at both ends (default 0.7)")
    ap.add_argument("--cylinders", type=int, default=6, help="for the RPM sanity check (default 6)")
    a = ap.parse_args()

    files = {p.stem.lower(): p for p in sorted(a.recordings.iterdir()) if p.suffix.lower() in EXTS}
    on, off = {}, {}
    for stem, p in files.items():
        m = re.fullmatch(r"(on|off)_(\d+)", stem)
        if m:
            (on if m.group(1) == "on" else off)[int(m.group(2))] = p
    rpms = sorted(set(on) & set(off))
    for r in sorted(set(on) ^ set(off)):
        print(f"  ! rpm {r} has only one of on_/off_ -> skipped")
    if not rpms:
        sys.exit(f"No on_<rpm>/off_<rpm> pairs found in {a.recordings} (e.g. on_3500.wav + off_3500.wav)")

    a.out.mkdir(parents=True, exist_ok=True)
    loops: dict[str, np.ndarray] = {}
    rows = []
    for r in rpms:
        for kind, table in (("on", on), ("off", off)):
            name = f"{kind}_{r}"
            loop = make_loop(load_audio(table[r]), a.loop_seconds, a.crossfade, a.trim, name)
            loops[name] = loop
            est, ratio = implied_rpm(loop, r, a.cylinders)
            rows.append((name, len(loop) / SR, seam_jump(loop), est, ratio))
    if "limiter" in files:
        loops["limiter"] = make_loop(load_audio(files["limiter"]), a.loop_seconds, a.crossfade, a.trim, "limiter")
        rows.append(("limiter", len(loops["limiter"]) / SR, seam_jump(loops["limiter"]), 0, 1.0))

    oneshots = {}
    for name in ("start", "stall"):
        if name in files:
            oneshots[name] = trim_silence(load_audio(files[name]))

    # one global gain: loudest sample anywhere lands on -3 dBFS
    peak = max(float(np.max(np.abs(v))) for v in list(loops.values()) + list(oneshots.values()))
    gain = TARGET_PEAK / peak if peak > 0 else 1.0

    manifest: dict = {"points": []}
    for r in rpms:
        write_wav(a.out / f"on_{r}.wav", loops[f"on_{r}"] * gain)
        write_wav(a.out / f"off_{r}.wav", loops[f"off_{r}"] * gain)
        manifest["points"].append({"rpm": r, "on": f"on_{r}.wav", "off": f"off_{r}.wav"})
    if "limiter" in loops:
        write_wav(a.out / "limiter.wav", loops["limiter"] * gain)
        manifest["limiter"] = "limiter.wav"
    if oneshots:
        manifest["oneShots"] = {}
        for name, x in oneshots.items():
            write_wav(a.out / f"{name}.wav", x * gain)
            manifest["oneShots"][name] = f"{name}.wav"
    (a.out / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")

    print(f"\n{'clip':<12}{'loop s':>8}{'seam':>7}   rpm check (advisory)")
    for name, secs, seam, est, ratio in rows:
        note = ""
        if name != "limiter":
            rpm_label = int(name.split("_")[1])
            if abs(ratio - 1) > 0.06:
                note = (f"?? pitch does not fit {rpm_label} rpm (closest within +-20%: ~{est:.0f}). "
                        f"Wrong file name, RPM hold off, or --cylinders?")
            else:
                note = f"pitch matches {rpm_label} rpm"
        flag = "  ok" if seam < 6 else " !! click?"
        print(f"{name:<12}{secs:>8.2f}{seam:>7.1f}{flag}   {note}")
    total = sum(p.stat().st_size for p in a.out.iterdir()) / 1e6
    print(f"\nWrote {len(manifest['points']) * 2 + len(oneshots) + ('limiter' in loops)} clips + manifest.json "
          f"to {a.out}  ({total:.1f} MB, gain x{gain:.2f})")


if __name__ == "__main__":
    main()