/**
 * Record a duet show (`?show=<id>`) to a video, frame by frame, in headless Chromium.
 * Usage: bun tools/capture-show.ts <page url> <audio.wav> <out.mp4>
 *          [--fps 30] [--size 1920x1080] [--from s] [--to s] [--jobs n]
 * CHROMIUM=/path/to/chrome launches a browser other than the one playwright-core pins.
 *
 * Capture from `bun run build && bun run preview` (http://127.0.0.1:5318/?show=<id>), not the dev
 * server: an hour-long capture outlives many edits, and the dev server hot-reloads each into the
 * open pages, remounting the show (its transport stops, the heads reset) partway through the video.
 *
 * The page never runs in real time: its timers and animation frames run on Playwright's fake
 * clock, and the transport's audio clock (AudioContext currentTime and output timestamp) reads the
 * frame being drawn. Each video frame is exactly that moment of the song however slowly it renders
 * (without a GPU, a six-head show takes about a second a frame). The clock jumps a whole frame at a
 * time, so the page draws once per video frame with that frame's step.
 *
 * --jobs splits the span into that many chunks, each in its own browser. A chunk starts drawing a
 * second early, without keeping those frames, so its motion (particles, the face) is under way at
 * the join. Frames go as JPEG to ffmpeg (libx264), ten seconds to a file in `<out>.parts/`; the
 * files are joined, then the audio (the show's mix as a WAV, cut to the same span) is added as AAC.
 *
 * A stopped capture resumes: run the same command again. A segment gets its final name only once
 * it is whole, and a chunk starts at its first missing segment (a long capture can outlive the
 * process running it). The parts are deleted once the video is made.
 */
import { chromium } from "playwright-core";
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const args = process.argv.slice(2);
const opt = (name: string, def: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args.splice(i, 2)[1] : def;
};
const fps = Number(opt("fps", "30"));
const [width, height] = opt("size", "1920x1080").split("x").map(Number);
const from = Number(opt("from", "0"));
const toArg = opt("to", "");
const jobs = Math.max(1, Number(opt("jobs", "1")));
const [url, audio, out] = args;
if (!url || !audio || !out) {
  console.error("usage: bun tools/capture-show.ts <page url> <audio.wav> <out.mp4> [--fps 30] [--size 1920x1080] [--from s] [--to s] [--jobs n]");
  process.exit(1);
}
/** seconds drawn before a chunk's first kept frame */
const WARM = 1;
/** frames to a segment file */
const SEG = 10 * fps;

type W = { __captureT: number };

/** a page with the show loaded, its cameras settled, the transport playing at `t` */
async function openShow(t: number) {
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.CHROMIUM || undefined,
    args: ["--autoplay-policy=no-user-gesture-required", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist", "--mute-audio"],
  });
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  // the audio clock is the frame's time (s), set before every frame
  await page.addInitScript(() => {
    const w = window as unknown as W;
    w.__captureT = 0;
    Object.defineProperty(BaseAudioContext.prototype, "currentTime", { get: () => w.__captureT, configurable: true });
    Object.defineProperty(AudioContext.prototype, "outputLatency", { get: () => 0, configurable: true });
    Object.defineProperty(AudioContext.prototype, "baseLatency", { get: () => 0, configurable: true });
    AudioContext.prototype.getOutputTimestamp = () => ({ contextTime: w.__captureT, performanceTime: performance.now() });
  });
  await page.clock.install({ time: 0 });
  await page.goto(url);
  // loading needs no timers: wait for Play to come alive
  const play = page.getByRole("button", { name: /^(Play|Again)$/ });
  await play.waitFor({ state: "visible", timeout: 120_000 });
  for (let i = 0; i < 1200 && (await play.isDisabled()); i++) await page.waitForTimeout(100);
  if (await play.isDisabled()) throw new Error(`the show did not load: ${errors.join("; ")}`);
  const setT = (v: number) => page.evaluate((x) => ((window as unknown as W).__captureT = x), v);
  // the transport starts at context time 0, so its playhead is the context time from here on
  await setT(0);
  await play.click();
  await setT(t);
  // the cameras' opening turn (1.6 s; the views step at most 50 ms a frame)
  for (let i = 0; i < 40; i++) await page.clock.fastForward(50);
  const duration = await page.evaluate(() => Number(document.querySelector<HTMLInputElement>('input[aria-label="Position in the song"]')?.max ?? 0));
  const cdp = await page.context().newCDPSession(page);
  return { browser, page, setT, cdp, duration, errors };
}

