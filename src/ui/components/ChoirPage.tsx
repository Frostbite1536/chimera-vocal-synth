/**
 * The choir page (`?choir=<id>`): every voice of a pre-rendered song at once, each a small 2D head
 * moving as the engine moved it, lit while it sings and dimmed while it rests, over the mix.
 *
 * A choir is a folder `public/shows/<id>/` (gitignored, like every show) holding the mix,
 * `choir.json` and `choir.bin` (see src/show/choir.ts); songs/silver-tide/choir.ts makes one. A
 * hundred 3D heads would need a hundred WebGL contexts (browsers give ~16) and ~1 GB of telemetry,
 * so these are the face screen's flat profiles, drawn on one canvas from the articulators alone.
 */
import { useEffect, useRef, useState } from "react";
import { Screen } from "./Screen.tsx";
import { TransportBar } from "./TransportBar.tsx";
import { ChoirTrack, type ChoirFile } from "../../show/choir.ts";
import { Transport } from "../../show/transport.ts";
import { getModel } from "../useModel.ts";
import { VoiceModel } from "../analysis.ts";
import { AnatomyRenderer, type ViewFlags } from "../render/anatomy.ts";
import { VIEW } from "../render/profile.ts";
import { Glow, label } from "../render/vector.ts";
import { V } from "../colors.ts";
import { ARTIC_KEYS, NEUTRAL } from "../../wasm/engine.ts";
import type { BodyMix } from "../../wasm/types.ts";

const BODIES: Record<string, BodyMix> = { male: { female: 0, child: 0 }, female: { female: 1, child: 0 }, child: { female: 0, child: 1 } };
/** the profiles alone: no pressure, flow or grid (those need the full telemetry) */
const FLAT: ViewFlags = { pressure: false, particles: false, grid: false, calipers: false };
/** a part's label colour, by the family it sings in */
const GROUP_COLOUR: Record<string, string> = {
  lead: V.green, harmony: V.green, lowlead: V.green,
  soprano: V.pink, descant: V.pink, shimmer: V.pink,
  alto: V.amber, counter: V.amber, swell: V.white,
  tenor: V.red, bass: V.red, sub: V.red,
  ostinato: V.blue, drone: V.blueMid,
};
const LABEL_H = 14;

