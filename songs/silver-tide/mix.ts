/**
 * Mix the rendered layers of "Silver Tide" to a stereo master.
 * Usage: bun songs/silver-tide/mix.ts [outdir, default out/silver-tide]
 *
 * Each layer is level-matched, filtered, panned and automated by its group and the song's
 * sections, then summed. A ping-pong delay on the lead and a long FDN hall carry the rest.
 * Writes <outdir>/silver-tide.wav (16-bit stereo, 48 kHz) and, when ffmpeg is on the PATH, an MP3.
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { readWav, writeWav } from "../../tools/lib/wav.ts";
import { BEATS_PER_BAR, BPM, FORM, SECTION_START, T0, TOTAL_BEATS, type Track } from "./score.ts";

const FS = 48000;
const outDir = resolve(process.argv[2] ?? "out/silver-tide");
const tracks: Track[] = JSON.parse(readFileSync(join(outDir, "tracks.json"), "utf8"));
const BAR = (BEATS_PER_BAR * 60) / BPM;
const TAIL = 9;
const N = Math.round(FS * (T0 + TOTAL_BEATS * (60 / BPM) + TAIL));

// ---------------------------------------------------------------- groups and automation

interface Group {
  /** level of the whole group (dB), before the per-section moves */
  db: number;
  hp: number;
  lp: number;
  /** reverb send (linear) */
  send: number;
  /** ping-pong delay send */
  delay?: number;
}

const GROUPS: Record<string, Group> = {
  lead: { db: 0, hp: 110, lp: 15000, send: 0.3, delay: 0.25 },
  double: { db: -6, hp: 140, lp: 11000, send: 0.45, delay: 0.1 },
  harmony: { db: -7, hp: 150, lp: 11000, send: 0.5 },
  lowlead: { db: -10, hp: 90, lp: 7000, send: 0.45 },
  soprano: { db: -8, hp: 200, lp: 8500, send: 0.75 },
  alto: { db: -9, hp: 170, lp: 8000, send: 0.75 },
  tenor: { db: -9, hp: 110, lp: 7000, send: 0.7 },
  bass: { db: -8, hp: 60, lp: 5000, send: 0.55 },
  sub: { db: -9, hp: 35, lp: 1800, send: 0.2 },
  ostinato: { db: -11, hp: 220, lp: 10000, send: 0.45, delay: 0.12 },
  descant: { db: -9, hp: 300, lp: 10000, send: 0.85 },
  counter: { db: -12, hp: 120, lp: 8000, send: 0.7 },
  swell: { db: -8, hp: 120, lp: 9000, send: 0.9 },
  shimmer: { db: -14, hp: 400, lp: 11000, send: 0.95 },
  drone: { db: -13, hp: 80, lp: 4500, send: 0.6 },
};

const groupOf = (t: Track) => (t.group === "lead" && t.id !== "lead-01" ? "double" : t.group);

/** per section: a level (dB) or a ramp [from, to] across it; sections not named stay at 0 dB */
type Lv = number | [number, number];
const PADS: Record<string, Lv> = {
  intro: [-16, -3],
  verse1: -5,
  chorus1: 0,
  interlude: -2,
  verse2: -4,
  chorus2: 0,
  bridge: [-6, 0],
  final: 1,
  tag: [1, -1],
  outro: [-2, -26],
};
const LEVELS: Record<string, Record<string, Lv>> = {
  soprano: PADS,
  alto: PADS,
  tenor: PADS,
  bass: { ...PADS, intro: [-12, -3] },
  sub: { ...PADS, verse1: -3, outro: [-3, -30] },
  double: { verse1: -8, chorus1: -2, interlude: -3, verse2: -6, chorus2: -1, bridge: -3, final: 0, tag: 0 },
  harmony: { chorus1: -2, bridge: -3 },
  lowlead: { chorus1: -2 },
  ostinato: { intro: [-8, -2], verse1: -2, interlude: 0, verse2: -1, final: 1 },
  descant: { intro: [-10, -2], bridge: [-4, 1], outro: [-1, -24] },
  counter: { verse2: -3 },
  shimmer: { outro: [-2, -26] },
  drone: { intro: [-14, -2], outro: [-2, -30] },
};