/** a chunk's segment files: frames [k0, k1) of the span, SEG to a file */
const segments = (k0: number, k1: number) =>
  Array.from({ length: Math.ceil((k1 - k0) / SEG) }, (_, i) => {
    const a = k0 + i * SEG, b = Math.min(k1, a + SEG);
    return { a, b, file: join(dir, `seg-${String(a).padStart(6, "0")}-${b}.mp4`) };
  });

/** frames [k0, k1) of the span into its segment files, from the first one not yet made */
async function chunk(k0: number, k1: number, tag: string): Promise<string[]> {
  const todo = segments(k0, k1).filter((g) => !existsSync(g.file));
  if (!todo.length) return [];
  const first = todo[0].a;
  const warm = Math.min(first, Math.round(WARM * fps));
  const s = await openShow(from + (first - warm) / fps);
  const draw = async (k: number) => {
    await s.setT(from + k / fps);
    await s.page.clock.fastForward(1000 / fps);
  };
  for (let k = first - warm; k < first; k++) await draw(k);
  const started = performance.now();
  let n = 0;
  const total = todo.reduce((p, g) => p + g.b - g.a, 0);
  for (let k = first; k < k1; ) {
    const g = segments(k0, k1).find((x) => x.a === k)!;
    const part = `${g.file}.part`;
    const ff = Bun.spawn(
      ["ffmpeg", "-y", "-loglevel", "error", "-f", "image2pipe", "-framerate", String(fps), "-c:v", "mjpeg", "-i", "-",
        "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p", "-r", String(fps), "-f", "mp4", part],
      { stdin: "pipe", stderr: "inherit" },
    );
    for (; k < g.b; k++) {
      await draw(k);
      const shot = await s.cdp.send("Page.captureScreenshot", { format: "jpeg", quality: 92 });
      ff.stdin.write(Buffer.from(shot.data, "base64"));
      if (++n % (fps * 15) === 0) {
        const el = (performance.now() - started) / 1000;
        console.log(`[${tag}] ${n}/${total} frames, ${((el / n) * (total - n) / 60).toFixed(0)} min to go`);
      }
    }
    ff.stdin.end();
    const code = await ff.exited;
    if (code !== 0) throw new Error(`[${tag}] ffmpeg exited ${code}`);
    renameSync(part, g.file);
    // a segment made earlier: draw through it unrecorded, so the motion carries on
    for (let next = segments(k0, k1).find((x) => x.a === k); next && existsSync(next.file); next = segments(k0, k1).find((x) => x.a === k))
      for (; k < next.b; k++) await draw(k);
  }
  await s.browser.close();
  return s.errors;
}

// the span: the show's length unless --to says otherwise
let to = Number(toArg);
if (!toArg) {
  const s = await openShow(0);
  to = s.duration;
  await s.browser.close();
}
const frames = Math.round((to - from) * fps);
// the segments, kept across runs; named by frame, so a capture with other bounds makes its own.
// Absolute: ffmpeg's concat list resolves a relative path against the list's own folder.
const dir = resolve(`${out}.parts`);
mkdirSync(dir, { recursive: true });
const bounds = Array.from({ length: jobs + 1 }, (_, i) => Math.round((i * frames) / jobs));
const started = performance.now();
const all = bounds.slice(0, -1).flatMap((k0, i) => segments(k0, bounds[i + 1]));
const made = all.filter((g) => existsSync(g.file)).length;
console.log(`${frames} frames (${from}–${to.toFixed(2)} s at ${fps} fps), ${jobs} at a time${made ? `; ${made}/${all.length} segments already made` : ""}`);
const errors = (await Promise.all(bounds.slice(0, -1).map((k0, i) => chunk(k0, bounds[i + 1], `${i + 1}/${jobs}`)))).flat();
writeFileSync(join(dir, "parts.txt"), all.map((g) => `file '${g.file}'`).join("\n"));
const mux = Bun.spawnSync(
  ["ffmpeg", "-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", join(dir, "parts.txt"),
    "-ss", String(from), "-t", String(to - from), "-i", audio,
    "-map", "0:v", "-map", "1:a", "-c:v", "copy", "-c:a", "aac", "-b:a", "256k", "-shortest", "-movflags", "+faststart", out],
  { stderr: "inherit" },
);
if (errors.length) console.error(`page errors:\n${[...new Set(errors)].slice(0, 10).join("\n")}`);
// the parts go only once the video is made: they are hours of drawing
if (mux.exitCode !== 0) throw new Error(`ffmpeg (join and audio) exited ${mux.exitCode}; the segments are kept in ${dir}`);
rmSync(dir, { recursive: true, force: true });
console.log(`${out}: ${frames} frames at ${fps} fps in ${((performance.now() - started) / 60000).toFixed(1)} min`);
