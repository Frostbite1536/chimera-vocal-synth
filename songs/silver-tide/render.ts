/**
 * Render every layer of the score with `chimera render notes`, in parallel.
 * Usage: bun songs/silver-tide/render.ts [outdir, default out/silver-tide] [--jobs n]
 *
 * Writes <outdir>/layers/<id>.json (the melody) and <id>.wav (32-bit float), plus tracks.json for
 * the mixer. A layer whose melody file is unchanged and already rendered is skipped. Build the CLI
 * first: cargo build --release -p chimera-cli
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { cpus } from "node:os";
import { join, resolve } from "node:path";
import { BPM, buildTracks } from "./score.ts";

const args = process.argv.slice(2);
const jobsAt = args.indexOf("--jobs");
const jobs = jobsAt >= 0 ? Number(args.splice(jobsAt, 2)[1]) : cpus().length;
const outDir = resolve(args[0] ?? "out/silver-tide");
const cli = resolve(import.meta.dir, "../../target/release/chimera");
if (!existsSync(cli)) throw new Error(`${cli} missing: cargo build --release -p chimera-cli`);

const tracks = buildTracks();
const dir = join(outDir, "layers");
mkdirSync(dir, { recursive: true });
writeFileSync(join(outDir, "tracks.json"), JSON.stringify(tracks, null, 1));

const todo: { id: string; json: string; wav: string; body: string }[] = [];
for (const t of tracks) {
  const json = join(dir, `${t.id}.json`);
  const wav = join(dir, `${t.id}.wav`);
  const text = JSON.stringify({ bpm: BPM, vibrato: t.vibrato, t0: t.t0, lyrics: t.lyrics, notes: t.notes });
  const same = existsSync(json) && readFileSync(json, "utf8") === text;
  if (!same) writeFileSync(json, text);
  if (!same || !existsSync(wav)) todo.push({ id: t.id, json, wav, body: t.body });
}
console.log(`${tracks.length} layers, ${todo.length} to render, ${jobs} at a time`);

const started = performance.now();
let done = 0;
const failures: string[] = [];
async function worker() {
  for (let job = todo.shift(); job; job = todo.shift()) {
    const p = Bun.spawn([cli, "render", "notes", job.json, job.wav.replace(/\.wav$/, ""), job.body, "--float"], { stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = [await new Response(p.stdout).text(), await new Response(p.stderr).text(), await p.exited];
    done++;
    if (code !== 0) {
      failures.push(`${job.id}: ${err.trim()}`);
      console.error(`FAIL ${job.id}: ${err.trim()}`);
    } else {
      console.log(`[${done}] ${out.trim()}  (${((performance.now() - started) / 1000).toFixed(0)} s)`);
    }
  }
}
await Promise.all(Array.from({ length: jobs }, worker));
if (failures.length) {
  console.error(`${failures.length} layers failed`);
  process.exit(1);
}