/** breakpoints (bar, dB) for a group */
function automation(group: string): [number, number][] {
  if (group === "swell") {
    // each swell rises over its span and falls into the chorus
    const pts: [number, number][] = [];
    for (const [s, len] of [[SECTION_START.chorus1, 2], [SECTION_START.chorus2, 2], [SECTION_START.bridge, 2], [SECTION_START.final, 4]] as const) {
      pts.push([s - 0.25, -24], [s + len * 0.8, 0], [s + len, -6]);
    }
    return pts;
  }
  const lv = LEVELS[group] ?? {};
  const pts: [number, number][] = [];
  for (const s of FORM) {
    const v = lv[s.name] ?? 0;
    const [a, b] = typeof v === "number" ? [v, v] : v;
    const start = SECTION_START[s.name];
    // half a bar to move to a new level
    pts.push([start + (pts.length ? 0.5 : 0), a], [start + s.chords.length, b]);
  }
  return pts;
}

function dbAt(pts: [number, number][], bar: number): number {
  if (bar <= pts[0][0]) return pts[0][1];
  for (let i = 1; i < pts.length; i++) {
    if (bar <= pts[i][0]) {
      const [x0, y0] = pts[i - 1];
      const [x1, y1] = pts[i];
      return x1 === x0 ? y1 : y0 + ((y1 - y0) * (bar - x0)) / (x1 - x0);
    }
  }
  return pts[pts.length - 1][1];
}

// ---------------------------------------------------------------- DSP

/** RBJ biquad, in place */
function biquad(x: Float32Array, type: "hp" | "lp", f: number, q = Math.SQRT1_2): void {
  const w = (2 * Math.PI * f) / FS;
  const c = Math.cos(w);
  const al = Math.sin(w) / (2 * q);
  let b0: number, b1: number, b2: number;
  if (type === "lp") [b0, b1, b2] = [(1 - c) / 2, 1 - c, (1 - c) / 2];
  else [b0, b1, b2] = [(1 + c) / 2, -(1 + c), (1 + c) / 2];
  const a0 = 1 + al;
  const [a1, a2] = [(-2 * c) / a0, (1 - al) / a0];
  [b0, b1, b2] = [b0 / a0, b1 / a0, b2 / a0];
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const y = b0 * x[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1;
    x1 = x[i];
    y2 = y1;
    y1 = y;
    x[i] = y;
  }
}

/** RMS over the 50 ms windows within 30 dB of the loudest one (the layer's sung level) */
function activeRms(x: Float32Array): number {
  const W = Math.round(FS * 0.05);
  const ms: number[] = [];
  for (let i = 0; i + W <= x.length; i += W) {
    let s = 0;
    for (let j = i; j < i + W; j++) s += x[j] * x[j];
    ms.push(s / W);
  }
  const top = Math.max(...ms);
  const on = ms.filter((m) => m > top * 1e-3);
  return Math.sqrt(on.reduce((a, b) => a + b, 0) / Math.max(1, on.length));
}

/** stereo ping-pong delay (dotted eighth), damped feedback */
function pingPong(inL: Float32Array, inR: Float32Array): [Float32Array, Float32Array] {
  const d = Math.round(FS * (60 / BPM) * 0.75);
  const outL = new Float32Array(N);
  const outR = new Float32Array(N);
  const fb = 0.38;
  let lpL = 0, lpR = 0;
  const a = Math.exp((-2 * Math.PI * 3500) / FS);
  for (let i = 0; i < N; i++) {
    const dl = i >= d ? outL[i - d] : 0;
    const dr = i >= d ? outR[i - d] : 0;
    lpL = (1 - a) * (0.5 * (inL[i] + inR[i]) + fb * dr) + a * lpL;
    lpR = (1 - a) * (fb * dl) + a * lpR;
    outL[i] = lpL;
    outR[i] = lpR;
  }
  return [outL, outR];
}

