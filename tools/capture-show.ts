/**
 * Record a duet show (`?show=<id>`) to a video, frame by frame, in headless Chromium.
 * Usage: bun tools/capture-show.ts <page url> <audio.wav> <out.mp4> [--fps 30] [--size 1920x1080] [--from s] [--to s]
 *
 * The page never runs in real time: its timers and animation frames run on Playwright's fake clock,
 * and the transport's audio clock (AudioContext currentTime and output timestamp) reads the frame
 * being drawn. Each video frame is exactly that moment of the song however slowly it renders. Two
 * animation frames are drawn per video frame (the fake clock's 16 ms tick), each with the playhead
 * at its own time. The audio is the given WAV (the show's mix), cut to the same span; frames
 * are piped as JPEG into ffmpeg (libx264, AAC).
 */
import { chromium } from "playwright-core";

const args = process.argv.slice(2);
const opt = (name: string, def: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args.splice(i, 2)[1] : def;
};
const fps = Number(opt("fps", "30"));
const [width, height] = opt("size", "1920x1080").split("x").map(Number);
const from = Number(opt("from", "0"));
const toArg = opt("to", "");
const [url, audio, out] = args;
if (!url || !audio || !out) {
  console.error("usage: bun tools/capture-show.ts <page url> <audio.wav> <out.mp4> [--fps 30] [--size 1920x1080] [--from s] [--to s]");
  process.exit(1);
}

const browser = await chromium.launch({
  headless: true,
  args: ["--autoplay-policy=no-user-gesture-required", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist", "--mute-audio"],
});
const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
const errors: string[] = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));

// the audio clock is the frame's time (s), set before every frame
await page.addInitScript(() => {
  const w = window as unknown as { __captureT: number };
  w.__captureT = 0;
  const P = BaseAudioContext.prototype;
  Object.defineProperty(P, "currentTime", { get: () => w.__captureT, configurable: true });
  Object.defineProperty(AudioContext.prototype, "outputLatency", { get: () => 0, configurable: true });
  Object.defineProperty(AudioContext.prototype, "baseLatency", { get: () => 0, configurable: true });
  AudioContext.prototype.getOutputTimestamp = () => ({ contextTime: w.__captureT, performanceTime: performance.now() });
});
await page.clock.install({ time: 0 });
await page.goto(url);
// loading needs no timers; wait for Play to come alive, then let the heads finish their opening turn
const play = page.getByRole("button", { name: /^(Play|Again)$/ });
await play.waitFor({ state: "visible", timeout: 120_000 });
for (let i = 0; i < 600 && (await play.isDisabled()); i++) await page.waitForTimeout(100);
if (await play.isDisabled()) throw new Error(`the show did not load: ${errors.join("; ")}`);
const setT = (t: number) => page.evaluate((v) => ((window as unknown as { __captureT: number }).__captureT = v), t);
await setT(0);
await play.click();
await page.evaluate((t) => {
  // the transport plays from 0 at context time 0; a later start is the same playhead offset
  (window as unknown as { __captureT: number }).__captureT = t;
}, from);
const duration = await page.evaluate(async () => {
  const el = document.querySelector<HTMLInputElement>('input[aria-label="Position in the song"]');
  return Number(el?.max ?? 0);
});
const to = toArg ? Number(toArg) : duration;
// settle the cameras (the opening turn is 1.6 s) with the playhead held at the first frame
await page.clock.runFor(2500);

const ff = Bun.spawn(
  ["ffmpeg", "-y", "-loglevel", "error", "-f", "image2pipe", "-framerate", String(fps), "-c:v", "mjpeg", "-i", "-",
    "-ss", String(from), "-t", String(to - from), "-i", audio,
    "-map", "0:v", "-map", "1:a", "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "256k", "-shortest", "-movflags", "+faststart", out],
  { stdin: "pipe", stderr: "inherit" },
);
const cdp = await page.context().newCDPSession(page);
const frames = Math.round((to - from) * fps);
const started = performance.now();
const half = 1000 / fps / 2;
for (let k = 0; k < frames; k++) {
  const t = from + k / fps;
  await setT(t - 0.5 / fps);
  await page.clock.runFor(half);
  await setT(t);
  await page.clock.runFor(half);
  const shot = await cdp.send("Page.captureScreenshot", { format: "jpeg", quality: 92 });
  ff.stdin.write(Buffer.from(shot.data, "base64"));
  if (k % (fps * 10) === 0) {
    const el = (performance.now() - started) / 1000;
    console.log(`${(k / fps).toFixed(0)} s of ${(frames / fps).toFixed(0)}  (${el.toFixed(0)} s elapsed, ${k ? ((el / k) * (frames - k) / 60).toFixed(0) : "?"} min to go)`);
  }
}
ff.stdin.end();
const code = await ff.exited;
await browser.close();
if (errors.length) console.error(`page errors:\n${errors.slice(0, 10).join("\n")}`);
if (code !== 0) throw new Error(`ffmpeg exited ${code}`);
console.log(`${out}: ${frames} frames at ${fps} fps`);
