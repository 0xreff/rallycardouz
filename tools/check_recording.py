#!/usr/bin/env python3
"""
Check Engine Simulator recordings right after you make them.

    python tools/check_recording.py recordings\\on_3500.wav recordings\\off_3500.wav
    python tools/check_recording.py recordings            (checks every file in the folder)

For each file it reports level, clipping, steadiness, usable length and (for
on_<rpm> / off_<rpm> files) whether the pitch matches the RPM in the file name,
and ends with PASS / FIX plus what to change. Paste the output to Claude if
anything says FIX.

Names: on_<rpm>, off_<rpm>, limiter, start, stall (any of wav/flac/mp3/m4a/ogg).
Needs: pip install numpy scipy
"""
import argparse
import re
import sys
from pathlib import Path

import numpy as np

from make_engine_loops import EXTS, SR, implied_rpm, load_audio

LOOPED = ("on_", "off_", "limiter")


def db(v: float) -> float:
    return 20 * np.log10(max(v, 1e-9))


def check(path: Path, cylinders: int):
    x = load_audio(path)
    stem = path.stem.lower()
    looped = stem.startswith(LOOPED)
    problems, notes = [], []

    dur = len(x) / SR
    peak = float(np.max(np.abs(x)))
    clip = float(np.mean(np.abs(x) >= 0.999)) * 100
    rms = float(np.sqrt(np.mean(x * x)))

    # --- level / clipping ---
    if clip > 0.01 or peak >= 0.99:
        problems.append(f"CLIPPING ({clip:.2f}% of samples at full scale). Lower the volume (Z + scroll in "
                        f"Engine Simulator, or the Windows volume) so the loudest peak sits around -6 dB, then re-record.")
    elif peak < 10 ** (-24 / 20):
        problems.append(f"TOO QUIET (peak {db(peak):.1f} dBFS). Raise the volume (Z + scroll) so peaks reach about -6 dB.")
    elif peak < 10 ** (-12 / 20):
        notes.append(f"a bit quiet (peak {db(peak):.1f} dBFS); aim for about -6 dB for the best quality")

    if looped:
        # --- length ---
        usable = dur - 1.4  # the loop tool drops 0.7 s at both ends
        if usable < 4.8:
            problems.append(f"TOO SHORT ({dur:.1f} s). Record at least 8 s.")
        elif dur < 7:
            notes.append(f"{dur:.1f} s is OK, 8 s or more gives the tool a steadier stretch to choose from")

        # --- steadiness (on_/off_ takes): a held RPM should not drift in loudness. Random
        # lumpiness is normal for a big-cam engine; a steady slope means the hold, dyno or
        # throttle changed during the take.
        mid = x[int(0.7 * SR): len(x) - int(0.7 * SR)]
        if stem.startswith(("on_", "off_")) and len(mid) > SR:
            blk = SR // 10
            n = len(mid) // blk
            lv = np.array([db(np.sqrt(np.mean(mid[i * blk:(i + 1) * blk] ** 2))) for i in range(n)])
            drift = abs(float(np.polyfit(np.arange(n), lv, 1)[0])) * (n - 1)
            wob = float(np.std(lv))
            if drift > 3.0 or wob > 3.0:
                problems.append(f"NOT STEADY (loudness drifts {drift:.1f} dB, varies {wob:.1f} dB). RPM hold (H) and dyno (D) "
                                f"must both be on, the throttle key unchanged for the whole take, nothing else playing sound.")
            elif drift > 1.5 or wob > 1.5:
                notes.append(f"slightly uneven (drift {drift:.1f} dB, varies {wob:.1f} dB); acceptable if the engine is lumpy at this RPM")

        # --- pitch vs file name ---
        m = re.fullmatch(r"(?:on|off)_(\d+)", stem)
        if m and len(mid) > SR:
            rpm = int(m.group(1))
            est, ratio = implied_rpm(mid, rpm, cylinders)
            if abs(ratio - 1) > 0.06:
                problems.append(f"PITCH does not fit {rpm} rpm (closest within +-20%: about {est:.0f}). Wrong file name, "
                                f"RPM hold set to a different value, or the cylinder count differs (--cylinders).")
    else:
        # one-shots: should not be all silence and should not start with a long gap
        lead = np.nonzero(np.abs(x) > 0.01 * max(peak, 1e-9))[0]
        if len(lead) and lead[0] / SR > 1.5:
            notes.append(f"{lead[0] / SR:.1f} s of silence at the start (the tool trims it)")

    return dur, peak, clip, rms, problems, notes


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("paths", nargs="+", type=Path)
    ap.add_argument("--cylinders", type=int, default=6)
    a = ap.parse_args()

    files = []
    for p in a.paths:
        if not p.exists():
            sys.exit(f"'{p}' not found (looked in {Path.cwd()}). Run this from the project root, e.g. "
                     f"python tools\\check_recording.py recordings, or give the full path to the folder.")
        files += sorted(q for q in p.iterdir() if q.suffix.lower() in EXTS) if p.is_dir() else [p]
    if not files:
        sys.exit("No audio files found.")

    bad = 0
    for f in files:
        dur, peak, clip, rms, problems, notes = check(f, a.cylinders)
        status = "FIX " if problems else "PASS"
        bad += bool(problems)
        print(f"[{status}] {f.name:<18} {dur:5.1f} s   peak {db(peak):6.1f} dBFS   rms {db(rms):6.1f} dBFS")
        for t in problems:
            print(f"        - {t}")
        for t in notes:
            print(f"        . {t}")
    print(f"\n{len(files) - bad}/{len(files)} passed" + ("" if not bad else f", {bad} need fixing before you build loops."))


if __name__ == "__main__":
    main()