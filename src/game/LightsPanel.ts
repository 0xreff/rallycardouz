import {
    DEFAULT_LIGHT_SETTINGS,
    getLightSettings,
    setBrakePreview,
    setLightSettings,
    type LightSettings,
} from "./CarLights";

/**
 * In-game light editor. Press L (or click the 💡 button, top right) to open it.
 *
 *  - Move the sliders / pick colours: nothing changes on the car yet.
 *  - SAVE applies the settings to the vehicle lights AND stores them in the browser,
 *    so they are still there next time the game loads.
 *  - "Live preview" applies every change instantly (without saving) while the panel is
 *    open; closing the panel without saving puts the saved look back.
 *  - "Show brake lights" holds the tail lights in their braking look so you can tune
 *    them without driving.
 *  - Defaults loads the original look into the panel (press Save to apply it).
 *
 * The panel swallows the keyboard while it has focus, so typing / arrow keys in it
 * never steer the car.
 */

type NumKey = { [K in keyof LightSettings]: LightSettings[K] extends number ? K : never }[keyof LightSettings];
type BoolKey = { [K in keyof LightSettings]: LightSettings[K] extends boolean ? K : never }[keyof LightSettings];
type StrKey = { [K in keyof LightSettings]: LightSettings[K] extends string ? K : never }[keyof LightSettings];

type Field =
    | { kind: "toggle"; key: BoolKey; label: string }
    | { kind: "color"; key: StrKey; label: string }
    | { kind: "slider"; key: NumKey; label: string; min: number; max: number; step: number };

interface Section { title: string; fields: Field[] }

const SECTIONS: Section[] = [
    {
        title: "Headlights",
        fields: [
            { kind: "toggle", key: "headOn", label: "Headlights on" },
            { kind: "color", key: "headColor", label: "Light colour" },
            { kind: "slider", key: "spotIntensity", label: "Road light brightness", min: 0, max: 1000, step: 10 },
            { kind: "slider", key: "spotAngle", label: "Road light width", min: 0.15, max: 0.9, step: 0.01 },
            { kind: "slider", key: "spotPenumbra", label: "Edge softness", min: 0, max: 1, step: 0.01 },
            { kind: "slider", key: "spotSpread", label: "Space between the 2 pools", min: 0, max: 5, step: 0.1 },
            { kind: "slider", key: "headCore", label: "Lamp brightness", min: 0, max: 10, step: 0.1 },
            { kind: "slider", key: "beamStrength", label: "Light shaft strength", min: 0, max: 0.6, step: 0.01 },
            { kind: "slider", key: "beamWidth", label: "Light shaft width", min: 0.3, max: 2.5, step: 0.05 },
            { kind: "slider", key: "beamLength", label: "Light shaft length", min: 6, max: 30, step: 1 },
        ],
    },
    {
        title: "Tail lights",
        fields: [
            { kind: "toggle", key: "tailOn", label: "Tail lights on" },
            { kind: "color", key: "tailColor", label: "Colour" },
            { kind: "slider", key: "tailGlowIdle", label: "Glow (lights on)", min: 0, max: 8, step: 0.1 },
            { kind: "slider", key: "tailGlowBrake", label: "Glow (braking)", min: 0, max: 20, step: 0.5 },
            { kind: "slider", key: "ledBar", label: "LED bar brightness", min: 0, max: 3, step: 0.1 },
            { kind: "slider", key: "haloSizeIdle", label: "Halo size (lights on)", min: 0, max: 1.5, step: 0.05 },
            { kind: "slider", key: "haloSizeBrake", label: "Halo size (braking)", min: 0, max: 3, step: 0.05 },
            { kind: "slider", key: "haloStrength", label: "Halo strength", min: 0, max: 3, step: 0.1 },
            { kind: "slider", key: "groundRedIdle", label: "Red on ground (lights on)", min: 0, max: 10, step: 0.1 },
            { kind: "slider", key: "groundRedBrake", label: "Red on ground (braking)", min: 0, max: 20, step: 0.5 },
        ],
    },
];

const CSS = `
#lightsBtn, #lightsPanel { font-family: "Segoe UI", system-ui, sans-serif; color: #eaf2ff; }
#lightsBtn {
  position: fixed; right: 24px; top: 20px; z-index: 30; cursor: pointer;
  padding: 7px 12px; font-size: 13px; font-weight: 600; letter-spacing: .3px;
  background: rgba(14,18,36,.72); border: 1px solid rgba(160,180,255,.28); border-radius: 10px;
  backdrop-filter: blur(6px);
}
#lightsBtn:hover { background: rgba(30,38,72,.85); }
#lightsPanel {
  position: fixed; right: 24px; top: 64px; z-index: 30; width: 310px;
  max-height: calc(100vh - 90px); display: none; flex-direction: column;
  background: rgba(10,13,28,.88); border: 1px solid rgba(160,180,255,.25); border-radius: 14px;
  backdrop-filter: blur(10px); box-shadow: 0 10px 40px rgba(0,0,0,.5); font-size: 13px;
}
#lightsPanel.open { display: flex; }
#lightsPanel .lp-head { padding: 12px 14px 8px; font-size: 15px; font-weight: 700; display: flex; justify-content: space-between; align-items: center; }
#lightsPanel .lp-head button { background: none; border: 0; color: inherit; font-size: 18px; cursor: pointer; opacity: .7; }
#lightsPanel .lp-body { overflow-y: auto; padding: 0 14px 6px; flex: 1; }
#lightsPanel h4 { margin: 12px 0 6px; font-size: 11px; letter-spacing: 1.6px; text-transform: uppercase; color: #9fb4ff; }
#lightsPanel .row { display: grid; grid-template-columns: 1fr auto; align-items: center; gap: 2px 8px; margin: 7px 0; }
#lightsPanel .row .val { font-variant-numeric: tabular-nums; opacity: .7; font-size: 12px; }
#lightsPanel .row input[type=range] { grid-column: 1 / 3; width: 100%; accent-color: #7f98ff; }
#lightsPanel .row input[type=color] { width: 44px; height: 24px; border: 0; padding: 0; background: none; cursor: pointer; }
#lightsPanel .row input[type=checkbox] { width: 18px; height: 18px; accent-color: #7f98ff; }
#lightsPanel .opts { padding: 8px 14px 0; border-top: 1px solid rgba(160,180,255,.15); }
#lightsPanel .opts label { display: flex; align-items: center; gap: 8px; margin: 4px 0; cursor: pointer; }
#lightsPanel .foot { display: flex; gap: 8px; padding: 10px 14px 12px; align-items: center; }
#lightsPanel .foot button {
  flex: 1; padding: 9px 0; font-size: 13px; font-weight: 700; cursor: pointer; border-radius: 9px;
  border: 1px solid rgba(160,180,255,.3); background: rgba(255,255,255,.07); color: inherit;
}
#lightsPanel .foot button.save { background: linear-gradient(180deg,#6f8fff,#4f6be0); border-color: transparent; }
#lightsPanel .foot button:hover { filter: brightness(1.15); }
#lightsPanel .status { padding: 0 14px 10px; min-height: 16px; font-size: 12px; color: #8fe3a8; }
#lightsPanel .status.dirty { color: #ffd34d; }
`;

