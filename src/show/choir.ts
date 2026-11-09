/**
 * A choir show's motion: many voices' articulators and loudness over time, packed small enough to
 * load in a browser (a full telemetry recording is ~11 MB a voice for four minutes; this is ~0.2).
 *
 * `choir.json` describes `choir.bin`: `frames` × voices × channels bytes, frame-major. A channel is
 * an articulator (`keys`, as `chimera render notes --artic` names them) or `level` (how loud the
 * voice is, 0 silent … 1 its full sung level); each byte maps linearly onto its channel's range.
 * Frame i is the state at i / rate s on the mix's clock.
 */
export interface ChoirVoice {
  name: string;
  group: string;
  body: "male" | "female" | "child";
}

export interface ChoirFile {
  title: string;
  audio: string;
  data: string;
  rate: number;
  frames: number;
  /** channel names: articulator keys, then "level" */
  channels: string[];
  /** [min, max] per channel */
  ranges: [number, number][];
  voices: ChoirVoice[];
}

export class ChoirTrack {
  readonly meta: ChoirFile;
  private readonly data: Uint8Array;
  private readonly nCh: number;
  private readonly stride: number;
  private readonly lo: Float64Array;
  private readonly span: Float64Array;
  private readonly levelCh: number;

  constructor(meta: ChoirFile, buf: ArrayBuffer) {
    this.meta = meta;
    this.nCh = meta.channels.length;
    this.stride = meta.voices.length * this.nCh;
    if (meta.ranges.length !== this.nCh) throw new Error("choir.json: one range per channel");
    if (buf.byteLength !== meta.frames * this.stride) throw new Error(`choir data is ${buf.byteLength} bytes; its description says ${meta.frames * this.stride}`);
    this.data = new Uint8Array(buf);
    this.lo = Float64Array.from(meta.ranges, (r) => r[0]);
    this.span = Float64Array.from(meta.ranges, (r) => (r[1] - r[0]) / 255);
    this.levelCh = meta.channels.indexOf("level");
  }

  /** channel values of voice v at time t (s), linearly between frames, into `out` (length = channels) */
  read(v: number, t: number, out: Float64Array): Float64Array {
    const x = Math.min(this.meta.frames - 1, Math.max(0, t * this.meta.rate));
    const i = Math.min(this.meta.frames - 2, Math.floor(x));
    const u = Math.max(0, Math.min(1, x - i));
    const a = i * this.stride + v * this.nCh;
    const b = a + this.stride;
    const d = this.data;
    for (let c = 0; c < this.nCh; c++) out[c] = this.lo[c] + this.span[c] * (d[a + c] + u * (d[b + c] - d[a + c]));
    return out;
  }

  /** the voice's level (0..1) in a read() result */
  level(values: Float64Array): number {
    return this.levelCh < 0 ? 1 : values[this.levelCh];
  }
}
