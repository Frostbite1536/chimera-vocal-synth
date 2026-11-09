/**
 * Record a duet show (`?show=<id>`) to a video, frame by frame, in headless Chromium.
 * Usage: bun tools/capture-show.ts <page url> <audio.wav> <out.mp4>
 *          [--fps 30] [--size 1920x1080] [--from s] [--to s] [--jobs n]
 * CHROMIUM=/path/to/chrome launches a browser other than the one playwright-core pins.
 *
 * The page never runs in real time: its timers and animation frames run on Playwright's fake
 * clock, and the transport's audio clock (AudioContext currentTime and output timestamp) reads the
 * frame being drawn. Each video frame is exactly that moment of the song however slowly it renders
 * (without a GPU, a six-head show takes about a second a frame). The clock jumps a whole frame at a
 * time, so the page draws once per video frame with that frame's step.
 *
 * --jobs splits the span into that many chunks, each in its own browser. A chunk starts drawing a
 * second early, without keeping those frames, so its motion (particles, the face) is under way at
 * the join. Frames go as JPEG to ffmpeg (libx264); the chunks are joined, then the audio (the show's
 * mix as a WAV, cut to the same span) is added as AAC.
 */
import { chromium } from "playwright-core";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

/** frames [k0, k1) of the whole span into a video-only file */
async function chunk(k0: number, k1: number, file: string, tag: string): Promise<string[]> {
  const t0 = from + k0 / fps;
  const warm = Math.min(k0, Math.round(WARM * fps));
  const s = await openShow(t0 - warm / fps);
  const ff = Bun.spawn(
    ["ffmpeg", "-y", "-loglevel", "error", "-f", "image2pipe", "-framerate", String(fps), "-c:v", "mjpeg", "-i", "-",
      "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p", "-r", String(fps), file],
    { stdin: "pipe", stderr: "inherit" },
  );
  const started = performance.now();
  for (let k = k0 - warm; k < k1; k++) {
    await s.setT(from + k / fps);
    await s.page.clock.fastForward(1000 / fps);
    if (k < k0) continue;
    const shot = await s.cdp.send("Page.captureScreenshot", { format: "jpeg", quality: 92 });
    ff.stdin.write(Buffer.from(shot.data, "base64"));
    const n = k - k0 + 1;
    if (n % (fps * 15) === 0) {
      const el = (performance.now() - started) / 1000;
      console.log(`[${tag}] ${n}/${k1 - k0} frames, ${((el / n) * (k1 - k - 1) / 60).toFixed(0)} min to go`);
    }
  }
  ff.stdin.end();
  const code = await ff.exited;
  await s.browser.close();
  if (code !== 0) throw new Error(`[${tag}] ffmpeg exited ${code}`);
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
const dir = mkdtempSync(join(tmpdir(), "capture-show-"));
const bounds = Array.from({ length: jobs + 1 }, (_, i) => Math.round((i * frames) / jobs));
const parts = Array.from({ length: jobs }, (_, i) => join(dir, `part-${i}.mp4`));
const started = performance.now();
console.log(`${frames} frames (${from}–${to.toFixed(2)} s at ${fps} fps), ${jobs} at a time`);
const errors = (await Promise.all(parts.map((p, i) => chunk(bounds[i], bounds[i + 1], p, `${i + 1}/${jobs}`)))).flat();
writeFileSync(join(dir, "parts.txt"), parts.map((p) => `file '${p}'`).join("\n"));
const mux = Bun.spawnSync(
  ["ffmpeg", "-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", join(dir, "parts.txt"),
    "-ss", String(from), "-t", String(to - from), "-i", audio,
    "-map", "0:v", "-map", "1:a", "-c:v", "copy", "-c:a", "aac", "-b:a", "256k", "-shortest", "-movflags", "+faststart", out],
  { stderr: "inherit" },
);
rmSync(dir, { recursive: true, force: true });
if (errors.length) console.error(`page errors:\n${[...new Set(errors)].slice(0, 10).join("\n")}`);
if (mux.exitCode !== 0) throw new Error(`ffmpeg (join and audio) exited ${mux.exitCode}`);
console.log(`${out}: ${frames} frames at ${fps} fps in ${((performance.now() - started) / 60000).toFixed(1)} min`);