export class LightsPanel {
    private readonly panel: HTMLDivElement;
    private readonly btn: HTMLButtonElement;
    private readonly status: HTMLDivElement;
    private readonly live: HTMLInputElement;
    private readonly brake: HTMLInputElement;
    private readonly syncers: Array<() => void> = [];
    private draft: LightSettings;
    private saved: LightSettings;
    private open = false;

    constructor() {
        this.saved = getLightSettings();
        this.draft = { ...this.saved };

        const style = document.createElement("style");
        style.textContent = CSS;
        document.head.appendChild(style);

        this.btn = document.createElement("button");
        this.btn.id = "lightsBtn";
        this.btn.textContent = "💡 Lights (L)";
        this.btn.addEventListener("click", () => this.toggle());
        document.body.appendChild(this.btn);

        this.panel = document.createElement("div");
        this.panel.id = "lightsPanel";
        document.body.appendChild(this.panel);

        // Header
        const head = document.createElement("div");
        head.className = "lp-head";
        head.innerHTML = "<span>Vehicle lights</span>";
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
        this.brake = this.buildCheck(opts, "Show brake lights");
        this.live.addEventListener("change", () => {
            if (this.live.checked) setLightSettings(this.draft);
            else setLightSettings(this.saved);
            this.updateStatus();
        });
        this.brake.addEventListener("change", () => setBrakePreview(this.brake.checked));
        this.panel.appendChild(opts);

        // Buttons
        const foot = document.createElement("div");
        foot.className = "foot";
        const save = document.createElement("button");
        save.className = "save";
        save.textContent = "Save";
        save.title = "Apply to the vehicle lights and remember it";
        save.addEventListener("click", () => this.save());
        const defaults = document.createElement("button");
        defaults.textContent = "Defaults";
        defaults.title = "Load the original look (press Save to apply)";
        defaults.addEventListener("click", () => {
            this.draft = { ...DEFAULT_LIGHT_SETTINGS };
            this.syncUI();
            if (this.live.checked) setLightSettings(this.draft);
            this.updateStatus();
        });
        foot.append(save, defaults);
        this.panel.appendChild(foot);

        this.status = document.createElement("div");
        this.status.className = "status";
        this.panel.appendChild(this.status);

        // Keep the keyboard inside the panel (no steering while you type / use arrows),
        // and release any key the game still thinks is held when focus moves here.
        this.panel.addEventListener("keydown", (e) => {
            e.stopPropagation();
            if (e.key === "Escape") this.setOpen(false);
        });
        this.panel.addEventListener("keyup", (e) => e.stopPropagation());
        this.panel.addEventListener("focusin", () => window.dispatchEvent(new Event("blur")));

        window.addEventListener("keydown", (e) => {
            if (e.code === "KeyL" && !e.repeat && !e.ctrlKey && !e.metaKey && !e.altKey) this.toggle();
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
            this.saved = getLightSettings();
            this.draft = { ...this.saved };
            this.syncUI();
            this.updateStatus();
        } else {
            // Closing without saving puts the saved look (and normal brake lights) back.
            setLightSettings(this.saved);
            this.brake.checked = false;
            setBrakePreview(false);
            (document.activeElement as HTMLElement | null)?.blur?.();
        }
    }

    private save(): void {
        setLightSettings(this.draft, true);
        this.saved = getLightSettings();
        this.status.className = "status";
        this.status.textContent = "✓ Saved: applied to the vehicle lights";
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
        if (this.live.checked) setLightSettings(this.draft);
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

        if (f.kind === "toggle") {
            const key = f.key;
            const input = document.createElement("input");
            input.type = "checkbox";
            input.addEventListener("change", () => {
                this.draft[key] = input.checked;
                this.onEdit();
            });
            row.appendChild(input);
            this.syncers.push(() => { input.checked = this.draft[key]; });
        } else if (f.kind === "color") {
            const key = f.key;
            const input = document.createElement("input");
            input.type = "color";
            input.addEventListener("input", () => {
                this.draft[key] = input.value;
                this.onEdit();
            });
            row.appendChild(input);
            this.syncers.push(() => { input.value = this.draft[key]; });
        } else {
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
        }
        return row;
    }
}