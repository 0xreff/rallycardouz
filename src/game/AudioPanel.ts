import {
    DEFAULT_AUDIO_SETTINGS,
    getAudioSettings,
    setAudioSettings,
    type AudioSettings,
} from "./AudioSettings";

type NumKey = { [K in keyof AudioSettings]: AudioSettings[K] extends number ? K : never }[keyof AudioSettings];

type Field =
    | { kind: "slider"; key: NumKey; label: string; min: number; max: number; step: number };

interface Section { title: string; fields: Field[] }

const SECTIONS: Section[] = [
    {
        title: "Volumes",
        fields: [
            { kind: "slider", key: "engineVolume", label: "Engine Volume", min: 0, max: 2, step: 0.05 },
            { kind: "slider", key: "windVolume", label: "Wind Volume", min: 0, max: 2, step: 0.05 },
            { kind: "slider", key: "crackleVolume", label: "Exhaust Crackle Vol.", min: 0, max: 2, step: 0.05 },
            { kind: "slider", key: "bovVolume", label: "Turbo BOV Vol.", min: 0, max: 2, step: 0.05 },
        ],
    },
    {
        title: "Master Compressor (Loudness/Punch)",
        fields: [
            { kind: "slider", key: "compressorThreshold", label: "Threshold (dB)", min: -40, max: 0, step: 1 },
            { kind: "slider", key: "compressorRatio", label: "Ratio", min: 1, max: 20, step: 0.5 },
        ],
    },
];

const CSS = `
#audioBtn, #audioPanel { font-family: "Segoe UI", system-ui, sans-serif; color: #eaf2ff; }
#audioBtn {
  position: fixed; right: 24px; top: 60px; z-index: 30; cursor: pointer;
  padding: 7px 12px; font-size: 13px; font-weight: 600; letter-spacing: .3px;
  background: rgba(14,18,36,.72); border: 1px solid rgba(160,180,255,.28); border-radius: 10px;
  backdrop-filter: blur(6px);
}
#audioBtn:hover { background: rgba(30,38,72,.85); }
#audioPanel {
  position: fixed; right: 24px; top: 104px; z-index: 30; width: 310px;
  max-height: calc(100vh - 130px); display: none; flex-direction: column;
  background: rgba(10,13,28,.88); border: 1px solid rgba(160,180,255,.25); border-radius: 14px;
  backdrop-filter: blur(10px); box-shadow: 0 10px 40px rgba(0,0,0,.5); font-size: 13px;
}
#audioPanel.open { display: flex; }
#audioPanel .lp-head { padding: 12px 14px 8px; font-size: 15px; font-weight: 700; display: flex; justify-content: space-between; align-items: center; }
#audioPanel .lp-head button { background: none; border: 0; color: inherit; font-size: 18px; cursor: pointer; opacity: .7; }
#audioPanel .lp-body { overflow-y: auto; padding: 0 14px 6px; flex: 1; }
#audioPanel h4 { margin: 12px 0 6px; font-size: 11px; letter-spacing: 1.6px; text-transform: uppercase; color: #9fb4ff; }
#audioPanel .row { display: grid; grid-template-columns: 1fr auto; align-items: center; gap: 2px 8px; margin: 7px 0; }
#audioPanel .row .val { font-variant-numeric: tabular-nums; opacity: .7; font-size: 12px; }
#audioPanel .row input[type=range] { grid-column: 1 / 3; width: 100%; accent-color: #7f98ff; }
#audioPanel .opts { padding: 8px 14px 0; border-top: 1px solid rgba(160,180,255,.15); }
#audioPanel .opts label { display: flex; align-items: center; gap: 8px; margin: 4px 0; cursor: pointer; }
#audioPanel .foot { display: flex; gap: 8px; padding: 10px 14px 12px; align-items: center; }
#audioPanel .foot button {
  flex: 1; padding: 9px 0; font-size: 13px; font-weight: 700; cursor: pointer; border-radius: 9px;
  border: 1px solid rgba(160,180,255,.3); background: rgba(255,255,255,.07); color: inherit;
}
#audioPanel .foot button.save { background: linear-gradient(180deg,#6f8fff,#4f6be0); border-color: transparent; }
#audioPanel .foot button:hover { filter: brightness(1.15); }
#audioPanel .status { padding: 0 14px 10px; min-height: 16px; font-size: 12px; color: #8fe3a8; }
#audioPanel .status.dirty { color: #ffd34d; }
`;

export class AudioPanel {
    private readonly panel: HTMLDivElement;
    private readonly btn: HTMLButtonElement;
    private readonly status: HTMLDivElement;
    private readonly live: HTMLInputElement;
    private readonly syncers: Array<() => void> = [];
    private draft: AudioSettings;
    private saved: AudioSettings;
    private open = false;

