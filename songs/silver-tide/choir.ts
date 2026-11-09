/**
 * Build the choir page's data for "Silver Tide": all 100 voices' articulators and loudness, packed
 * into public/shows/silver-tide/choir.{json,bin} (gitignored, as every show is). Open `?choir=silver-tide`.
 * Usage: bun songs/silver-tide/choir.ts [outdir, default out/silver-tide] [--jobs n]
 *
 * Needs render.ts's melodies and stems. Each voice is sung again with `--artic` (the articulators at
 * 100 Hz; the sound is the same, and is thrown away): ~45 min on 4 cores, skipping voices already done.
 * Loudness comes from the stems the mix used. The motion is kept at 50 Hz, a byte per channel.
 */
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { cpus } from "node:os";
import { join, resolve } from "node:path";
import { readWav } from "../../tools/lib/wav.ts";
import type { Track } from "./score.ts";

const args = process.argv.slice(2);
const jobsAt = args.indexOf("--jobs");
const jobs = jobsAt >= 0 ? Number(args.splice(jobsAt, 2)[1]) : cpus().length;
const outDir = resolve(args[0] ?? "out/silver-tide");
const root = resolve(import.meta.dir, "../..");
const cli = join(root, "target/release/chimera");
const show = join(root, "public/shows/silver-tide");
const articDir = join(outDir, "artic");
const RATE = 50;
const FS = 48000;
const tracks: Track[] = await Bun.file(join(outDir, "tracks.json")).json();

/** the grid's reading order: the melody first, high voices to low, the drone last */
const ORDER = ["lead", "harmony", "lowlead", "descant", "shimmer", "soprano", "alto", "counter", "swell", "ostinato", "tenor", "bass", "sub", "drone"];
const NAMES: Record<string, string> = { lowlead: "Low lead", sub: "Sub bass" };
const ordered = [...tracks].sort((a, b) => ORDER.indexOf(a.group) - ORDER.indexOf(b.group) || a.id.localeCompare(b.id));
if (ordered.some((t) => !ORDER.includes(t.group))) throw new Error("a group missing from ORDER");

// ---- the articulators, sung again with --artic
mkdirSync(articDir, { recursive: true });
const todo = ordered.filter((t) => !existsSync(join(articDir, `${t.id}.json`)));
console.log(`${ordered.length} voices, ${todo.length} to sing with --artic, ${jobs} at a time`);
const started = performance.now();
let done = 0;
async function worker() {
  for (let t = todo.shift(); t; t = todo.shift()) {
    const stem = join(articDir, t.id);
    const tmp = `${stem}.json.part`;
    const p = Bun.spawn([cli, "render", "notes", join(outDir, "layers", `${t.id}.json`), stem, t.body, "--artic", tmp], { stdout: "ignore", stderr: "pipe" });
    const [err, code] = [await new Response(p.stderr).text(), await p.exited];
    rmSync(`${stem}.wav`, { force: true });
    if (code !== 0) throw new Error(`${t.id}: ${err.trim()}`);
    // only a finished recording gets its final name, so a stopped run resumes cleanly
    copyFileSync(tmp, join(articDir, `${t.id}.json`));
    rmSync(tmp);
    console.log(`[${++done}] ${t.id}  (${((performance.now() - started) / 1000).toFixed(0)} s)`);
  }
}
await Promise.all(Array.from({ length: jobs }, worker));

// ---- pack: frames × voices × channels, a byte each
interface Artic {
  rate: number;
  keys: string[];
  frames: number[][];
}
const first: Artic = await Bun.file(join(articDir, `${ordered[0].id}.json`)).json();
const keys = first.keys;
const channels = [...keys, "level"];
const mix = readWav(join(outDir, "silver-tide.wav"));
const frames = Math.ceil((mix.channels[0].length / FS) * RATE) + 1;
const nV = ordered.length, nC = channels.length;
const raw = new Float32Array(frames * nV * nC);

/** loudness at RATE: 20 ms RMS against the voice's sung level, -24 dB … 0 dB → 0 … 1, a 150 ms release */
function levels(x: Float32Array): Float32Array {
  const W = FS / RATE;
  const ms: number[] = [];
  for (let i = 0; i < frames; i++) {
    let s = 0;
    const a = Math.round(i * W - W / 2);
    for (let j = Math.max(0, a); j < Math.min(x.length, a + W); j++) s += x[j] * x[j];
    ms.push(s / W);
  }
  const top = Math.max(...ms);
  const on = ms.filter((m) => m > top * 1e-3);
  const sung = on.reduce((p, q) => p + q, 0) / Math.max(1, on.length);
  const out = new Float32Array(frames);
  const rel = Math.exp(-1 / (0.15 * RATE));
  let y = 0;
  for (let i = 0; i < frames; i++) {
    const db = 10 * Math.log10(Math.max(1e-12, ms[i] / sung));
    const target = Math.max(0, Math.min(1, (db + 24) / 24));
    y = target > y ? target : target + (y - target) * rel;
    out[i] = y;
  }
  return out;
}

for (let v = 0; v < nV; v++) {
  const t = ordered[v];
  const a: Artic = await Bun.file(join(articDir, `${t.id}.json`)).json();
  if (a.keys.join() !== keys.join()) throw new Error(`${t.id}: other articulator keys`);
  const step = a.rate / RATE;
  const lv = levels(readWav(join(outDir, "layers", `${t.id}.wav`)).channels[0]);
  for (let i = 0; i < frames; i++) {
    const fr = a.frames[Math.min(a.frames.length - 1, Math.round(i * step))];
    const o = (i * nV + v) * nC;
    for (let c = 0; c < keys.length; c++) raw[o + c] = fr[c];
    raw[o + keys.length] = lv[i];
  }
}
const ranges: [number, number][] = channels.map((_, c) => {
  let lo = Infinity, hi = -Infinity;
  for (let k = c; k < raw.length; k += nC) {
    lo = Math.min(lo, raw[k]);
    hi = Math.max(hi, raw[k]);
  }
  return hi > lo ? [lo, hi] : [lo, lo + 1];
});
const bytes = new Uint8Array(raw.length);
for (let k = 0; k < raw.length; k++) {
  const [lo, hi] = ranges[k % nC];
  bytes[k] = Math.round(((raw[k] - lo) / (hi - lo)) * 255);
}
mkdirSync(show, { recursive: true });
copyFileSync(join(import.meta.dir, "silver-tide.mp3"), join(show, "mix.mp3"));
writeFileSync(join(show, "choir.bin"), bytes);
const counts: Record<string, number> = {};
const voices = ordered.map((t) => {
  counts[t.group] = (counts[t.group] ?? 0) + 1;
  const name = NAMES[t.group] ?? t.group[0].toUpperCase() + t.group.slice(1);
  return { name: `${name} ${counts[t.group]}`, group: t.group, body: t.body };
});
writeFileSync(join(show, "choir.json"), JSON.stringify({ title: "Silver Tide · 100 voices", audio: "mix.mp3", data: "choir.bin", rate: RATE, frames, channels, ranges, voices }, null, 1));
console.log(`${show}/choir.bin: ${(bytes.length / 1e6).toFixed(1)} MB (${frames} frames × ${nV} voices × ${nC} channels); open ?choir=silver-tide`);
