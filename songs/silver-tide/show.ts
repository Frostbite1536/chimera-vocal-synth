/**
 * Build the Duet page's show for "Silver Tide": the 100-voice mix with six section leaders on 3D
 * heads, each re-sung with `--tele` (motion recording) from its melody. Open `?show=silver-tide`.
 * Usage: bun songs/silver-tide/show.ts [outdir, default out/silver-tide]
 *
 * Needs the melodies from render.ts (outdir/layers/*.json) and the committed mix. Writes
 * public/shows/silver-tide/ (gitignored, as every show is). The six renders take ~3 minutes.
 * --tele leaves the audio sample for sample as the stem the mix used, so the heads match the mix.
 */
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { BPM, T0, type Track } from "./score.ts";

const outDir = resolve(process.argv[2] ?? "out/silver-tide");
const root = resolve(import.meta.dir, "../..");
const cli = join(root, "target/release/chimera");
const show = join(root, "public/shows/silver-tide");
const tracks: Track[] = await Bun.file(join(outDir, "tracks.json")).json();

/** on screen in this order: three across, two rows */
export const LEADERS = [
  { id: "soprano-01", name: "Soprano" },
  { id: "lead-01", name: "Lead" },
  { id: "descant-01", name: "Descant" },
  { id: "alto-01", name: "Alto" },
  { id: "tenor-01", name: "Tenor" },
  { id: "bass-01", name: "Bass" },
];

mkdirSync(show, { recursive: true });
copyFileSync(join(import.meta.dir, "silver-tide.mp3"), join(show, "mix.mp3"));
await Promise.all(
  LEADERS.map(async ({ id }) => {
    const t = tracks.find((x) => x.id === id);
    if (!t) throw new Error(`${id} not in tracks.json`);
    const melody = join(outDir, "layers", `${id}.json`);
    if (!existsSync(melody)) throw new Error(`${melody} missing: run render.ts first`);
    copyFileSync(melody, join(show, `${id}.json`));
    const p = Bun.spawn([cli, "render", "notes", melody, join(outDir, "tele", id), t.body, "--tele", join(show, `${id}.tele`)], { stderr: "inherit" });
    if ((await p.exited) !== 0) throw new Error(`${id}: render failed`);
    console.log(`${id}: recorded`);
  }),
);
writeFileSync(
  join(show, "show.json"),
  JSON.stringify(
    {
      title: "Silver Tide · 100 voices",
      audio: "mix.mp3",
      bpm: BPM,
      downbeat: T0,
      voices: LEADERS.map(({ id, name }) => ({ name, tele: `${id}.tele`, melody: `${id}.json` })),
    },
    null,
    1,
  ),
);
console.log(`${show}: open ?show=silver-tide`);
