import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState, type CSSProperties } from "react";
import car1 from "@/assets/trophy-truck.png.asset.json";
import car2 from "@/assets/land-cruiser-prado-90.png.asset.json";
import car3 from "@/assets/land-cruiser-79.png.asset.json";
import background from "@/assets/desert-gate.png.asset.json";
import { Button } from "@/components/ui/button";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Revolt Reborn — Choose Your Machine" },
      { name: "description", content: "Select your rally car and enter the Revolt Reborn championship." },
      { property: "og:title", content: "Revolt Reborn — Choose Your Machine" },
      { property: "og:description", content: "Select your rally car and enter the championship." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: CarSelect,
});

const CARS = [
  { id: "trophy-truck", name: "TROPHY TRUCK", tag: "Custom Rally Prototype", img: car1.url, hue: "var(--vehicle-truck)",
    stats: { Speed: 82, Handling: 90, Acceleration: 88, Grip: 76 }, hp: 420, weight: "1,180 kg", drive: "AWD" },
  { id: "prado-90", name: "LAND CRUISER PRADO", tag: "Toyota · 90 Series", img: car2.url, hue: "var(--vehicle-prado)",
    stats: { Speed: 78, Handling: 84, Acceleration: 97, Grip: 88 }, hp: 510, weight: "1,320 kg", drive: "AWD" },
  { id: "land-cruiser-79", name: "LAND CRUISER 79", tag: "Toyota · 70 Series Pickup", img: car3.url, hue: "var(--vehicle-pickup)",
    stats: { Speed: 96, Handling: 80, Acceleration: 85, Grip: 82 }, hp: 560, weight: "1,240 kg", drive: "RWD" },
] as const;

function CarSelect() {
  const [i, setI] = useState(0);
  const [entered, setEntered] = useState(false);
  const car = CARS[i] ?? CARS[0];
  const go = (d: number) => setI((p) => (p + d + CARS.length) % CARS.length);

  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key === "ArrowRight") go(1);
      if (e.key === "ArrowLeft") go(-1);
      if (e.key === "Enter") setEntered(true);
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, []);

  return (
    <main
      className="relative min-h-screen overflow-hidden bg-background"
      style={{ "--car": car.hue } as CSSProperties}
    >
      <img src={background.url} alt="Gate of the desert rally entrance" className="pointer-events-none absolute inset-0 h-full w-full object-cover object-center" />
      <div className="pointer-events-none absolute inset-0 desert-shade" />

      {/* Top bar */}
      <header className="relative z-10 flex items-center justify-between px-6 py-5 md:px-12">
        <div className="font-display text-sm tracking-[0.4em] text-muted-foreground">
          REVOLT <span className="text-foreground">REBORN</span>
        </div>
        <div className="font-display text-xs tracking-[0.3em] text-muted-foreground">
          GARAGE · {String(i + 1).padStart(2, "0")}/{String(CARS.length).padStart(2, "0")}
        </div>
      </header>

      <section className="relative z-10 grid gap-8 px-6 md:px-12 lg:grid-cols-[1fr_380px]">
        {/* Car stage */}
        <div className="relative">
          <p className="font-display text-xs tracking-[0.5em]" style={{ color: car.hue }}>
            {car.tag.toUpperCase()}
          </p>
          <h1 key={car.id + "t"} className="glow-text animate-car-in font-display text-3xl font-black leading-tight sm:text-4xl xl:text-6xl break-words">
            {car.name}
          </h1>
          <img
            key={car.id}
            src={car.img}
            alt={car.name}
            width={1536}
            height={864}
             className="animate-car-in mt-4 aspect-video w-full object-contain drop-shadow-2xl"
          />
          <div className="mt-2 flex items-center justify-center gap-6">
            <Button variant="outline" onClick={() => go(-1)} aria-label="Previous car"
              className="clip-corner h-12 border border-border bg-card px-6 py-3 font-display text-lg transition hover:bg-secondary">←</Button>
            <div className="flex gap-2">
              {CARS.map((c, n) => (
                <Button variant="ghost" key={c.id} onClick={() => setI(n)} aria-label={c.name} aria-pressed={n === i}
                  className="h-2 min-w-0 rounded-full p-0 transition-all"
                  style={{ width: n === i ? 40 : 14, background: n === i ? car.hue : "var(--muted)" }} />
              ))}
            </div>
            <Button variant="outline" onClick={() => go(1)} aria-label="Next car"
              className="clip-corner h-12 border border-border bg-card px-6 py-3 font-display text-lg transition hover:bg-secondary">→</Button>
          </div>
        </div>

        {/* Spec panel */}
        <aside className="clip-corner self-center border border-border bg-card p-6 backdrop-blur-xl">
          <div className="mb-5 grid grid-cols-3 gap-3 text-center">
            {[["POWER", `${car.hp} HP`], ["WEIGHT", car.weight], ["DRIVE", car.drive]].map(([l, v]) => (
              <div key={l} className="border border-border bg-background/40 py-3">
                <div className="text-[10px] tracking-[0.3em] text-muted-foreground">{l}</div>
                <div className="font-display text-sm font-bold">{v}</div>
              </div>
            ))}
          </div>
          <div className="space-y-4">
            {Object.entries(car.stats).map(([k, v]) => (
              <div key={k}>
                <div className="mb-1 flex justify-between text-sm font-semibold tracking-widest">
                  <span className="text-muted-foreground">{k.toUpperCase()}</span>
                  <span className="font-display">{v}</span>
                </div>
                <div className="relative h-2 overflow-hidden bg-secondary">
                  <div className="h-full transition-all duration-700"
                    style={{ width: `${v}%`, background: `linear-gradient(90deg, transparent, ${car.hue})`, boxShadow: `0 0 12px ${car.hue}` }} />
                </div>
              </div>
            ))}
          </div>

          <Button
            onClick={() => setEntered(true)}
            className="clip-corner group relative mt-8 h-auto w-full overflow-hidden py-5 font-display text-lg font-black tracking-[0.3em] text-primary-foreground transition hover:brightness-110"
            style={{ background: car.hue, boxShadow: `0 0 40px color-mix(in oklab, ${car.hue} 60%, transparent)` }}
          >
            <span className="absolute inset-0 animate-sweep bg-gradient-to-r from-transparent via-foreground/30 to-transparent" />
            <span className="relative">ENTER RACE</span>
          </Button>
          <p className="mt-3 text-center text-xs tracking-widest text-muted-foreground">← → TO BROWSE · ENTER TO START</p>
        </aside>
      </section>

      {entered && (
        <div className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-background/95 backdrop-blur-md animate-in fade-in">
          <p className="font-display text-xs tracking-[0.5em] text-muted-foreground">LOADING STAGE</p>
          <h2 className="glow-text mt-3 px-6 text-center font-display text-3xl font-black md:text-5xl">{car.name}</h2>
          <div className="mt-8 h-1 w-64 overflow-hidden bg-secondary">
            <div className="h-full w-1/2 animate-sweep" style={{ background: car.hue }} />
          </div>
          <Button variant="ghost" onClick={() => setEntered(false)} className="mt-10 text-sm tracking-widest text-muted-foreground hover:text-foreground">
            BACK TO GARAGE
          </Button>
        </div>
      )}
    </main>
  );
}