    constructor() {
        this.saved = getAudioSettings();
        this.draft = { ...this.saved };

        const style = document.createElement("style");
        style.textContent = CSS;
        document.head.appendChild(style);

        this.btn = document.createElement("button");
        this.btn.id = "audioBtn";
        this.btn.textContent = "🔊 Audio (M)";
        this.btn.addEventListener("click", () => this.toggle());
        document.body.appendChild(this.btn);

        this.panel = document.createElement("div");
        this.panel.id = "audioPanel";
        document.body.appendChild(this.panel);

        // Header
        const head = document.createElement("div");
        head.className = "lp-head";
        head.innerHTML = "<span>Audio Settings</span>";
        const close = document.createElement("button");
        close.textContent = "✕";
        close.title = "Close";
        close.addEventListener("click", () => this.setOpen(false));
        head.appendChild(close);
        this.panel.appendChild(head);

        // Controls
        const body = document.createElement("div");
        body.className = "lp-body";
        for (const sec of SECTIONS) {
            const h = document.createElement("h4");
            h.textContent = sec.title;
            body.appendChild(h);
            for (const f of sec.fields) body.appendChild(this.buildRow(f));
        }
        this.panel.appendChild(body);

        // Options
        const opts = document.createElement("div");
        opts.className = "opts";
        this.live = this.buildCheck(opts, "Live preview (apply while editing)");
        this.live.checked = true; // default to true for audio
        this.live.addEventListener("change", () => {
            if (this.live.checked) setAudioSettings(this.draft);
            else setAudioSettings(this.saved);
            this.updateStatus();
        });
        this.panel.appendChild(opts);

        // Buttons
        const foot = document.createElement("div");
        foot.className = "foot";
        const save = document.createElement("button");
        save.className = "save";
        save.textContent = "Save";
        save.title = "Apply and remember it";
        save.addEventListener("click", () => this.save());
        const defaults = document.createElement("button");
        defaults.textContent = "Defaults";
        defaults.title = "Load the original look (press Save to apply)";
        defaults.addEventListener("click", () => {
            this.draft = { ...DEFAULT_AUDIO_SETTINGS };
            this.syncUI();
            if (this.live.checked) setAudioSettings(this.draft);
            this.updateStatus();
        });
        foot.append(save, defaults);
        this.panel.appendChild(foot);

        this.status = document.createElement("div");
        this.status.className = "status";
        this.panel.appendChild(this.status);

        // Events
        this.panel.addEventListener("keydown", (e) => {
            e.stopPropagation();
            if (e.key === "Escape") this.setOpen(false);
        });
        this.panel.addEventListener("keyup", (e) => e.stopPropagation());
        this.panel.addEventListener("focusin", () => window.dispatchEvent(new Event("blur")));

        window.addEventListener("keydown", (e) => {
            if (e.code === "KeyM" && !e.repeat && !e.ctrlKey && !e.metaKey && !e.altKey) this.toggle();
        });

        this.syncUI();
    }

    toggle(): void {
        this.setOpen(!this.open);
    }

    private setOpen(on: boolean): void {
        if (on === this.open) return;
        this.open = on;
        this.panel.classList.toggle("open", on);
        if (on) {
            this.saved = getAudioSettings();
            this.draft = { ...this.saved };
            this.syncUI();
            this.updateStatus();
        } else {
            // Closing without saving puts the saved look back
            setAudioSettings(this.saved);
            (document.activeElement as HTMLElement | null)?.blur?.();
        }
    }

    private save(): void {
        setAudioSettings(this.draft, true);
        this.saved = getAudioSettings();
        this.status.className = "status";
        this.status.textContent = "✓ Saved: applied to the audio";
    }

    private isDirty(): boolean {
        return JSON.stringify(this.draft) !== JSON.stringify(this.saved);
    }

    private updateStatus(): void {
        if (this.isDirty()) {
            this.status.className = "status dirty";
            this.status.textContent = this.live.checked
                ? "Previewing: press Save to keep it"
                : "Unsaved changes: press Save to apply";
        } else {
            this.status.className = "status";
            this.status.textContent = "";
        }
    }

    private onEdit(): void {
        if (this.live.checked) setAudioSettings(this.draft);
        this.updateStatus();
    }

    private syncUI(): void {
        for (const s of this.syncers) s();
    }

    private buildCheck(parent: HTMLElement, text: string): HTMLInputElement {
        const label = document.createElement("label");
        const input = document.createElement("input");
        input.type = "checkbox";
        label.append(input, document.createTextNode(text));
        parent.appendChild(label);
        return input;
    }

    private buildRow(f: Field): HTMLElement {
        const row = document.createElement("div");
        row.className = "row";
        const name = document.createElement("span");
        name.textContent = f.label;
        row.appendChild(name);

        const key = f.key;
        const val = document.createElement("span");
        val.className = "val";
        const input = document.createElement("input");
        input.type = "range";
        input.min = String(f.min);
        input.max = String(f.max);
        input.step = String(f.step);
        const decimals = f.step >= 1 ? 0 : f.step >= 0.1 ? 1 : 2;
        input.addEventListener("input", () => {
            const v = Number(input.value);
            this.draft[key] = v;
            val.textContent = v.toFixed(decimals);
            this.onEdit();
        });
        row.append(val, input);
        this.syncers.push(() => {
            input.value = String(this.draft[key]);
            val.textContent = this.draft[key].toFixed(decimals);
        });

        return row;
    }
}
