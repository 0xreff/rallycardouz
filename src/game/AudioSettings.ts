export interface AudioSettings {
    engineVolume: number;
    windVolume: number;
    crackleVolume: number;
    bovVolume: number;
    compressorThreshold: number;
    compressorRatio: number;
}

export const DEFAULT_AUDIO_SETTINGS: AudioSettings = {
    engineVolume: 0.6,
    windVolume: 0.95,
    crackleVolume: 0.8,
    bovVolume: 0.8,
    compressorThreshold: -10,
    compressorRatio: 8,
};

const STORAGE_KEY = "rallydouz.audio.v1";

function sanitize(src: Partial<AudioSettings>): AudioSettings {
    const out = { ...DEFAULT_AUDIO_SETTINGS } as Record<string, unknown>;
    const def = DEFAULT_AUDIO_SETTINGS as unknown as Record<string, unknown>;
    const inp = src as Record<string, unknown>;
    for (const k of Object.keys(def)) {
        const v = inp[k];
        if (typeof v !== "number" || !Number.isFinite(v)) continue;
        out[k] = v;
    }
    return out as unknown as AudioSettings;
}

function loadSaved(): AudioSettings {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw) return sanitize(JSON.parse(raw) as Partial<AudioSettings>);
    } catch { /* ignore */ }
    return { ...DEFAULT_AUDIO_SETTINGS };
}

let current: AudioSettings = loadSaved();
const listeners = new Set<(s: AudioSettings) => void>();

export function getAudioSettings(): AudioSettings {
    return { ...current };
}

export function setAudioSettings(next: Partial<AudioSettings>, persist = false): void {
    current = sanitize({ ...current, ...next });
    if (persist) {
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify(current)); } catch { /* ignore */ }
    }
    for (const l of listeners) l(current);
}

export function onAudioSettingsChanged(cb: (s: AudioSettings) => void): void {
    listeners.add(cb);
    cb(current); // fire immediately with current settings
}
