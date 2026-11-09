/**
 * The takes with a mouth (`chimera::lipsync`, for Weft) through the wasm build match the native
 * `chimera speak | sing | call` byte for byte: the same 16-bit samples, word timings, notes and
 * mouth. Needs `bun run wasm` and cargo (it runs the native CLI).
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { call, initChimera } from "../src/wasm/chimera.ts";

const ROOT = new URL("..", import.meta.url).pathname;
const WASM = `${ROOT}target/wasm32-unknown-unknown/release/chimera_wasm.wasm`;

function native(args: string[]): { json: Record<string, unknown>; data: Uint8Array } {
  const dir = mkdtempSync(join(tmpdir(), "chimera-lipsync-"));
  try {
    const out = join(dir, "take.wav");
    const proc = Bun.spawnSync(["cargo", "run", "-q", "--release", "-p", "chimera-cli", "--", args[0], out, ...args.slice(1)], { cwd: ROOT });
    if (proc.exitCode !== 0) throw new Error(proc.stderr.toString());
    const wav = readFileSync(out);
    return { json: JSON.parse(proc.stdout.toString()), data: new Uint8Array(wav.subarray(44)) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function same(wasm: Record<string, unknown>, nat: { json: Record<string, unknown>; data: Uint8Array }) {
  const { pcm16, ...rest } = wasm;
  const { file: _file, ...expected } = nat.json;
  expect(rest).toEqual(expected);
  expect(Buffer.from(pcm16 as string, "base64").equals(Buffer.from(nat.data))).toBe(true);
}

describe("lipsync takes", () => {
  test.skipIf(!existsSync(WASM))("speak, sing and call through wasm match the native CLI byte for byte", async () => {
    await initChimera(readFileSync(WASM));
    call("g2pLoad", { text: gunzipSync(readFileSync(`${ROOT}public/data/cmudict.txt.gz`)).toString("utf8") });

    same(call("speak", { text: "Oh, five thousand.", body: "female" }), native(["speak", "--text", "Oh, five thousand.", "--body", "female"]));

    const melody = { bpm: 120, lyrics: "Hel-lo moon", notes: [[60, 1], [62, 1], [0, 1], [64, 2]] };
    const dir = mkdtempSync(join(tmpdir(), "chimera-melody-"));
    try {
      writeFileSync(join(dir, "m.json"), JSON.stringify(melody));
      same(call("sing", { melody, body: "child" }), native(["sing", "--melody", join(dir, "m.json"), "--body", "child"]));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }

    same(call("call", { creature: "seal", call: "zap" }), native(["call", "--creature", "seal", "--call", "zap"]));
  }, 120_000);
});