/** an 8-line feedback delay network hall: diffusers, Householder feedback, damped lines */
function hall(inL: Float32Array, inR: Float32Array, rt60: number): [Float32Array, Float32Array] {
  const pre = Math.round(FS * 0.035);
  const lens = [1559, 1871, 2161, 2437, 2777, 3079, 3413, 3761].map((l) => Math.round(l * 1.9));
  const g = lens.map((l) => Math.pow(10, (-3 * l) / (FS * rt60)));
  const lines = lens.map((l) => new Float32Array(l));
  const pos = new Array(8).fill(0);
  const damp = new Array(8).fill(0);
  const dampA = Math.exp((-2 * Math.PI * 5200) / FS);
  // series all-pass diffusers on the mono-ish input, one chain per side
  const apLens = [[142, 379, 107, 277], [151, 401, 113, 293]];
  const aps = apLens.map((ls) => ls.map((l) => ({ buf: new Float32Array(l), p: 0 })));
  const diffuse = (side: number, v: number) => {
    for (const ap of aps[side]) {
      const z = ap.buf[ap.p];
      const y = -0.7 * v + z;
      ap.buf[ap.p] = v + 0.7 * y;
      ap.p = (ap.p + 1) % ap.buf.length;
      v = y;
    }
    return v;
  };
  const outL = new Float32Array(N);
  const outR = new Float32Array(N);
  const o = new Float64Array(8);
  for (let i = 0; i < N; i++) {
    const l = diffuse(0, i >= pre ? inL[i - pre] : 0);
    const r = diffuse(1, i >= pre ? inR[i - pre] : 0);
    let sum = 0;
    for (let k = 0; k < 8; k++) {
      damp[k] = (1 - dampA) * lines[k][pos[k]] + dampA * damp[k];
      o[k] = damp[k] * g[k];
      sum += o[k];
    }
    const h = (2 / 8) * sum;
    let yl = 0, yr = 0;
    for (let k = 0; k < 8; k++) {
      const inp = k % 2 === 0 ? l : r;
      lines[k][pos[k]] = o[k] - h + inp * (k & 2 ? -1 : 1);
      pos[k] = (pos[k] + 1) % lines[k].length;
      yl += o[k] * (k & 1 ? -1 : 1);
      yr += o[k] * (k & 4 ? -1 : 1);
    }
    outL[i] = yl * 0.35;
    outR[i] = yr * 0.35;
  }
  return [outL, outR];
}

/** look-ahead peak limiter to `ceiling`, in place */
function limit(L: Float32Array, R: Float32Array, ceiling: number): number {
  const look = Math.round(FS * 0.005);
  const rel = Math.exp(-1 / (FS * 0.12));
  const need = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const p = Math.max(Math.abs(L[i]), Math.abs(R[i]));
    need[i] = p > ceiling ? ceiling / p : 1;
  }
  // the gain reaches each peak's need `look` samples early and releases slowly
  let gain = 1;
  let minGain = 1;
  const win: number[] = [];
  for (let i = 0; i < N; i++) {
    // running minimum of need over [i, i + look]
    const j = i + look < N ? i + look : N - 1;
    while (win.length && need[win[win.length - 1]] >= need[j]) win.pop();
    win.push(j);
    while (win[0] < i) win.shift();
    const target = need[win[0]];
    gain = target < gain ? target : target + (gain - target) * rel;
    minGain = Math.min(minGain, gain);
    L[i] *= gain;
    R[i] *= gain;
  }
  return minGain;
}

// ---------------------------------------------------------------- the mix

const dryL = new Float32Array(N), dryR = new Float32Array(N);
const sendL = new Float32Array(N), sendR = new Float32Array(N);
const dlyL = new Float32Array(N), dlyR = new Float32Array(N);
const counts: Record<string, number> = {};
for (const t of tracks) counts[groupOf(t)] = (counts[groupOf(t)] ?? 0) + 1;
const curves: Record<string, Float32Array> = {};
const HOP = 64;
for (const g of Object.keys(counts)) {
  const pts = automation(g);
  const c = new Float32Array(Math.ceil(N / HOP) + 1);
  for (let h = 0; h < c.length; h++) c[h] = Math.pow(10, dbAt(pts, ((h * HOP) / FS - T0) / BAR) / 20);
  curves[g] = c;
}

