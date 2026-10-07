#!/usr/bin/env python3
"""
Show where the energy in a recording really is, in ENGINE ORDERS.

    python tools\\analyze_pitch.py recordings\\on_3500.wav 3500
    python tools\\analyze_pitch.py recordings\\on_3500.wav            (rpm read from the file name)

1 order = rpm / 60 Hz (once per crank turn). A 4-stroke engine fires cylinders/2 times
per turn, so an inline-6 shows its strongest peak at order 3 (then 6, 9, ...), a 4-cyl
at order 2, a V8 at order 4. If the main peaks sit on whole numbers at the orders you
expect, the recording matches the rpm; if they sit between whole numbers, the real rpm
is different (the table says by how much). Paste the output to Claude.
Needs: pip install numpy scipy
"""
import re
import sys
from pathlib import Path

import numpy as np
from scipy import signal

from make_engine_loops import SR, load_audio


def main() -> None:
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    path = Path(sys.argv[1])
    if not path.exists():
        sys.exit(f"'{path}' not found (looked in {Path.cwd()}). Run from the project root.")
    if len(sys.argv) > 2:
        rpm = float(sys.argv[2])
    else:
        m = re.search(r"(\d+)", path.stem)
        if not m:
            sys.exit("Give the rpm as a second argument.")
        rpm = float(m.group(1))

    x = load_audio(path)
    x = x[int(0.7 * SR): len(x) - int(0.7 * SR)]
    x = x - np.mean(x)
    f, p = signal.welch(x, SR, nperseg=SR * 2)          # 0.5 Hz resolution
    hz1 = rpm / 60.0
    band = (f >= hz1 * 0.4) & (f <= 1500)
    ff, pp = f[band], p[band]
    db = 10 * np.log10(pp + 1e-20)
    idx, _ = signal.find_peaks(db, prominence=6, distance=int(hz1 * 0.25 / (f[1] - f[0])) or 1)
    top = idx[np.argsort(db[idx])[::-1][:12]]
    ref = db[top].max() if len(top) else 0
    print(f"{path.name}: label {rpm:.0f} rpm -> 1 order = {hz1:.1f} Hz")
    print(f"{'freq Hz':>9} {'order':>7} {'level dB':>9}")
    for i in sorted(top, key=lambda k: ff[k]):
        print(f"{ff[i]:9.1f} {ff[i] / hz1:7.2f} {db[i] - ref:9.1f}")

    # Ratio between the strongest peaks: whole numbers = a clean harmonic series.
    if len(top) >= 2:
        s = sorted(top[:5], key=lambda k: ff[k])
        base = ff[s[0]]
        print("\nStrongest 5 peaks as multiples of the lowest of them:",
              ", ".join(f"{ff[k] / base:.2f}" for k in s))
        print(f"The lowest of them is {base:.1f} Hz = order {base / hz1:.2f} at the labelled rpm.")


if __name__ == "__main__":
    main()