async function fetchOk(url: string): Promise<Response> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: ${r.status} ${r.statusText}`);
  return r;
}

/** the columns that make n heads (a profile is VIEW's shape, plus a label) largest in w × h */
export function choirColumns(n: number, w: number, h: number): number {
  const hw = VIEW.x1 - VIEW.x0, hh = VIEW.y1 - VIEW.y0;
  let best = 1, bestScale = 0;
  for (let cols = 1; cols <= n; cols++) {
    const rows = Math.ceil(n / cols);
    const s = Math.min(w / cols / hw, (h / rows - LABEL_H) / hh);
    if (s > bestScale) {
      bestScale = s;
      best = cols;
    }
  }
  return best;
}

export function ChoirPage(props: { id: string }) {
  const base = `${import.meta.env.BASE_URL}shows/${props.id}/`;
  const [transport, setTransport] = useState<Transport | null>(null);
  const [track, setTrack] = useState<ChoirTrack | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const t = new Transport();
    setTransport(t);
    return () => t.dispose();
  }, []);

  useEffect(() => {
    if (!transport) return;
    let live = true;
    setTrack(null);
    (async () => {
      const meta = (await (await fetchOk(base + "choir.json")).json()) as ChoirFile;
      const [audio, data] = await Promise.all([fetchOk(base + meta.audio).then((r) => r.arrayBuffer()), fetchOk(base + meta.data).then((r) => r.arrayBuffer())]);
      const tr = new ChoirTrack(meta, data);
      await transport.load(audio);
      if (live) setTrack(tr);
    })().catch((e: unknown) => live && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      live = false;
    };
  }, [base, transport]);

  if (error)
    return (
      <div className="duet">
        <p className="duet-msg error">This choir could not load: {error}</p>
      </div>
    );
  return (
    <div className="duet">
      <header className="duet-top">
        <span className="wordmark">Chimera</span>
        <span className="duet-title">{track?.meta.title ?? "Loading…"}</span>
      </header>
      <main className="duet-heads" style={{ "--cols": 1 } as React.CSSProperties}>
        {track && transport ? (
          <Screen className="duet-head" focus title={`${track.meta.voices.length} voices`} sub="lit while singing" label={`${track.meta.voices.length} singing heads`}>
            <ChoirCanvas track={track} transport={transport} />
          </Screen>
        ) : (
          <p className="duet-msg">Loading the choir…</p>
        )}
      </main>
      <TransportBar transport={transport} ready={!!track} />
    </div>
  );
}

function ChoirCanvas(props: { track: ChoirTrack; transport: Transport }) {
  const { track, transport } = props;
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current!;
    const wrap = wrapRef.current!;
    const ctx = canvas.getContext("2d")!;
    const glow = new Glow();
    const voices = track.meta.voices;
    const models = voices.map((v) => getModel(BODIES[v.body] ?? BODIES.female, 48000));
    const heads = voices.map(() => {
      const r = new AnatomyRenderer();
      r.bare = true;
      return r;
    });
    // where each articulator sits among the track's channels
    const chOf = ARTIC_KEYS.map((k) => track.meta.channels.indexOf(k));
    const values = new Float64Array(track.meta.channels.length);
    const artic = new Float64Array(ARTIC_KEYS.length);
    let w = 0, h = 0, dpr = 1, cols = 1, cw = 1, ch = 1;
    const fit = () => {
      const b = wrap.getBoundingClientRect();
      dpr = Math.min(1.5, window.devicePixelRatio || 1);
      w = b.width;
      h = b.height;
      canvas.width = Math.max(1, Math.round(w * dpr));
      canvas.height = Math.max(1, Math.round(h * dpr));
      cols = choirColumns(voices.length, w, h);
      cw = w / cols;
      ch = h / Math.ceil(voices.length / cols);
      for (const r of heads) r.resize(cw, Math.max(1, ch - LABEL_H));
    };
    const ro = new ResizeObserver(fit);
    ro.observe(wrap);
    let raf = 0;
    let last = performance.now();
    const loop = (now: number) => {
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      const t = transport.time();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalCompositeOperation = "source-over";
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      if (w > 0 && h > 0) {
        for (let v = 0; v < voices.length; v++) {
          const x = (v % cols) * cw, y = Math.floor(v / cols) * ch;
          track.read(v, t, values);
          // an articulator the file lacks stays at rest
          for (let k = 0; k < chOf.length; k++) artic[k] = chOf[k] >= 0 ? values[chOf[k]] : NEUTRAL[ARTIC_KEYS[k]];
          const a = VoiceModel.articFromArray(artic);
          const m = models[v];
          const f = m.frame(a);
          const r = heads[v];
          r.face.update(null, dt);
          ctx.save();
          ctx.translate(x, y + LABEL_H);
          ctx.beginPath();
          ctx.rect(0, 0, cw, ch - LABEL_H);
          ctx.clip();
          r.draw(ctx, m, f, a, null, FLAT, { hover: null, drag: null, dt, formants: [], slots: [], info: [] });
          ctx.restore();
          const lit = Math.max(0, Math.min(1, track.level(values)));
          // resting voices fall back into the dark
          if (lit < 1) {
            ctx.fillStyle = `rgba(0,0,0,${(0.72 * (1 - lit)).toFixed(3)})`;
            ctx.fillRect(x, y + LABEL_H, cw, ch - LABEL_H);
          }
          const vv = voices[v];
          label(ctx, vv.name.toUpperCase(), x + 4, y + LABEL_H - 3, { size: 9, color: GROUP_COLOUR[vv.group] ?? V.blue, ls: 0.1, alpha: 0.6 + 0.4 * lit });
        }
        glow.apply(canvas, ctx, dpr);
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [track, transport]);

  return (
    <div ref={wrapRef} className="anatomy">
      <canvas ref={canvasRef} aria-label="Every voice of the choir as a profile of the head, lit while it sings" role="img" />
    </div>
  );
}