const t0 = performance.now();
for (const t of tracks) {
  const g = groupOf(t);
  const G = GROUPS[g];
  const x0 = readWav(join(outDir, "layers", `${t.id}.wav`)).channels[0];
  const x = new Float32Array(N);
  x.set(x0.subarray(0, Math.min(N, x0.length)));
  biquad(x, "hp", G.hp);
  biquad(x, "lp", G.lp);
  // level-match the layers: each sings at -20 dBFS RMS, then the group sets the balance and the
  // group's voices sum as if they were one (−10·log10 n)
  const rms = activeRms(x);
  const k = (rms > 0 ? 0.1 / rms : 0) * Math.pow(10, (G.db - 10 * Math.log10(counts[g])) / 20);
  const th = ((t.pan + 1) * Math.PI) / 4;
  const [pl, pr] = [Math.cos(th) * k, Math.sin(th) * k];
  const curve = curves[g];
  for (let i = 0; i < N; i++) {
    const v = x[i] * curve[(i / HOP) | 0];
    const l = v * pl, r = v * pr;
    dryL[i] += l;
    dryR[i] += r;
    sendL[i] += l * G.send;
    sendR[i] += r * G.send;
    if (G.delay) {
      dlyL[i] += l * G.delay;
      dlyR[i] += r * G.delay;
    }
  }
}
console.log(`summed ${tracks.length} layers in ${((performance.now() - t0) / 1000).toFixed(1)} s`);

const [echoL, echoR] = pingPong(dlyL, dlyR);
for (let i = 0; i < N; i++) {
  sendL[i] += echoL[i] * 0.5;
  sendR[i] += echoR[i] * 0.5;
}
biquad(sendL, "hp", 180);
biquad(sendR, "hp", 180);
biquad(sendL, "lp", 9000);
biquad(sendR, "lp", 9000);
const [wetL, wetR] = hall(sendL, sendR, 5.2);

// balance: the hall sits ~3 dB under the dry choir, the echoes further back
const energy = (a: Float32Array, b: Float32Array) => {
  let s = 0;
  for (let i = 0; i < N; i++) s += a[i] * a[i] + b[i] * b[i];
  return Math.sqrt(s / N);
};
const wetGain = (0.7 * energy(dryL, dryR)) / Math.max(1e-12, energy(wetL, wetR));
const L = new Float32Array(N), R = new Float32Array(N);
for (let i = 0; i < N; i++) {
  L[i] = dryL[i] + wetL[i] * wetGain + echoL[i] * 0.35;
  R[i] = dryR[i] + wetR[i] * wetGain + echoR[i] * 0.35;
}
biquad(L, "hp", 28);
biquad(R, "hp", 28);

// loudness: −17 dBFS RMS over the song, then the limiter keeps peaks under −1 dBFS
const g = Math.pow(10, -17 / 20) / energy(L, R) * Math.SQRT2;
for (let i = 0; i < N; i++) {
  L[i] *= g;
  R[i] *= g;
}
const minGain = limit(L, R, Math.pow(10, -1 / 20));
// fade the hall's last seconds
const fade = Math.round(FS * 4);
for (let i = 0; i < fade; i++) {
  const w = Math.cos(((i / fade) * Math.PI) / 2) ** 2;
  L[N - fade + i] *= w;
  R[N - fade + i] *= w;
}
const out = join(outDir, "silver-tide.wav");
writeWav(out, [L, R], FS);
console.log(`${out}: ${(N / FS).toFixed(1)} s, limiter at most ${(20 * Math.log10(minGain)).toFixed(1)} dB`);

const ff = Bun.spawnSync(["ffmpeg", "-y", "-loglevel", "error", "-i", out, "-codec:a", "libmp3lame", "-b:a", "256k",
  "-metadata", "title=Silver Tide", "-metadata", "artist=CHIMERA (100 voices)", out.replace(/\.wav$/, ".mp3")]);
if (ff.exitCode === 0) console.log(out.replace(/\.wav$/, ".mp3"));
else console.log("no MP3 (ffmpeg missing or failed)");
