/**
 * "Silver Tide": an original Celtic new-age song for 100 CHIMERA voices.
 *
 * Everything is sung by the engine. The lead melody and lyrics are hand-written; every other part
 * is derived from one chord chart (voice-led SATB pads, an arpeggio ostinato, drones, a descant,
 * a diatonic harmony line), then spread over layers that differ in body, detune, timing, vibrato
 * and pan, the way a multitracked choir is built up in the studio.
 *
 * `buildTracks()` returns the 100 layers; each becomes one `chimera render notes` melody file.
 */

export const BPM = 72;
export const BEATS_PER_BAR = 4;
/** plan time (s) of bar 1, beat 1: room for the first consonants and breath */
export const T0 = 0.6;

export type Body = "male" | "female" | "child";

export interface Track {
  id: string;
  /** mix group (gain automation, EQ and sends are per group) */
  group: string;
  body: Body;
  /** -1 (left) … 1 (right) */
  pan: number;
  vibrato: number;
  /** plan time of bar 1 (s), with this layer's small timing offset */
  t0: number;
  /** [midi, beats]; midi 0 is a rest */
  notes: [number, number][];
  /** one syllable per sounding note (`~` holds the previous vowel) */
  lyrics: string;
}

// ---------------------------------------------------------------- form and harmony

interface Section {
  name: string;
  chords: string[];
}

const VERSE = ["Em", "C", "G", "D", "Em", "C", "Am7", "D"];
const CHORUS = ["C", "G", "D", "Em", "C", "G", "Am", "B"];

export const FORM: Section[] = [
  { name: "intro", chords: ["Em", "C", "G", "D", "Em", "C", "Am", "Bsus"] },
  { name: "verse1", chords: VERSE },
  { name: "chorus1", chords: CHORUS },
  { name: "interlude", chords: ["Em", "D", "C", "B"] },
  { name: "verse2", chords: VERSE },
  { name: "chorus2", chords: CHORUS },
  { name: "bridge", chords: ["A", "C", "G", "D", "A", "C", "Bsus", "B"] },
  { name: "final", chords: CHORUS },
  { name: "tag", chords: ["C", "G", "D", "Em"] },
  { name: "outro", chords: ["Em", "C", "G", "D", "Em", "Em"] },
];

/** each bar: its section, the bar within the section, its chord */
export const BARS = FORM.flatMap((s) => s.chords.map((chord, i) => ({ section: s.name, i, chord })));
export const TOTAL_BEATS = BARS.length * BEATS_PER_BAR;

/** the first bar of each section */
export const SECTION_START: Record<string, number> = {};
{
  let b = 0;
  for (const s of FORM) {
    SECTION_START[s.name] = b;
    b += s.chords.length;
  }
}

/** pitch classes, root first */
const CHORDS: Record<string, number[]> = {
  Em: [4, 7, 11],
  C: [0, 4, 7],
  G: [7, 11, 2],
  D: [2, 6, 9],
  Am: [9, 0, 4],
  Am7: [9, 0, 4, 7],
  A: [9, 1, 4],
  B: [11, 3, 6],
  Bsus: [11, 4, 6],
  Bm: [11, 2, 6],
};

/** the scale a harmony line moves in under each chord: E Aeolian, with C♯ under A and D♯ under B */
function scaleFor(chord: string): number[] {
  const s = [4, 6, 7, 9, 11, 0, 2];
  if (chord === "A") s[5] = 1;
  if (chord === "B" || chord === "Bsus") s[6] = 3;
  return s;
}

const pc = (m: number) => ((Math.round(m) % 12) + 12) % 12;

/** chord tones of `chord` within [lo, hi] */
function tonesIn(chord: string, lo: number, hi: number): number[] {
  const set = CHORDS[chord];
  const out: number[] = [];
  for (let m = lo; m <= hi; m++) if (set.includes(pc(m))) out.push(m);
  return out;
}

const NOTE: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
function midi(name: string): number {
  const m = /^([A-G])(#|b)?(-?\d)$/.exec(name);
  if (!m) throw new Error(`bad note ${name}`);
  return 12 * (Number(m[3]) + 1) + NOTE[m[1]] + (m[2] === "#" ? 1 : m[2] === "b" ? -1 : 0);
}

// ---------------------------------------------------------------- the lead

/** `syllable:Note:beats`; `~` holds the vowel, `_:beats` rests; a trailing `-` joins the next syllable into one word */
const LEAD: Record<string, string> = {
  verse1: `
    Wind:E4:1 on:G4:.5 the:F#4:.5 wa-:E4:1 ter:D4:1  a-:E4:.5 cross:G4:1 the:A4:.5 bay,:G4:1.5 _:.5
    grey:B4:1 gulls:A4:1 are:G4:.5 turn-:F#4:1 ing:E4:.5  for:D4:1 home,:F#4:2.5 _:.5
    light:E4:1 a:G4:.5 lan-:B4:1 tern:A4:.5 a-:G4:.5 bove:A4:.5  the:B4:.5 waves:C5:1.5 ~:B4:1.5 _:.5
    I:A4:1 will:G4:.5 not:E4:.5 wan-:G4:1 der:A4:1  a-:F#4:1 lone.:F#4:1.5 ~:E4:1 _:.5`,
  chorus: `
    Sil-:B4:.5 ver:C5:.5 tide,:E5:2 ~:D5:1  car-:D5:.5 ry:B4:.5 me:G4:1 o-:B4:1 ver,:A4:.5 _:.5
    sil-:A4:.5 ver:B4:.5 tide,:D5:2 ~:B4:1  car-:B4:.5 ry:A4:.5 me:G4:1 home,:E4:1.5 _:.5
    far:E5:1.5 a-:D5:.5 way:C5:1 the:B4:1  shore:D5:1.5 is:B4:.5 call-:B4:1 ing,:G4:.5 _:.5`,
  chorusEnd: `
    ev-:C5:.5 er:B4:.5 on,:A4:2.5 _:.5  ev-:B4:.5 er:A4:.5 on.:F#4:2 ~:D#4:.5 _:.5`,
  finalEnd: `
    ev-:C5:.5 er:B4:.5 on,:A4:2.5 _:.5  ev-:B4:.5 er:A4:.5 on,:B4:2.5 _:.5`,
  interlude: `
    Ah:B4:1 ~:D5:1 ~:E5:2  ~:D5:1 ~:A4:1 ~:D5:1.5 _:.5
    Ah:E5:1 ~:C5:1 ~:B4:2  ~:A4:1 ~:F#4:1.5 ~:D#4:1 _:.5`,
  verse2: `
    Stars:E4:1 in:G4:.5 the:F#4:.5 dark-:E4:1 ness:D4:1  are:E4:.5 shin-:G4:1 ing:A4:.5 through,:G4:1.5 _:.5
    moon:B4:1 on:A4:1 the:G4:.5 edge:F#4:1 of:E4:.5  the:D4:1 sea,:F#4:2.5 _:.5
    all:E4:1 of:G4:.5 the:A4:.5 riv-:B4:1 ers:A4:.5 will:G4:.5  run:B4:.5 to:C5:.5 you,:C5:1.5 ~:B4:1 _:.5
    all:A4:1 of:G4:.5 the:E4:.5 wa-:G4:1 ters:A4:1  to:F#4:1 me.:F#4:1.5 ~:E4:1 _:.5`,
  bridge: `
    Lu-:A4:1 men:C#5:1 ma-:E5:1.5 ris,:C#5:.5  lu-:C5:1 men:B4:1 stel-:G4:1 lae,:A4:.5 _:.5
    hold:B4:1.5 me,:D5:.5 the:D5:.5 dawn:E5:1.5  is:D5:1 near.:A4:2.5 _:.5
    Lu-:A4:1 men:C#5:1 ma-:E5:1.5 ris,:C#5:.5  lu-:C5:1 men:B4:1 stel-:G4:1 lae,:A4:.5 _:.5
    Ah:E5:1 ~:F#5:1 ~:E5:1 ~:D#5:1  ~:D#5:2 ~:B4:1.5 _:.5`,
  tag: `
    ev-:E5:.5 er:D5:.5 on,:C5:2.5 _:.5  ev-:D5:.5 er:B4:.5 on,:G4:2.5 _:.5
    car-:A4:.5 ry:B4:.5 me:D5:1.5 ~:B4:1.5  home.:G4:1 ~:F#4:1 ~:E4:2`,
};

interface Ev {
  /** beat from the top of the song */
  at: number;
  beats: number;
  /** 0: rest */
  midi: number;
  /** syllable text, `~` for a melisma; '' for rests */
  syl: string;
}

function parseLine(src: string, at: number): Ev[] {
  const out: Ev[] = [];
  for (const tok of src.trim().split(/\s+/)) {
    const parts = tok.split(":");
    if (parts[0] === "_") {
      const beats = Number(parts[1]);
      out.push({ at, beats, midi: 0, syl: "" });
      at += beats;
    } else {
      const [syl, note, b] = parts;
      const beats = Number(b);
      out.push({ at, beats, midi: midi(note), syl });
      at += beats;
    }
  }
  return out;
}

/** the lead for each section that has one, placed on the song's beat grid */
function leadEvents(): Ev[] {
  const plan: [string, string[]][] = [
    ["verse1", ["verse1"]],
    ["chorus1", ["chorus", "chorusEnd"]],
    ["interlude", ["interlude"]],
    ["verse2", ["verse2"]],
    ["chorus2", ["chorus", "chorusEnd"]],
    ["bridge", ["bridge"]],
    ["final", ["chorus", "finalEnd"]],
    ["tag", ["tag"]],
  ];
  const out: Ev[] = [];
  for (const [section, parts] of plan) {
    let at = SECTION_START[section] * BEATS_PER_BAR;
    const start = at;
    for (const p of parts) {
      const evs = parseLine(LEAD[p], at);
      out.push(...evs);
      at = evs.length ? evs[evs.length - 1].at + evs[evs.length - 1].beats : at;
    }
    const len = FORM.find((s) => s.name === section)!.chords.length * BEATS_PER_BAR;
    if (Math.abs(at - start - len) > 1e-9) throw new Error(`lead ${section}: ${at - start} beats for ${len}`);
  }
  return out;
}

const chordAt = (beat: number) => BARS[Math.min(BARS.length - 1, Math.floor(beat / BEATS_PER_BAR + 1e-9))].chord;

/** a diatonic third below each note, in the scale of the chord under it */
function thirdBelow(evs: Ev[]): Ev[] {
  return evs.map((e) => {
    if (!e.midi) return e;
    const s = scaleFor(chordAt(e.at));
    const k = s.indexOf(pc(e.midi));
    if (k < 0) throw new Error(`lead note ${e.midi} outside the scale at beat ${e.at}`);
    const target = s[(k + 5) % 7]; // two steps down
    let m = e.midi - 1;
    while (pc(m) !== target) m--;
    return { ...e, midi: m };
  });
}

// ---------------------------------------------------------------- generated parts

/** a part that sustains one pitch per bar (or half bar), as a list of [bar, pitch] */
type Line = { bar: number; beat: number; beats: number; midi: number }[];

/** SATB voicings, one per bar, voice-led: bass on the root, upper voices nearest their last note */
function voiceLead(): { B: number[]; T: number[]; A: number[]; S: number[] } {
  const R = { B: [43, 55], T: [52, 64], A: [57, 69], S: [64, 76] } as const;
  const out = { B: [] as number[], T: [] as number[], A: [] as number[], S: [] as number[] };
  let prev = { B: 52, T: 59, A: 64, S: 71 };
  for (const { chord } of BARS) {
    const set = CHORDS[chord];
    const roots = tonesIn(chord, R.B[0], R.B[1]).filter((m) => pc(m) === set[0]);
    const b = roots.reduce((x, y) => (Math.abs(y - prev.B) < Math.abs(x - prev.B) ? y : x));
    let best: [number, number, number] | null = null;
    let bestCost = Infinity;
    for (const t of tonesIn(chord, R.T[0], R.T[1]))
      for (const a of tonesIn(chord, R.A[0], R.A[1]))
        for (const s of tonesIn(chord, R.S[0], R.S[1])) {
          if (!(t > b && a > t && s > a) || a - t > 12 || s - a > 12) continue;
          const have = new Set([pc(b), pc(t), pc(a), pc(s)]);
          const missing = set.slice(0, 3).filter((p) => !have.has(p)).length;
          const cost = Math.abs(t - prev.T) + Math.abs(a - prev.A) + Math.abs(s - prev.S) + 8 * missing + (s - a < 2 ? 4 : 0);
          if (cost < bestCost) {
            bestCost = cost;
            best = [t, a, s];
          }
        }
    if (!best) throw new Error(`no voicing for ${chord}`);
    const [t, a, s] = best;
    out.B.push(b);
    out.T.push(t);
    out.A.push(a);
    out.S.push(s);
    prev = { B: b, T: t, A: a, S: s };
  }
  return out;
}

/** the bars (0-based, song-wide) of the named sections, minus any bars `skip` names as "section:i" */
function barsOf(sections: string[], skip: string[] = []): Set<number> {
  const out = new Set<number>();
  BARS.forEach((b, k) => {
    if (sections.includes(b.section) && !skip.includes(`${b.section}:${b.i}`)) out.add(k);
  });
  return out;
}

const VOWEL: Record<string, string> = {
  intro: "oo",
  verse1: "oo",
  chorus1: "ah",
  interlude: "ah",
  verse2: "oo",
  chorus2: "ah",
  bridge: "oh",
  final: "ah",
  tag: "ah",
  outro: "oo",
};

/**
 * A sustained part: one pitch per bar from `pitchOf`, sung over the bars in `active`. Notes are
 * tied into breath groups of `group` bars (a new vowel starts each group); the group boundaries
 * shift by `phase` bars, so layers with different phases breathe at different times and the pad
 * never gaps. The last half beat of each group is the breath.
 */
function sustained(active: Set<number>, pitchOf: (bar: number) => number | null, phase: number, group = 2): Ev[] {
  const out: Ev[] = [];
  for (let k = 0; k < BARS.length; k++) {
    const m = active.has(k) ? pitchOf(k) : null;
    const at = k * BEATS_PER_BAR;
    if (m == null) {
      out.push({ at, beats: BEATS_PER_BAR, midi: 0, syl: "" });
      continue;
    }
    const prevSounds = k > 0 && active.has(k - 1) && pitchOf(k - 1) != null;
    const nextSounds = k + 1 < BARS.length && active.has(k + 1) && pitchOf(k + 1) != null;
    const groupStart = (k + phase) % group === 0 || !prevSounds || BARS[k].section !== BARS[k - 1]?.section;
    const groupEnd = (k + 1 + phase) % group === 0 || !nextSounds || BARS[k].section !== BARS[k + 1]?.section;
    const syl = groupStart ? VOWEL[BARS[k].section] : "~";
    if (groupEnd) {
      out.push({ at, beats: BEATS_PER_BAR - 0.5, midi: m, syl });
      out.push({ at: at + BEATS_PER_BAR - 0.5, beats: 0.5, midi: 0, syl: "" });
    } else {
      out.push({ at, beats: BEATS_PER_BAR, midi: m, syl });
    }
  }
  return out;
}

/** eighth-note arpeggios ("da da da …"), with a breath at the end of every two bars */
function ostinato(active: Set<number>, rotate: number, syl: string): Ev[] {
  const out: Ev[] = [];
  for (let k = 0; k < BARS.length; k++) {
    const at = k * BEATS_PER_BAR;
    if (!active.has(k)) {
      out.push({ at, beats: BEATS_PER_BAR, midi: 0, syl: "" });
      continue;
    }
    const set = CHORDS[BARS[k].chord];
    let r = 57;
    while (pc(r) !== set[0]) r++;
    const third = r + (((set[1] - set[0] + 12) % 12)) + 12;
    const fold = (m: number) => (m > 79 ? m - 12 : m);
    const pat = [r, r + 7, r + 12, r + 7, third, r + 7, r + 12, r + 7].map(fold);
    const breath = k % 2 === 1 || !active.has(k + 1);
    for (let j = 0; j < 8; j++) {
      const m = pat[(j + rotate) % 8];
      if (breath && j === 7) out.push({ at: at + j * 0.5, beats: 0.5, midi: 0, syl: "" });
      else out.push({ at: at + j * 0.5, beats: 0.5, midi: m, syl });
    }
  }
  return out;
}

/** a line of chord tones in [lo, hi], each nearest the last; `step` beats per note */
function nearestLine(active: Set<number>, lo: number, hi: number, start: number, step: number, move: boolean): (bar: number, j: number) => number {
  const memo = new Map<string, number>();
  let prev = start;
  for (let k = 0; k < BARS.length; k++) {
    for (let j = 0; j < BEATS_PER_BAR / step; j++) {
      if (!active.has(k)) continue;
      const ts = tonesIn(BARS[k].chord, lo, hi);
      // prefer moving (when asked) to the nearest other tone; else hold the common tone
      const cands = move && ts.some((t) => t !== prev && Math.abs(t - prev) <= 5) ? ts.filter((t) => t !== prev) : ts;
      const m = cands.reduce((x, y) => (Math.abs(y - prev) < Math.abs(x - prev) ? y : x));
      memo.set(`${k}:${j}`, m);
      prev = m;
    }
  }
  return (bar, j) => memo.get(`${bar}:${j}`)!;
}

/** half-note counter-melody in breath groups of two bars */
function halfNotes(active: Set<number>, pitch: (bar: number, j: number) => number, shift: number): Ev[] {
  const out: Ev[] = [];
  for (let k = 0; k < BARS.length; k++) {
    const at = k * BEATS_PER_BAR;
    if (!active.has(k)) {
      out.push({ at, beats: BEATS_PER_BAR, midi: 0, syl: "" });
      continue;
    }
    const first = k === 0 || !active.has(k - 1) || k % 2 === 0;
    const last = k % 2 === 1 || !active.has(k + 1);
    out.push({ at, beats: 2, midi: pitch(k, 0) + shift, syl: first ? VOWEL[BARS[k].section] : "~" });
    if (last) {
      out.push({ at: at + 2, beats: 1.5, midi: pitch(k, 1) + shift, syl: "~" });
      out.push({ at: at + 3.5, beats: 0.5, midi: 0, syl: "" });
    } else out.push({ at: at + 2, beats: 2, midi: pitch(k, 1) + shift, syl: "~" });
  }
  return out;
}

// ---------------------------------------------------------------- layers

/** a small deterministic hash in [0, 1) */
function hash01(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return ((h >>> 0) % 100000) / 100000;
}

/** turn events into a CLI melody: rests merged, lyrics joined into words */
function toTrack(id: string, group: string, body: Body, evs: Ev[], o: { pan: number; vibrato: number; cents: number; delayMs: number; shift?: number }): Track {
  // pad out to the song's end so every layer has the same timeline
  const end = evs.length ? evs[evs.length - 1].at + evs[evs.length - 1].beats : 0;
  if (end > TOTAL_BEATS + 1e-9) throw new Error(`${id}: ${end} beats > ${TOTAL_BEATS}`);
  const notes: [number, number][] = [];
  const words: string[] = [];
  let word = "";
  let at = 0;
  const rest = (beats: number) => {
    if (notes.length && notes[notes.length - 1][0] === 0) notes[notes.length - 1][1] += beats;
    else notes.push([0, beats]);
  };
  for (const e of evs) {
    // events need not cover the whole timeline: a gap before one is a rest
    if (e.at < at - 1e-9) throw new Error(`${id}: overlapping events at beat ${e.at}`);
    if (e.at > at + 1e-9) rest(e.at - at);
    at = e.at + e.beats;
    if (!e.midi) {
      rest(e.beats);
      continue;
    }
    notes.push([Math.round((e.midi + (o.shift ?? 0) + o.cents / 100) * 1000) / 1000, e.beats]);
    if (e.syl === "~") {
      if (word) throw new Error(`${id}: melisma inside a word at beat ${e.at}`);
      words.push("~");
    } else if (e.syl.endsWith("-")) word += e.syl.slice(0, -1);
    else {
      words.push(word + e.syl);
      word = "";
    }
  }
  // the CLI starts at the first note; leading rests are kept as rests
  while (notes.length && notes[notes.length - 1][0] === 0) notes.pop();
  return { id, group, body, pan: o.pan, vibrato: o.vibrato, t0: T0 + o.delayMs / 1000, notes, lyrics: words.join(" ") };
}

/**
 * `n` layers of the same part: detune spread over ±`cents`, pans spread over ±`width` around
 * `center` (alternating sides), up to `maxDelay` ms of lag, vibrato around `vib`.
 */
function layers(group: string, n: number, bodyOf: (i: number) => Body, evsOf: (i: number) => Ev[], o: { cents: number; width: number; center?: number; maxDelay: number; vib: number; shift?: (i: number) => number }): Track[] {
  return Array.from({ length: n }, (_, i) => {
    const id = `${group}-${String(i + 1).padStart(2, "0")}`;
    const u = n === 1 ? 0 : (i / (n - 1)) * 2 - 1;
    const side = i % 2 === 0 ? 1 : -1;
    const spread = n === 1 ? 0 : (Math.ceil(i / 2) / Math.ceil((n - 1) / 2)) * side;
    return toTrack(id, group, bodyOf(i), evsOf(i), {
      pan: Math.max(-1, Math.min(1, (o.center ?? 0) + o.width * spread)),
      vibrato: o.vib * (0.75 + 0.5 * hash01(id + "v")),
      cents: o.cents * u + (hash01(id + "c") - 0.5) * 2,
      delayMs: o.maxDelay * hash01(id + "d"),
      shift: o.shift?.(i),
    });
  });
}

export function buildTracks(): Track[] {
  const lead = leadEvents();
  const all = (...xs: string[]) => barsOf(xs);
  const sung = ["verse1", "chorus1", "interlude", "verse2", "chorus2", "bridge", "final", "tag"];
  const choruses = ["chorus1", "chorus2", "bridge", "final", "tag"];
  const leadIn = (evs: Ev[], sections: string[]) => {
    const keep = barsOf(sections);
    return evs.map((e) => (keep.has(Math.floor(e.at / BEATS_PER_BAR)) ? e : { ...e, midi: 0, syl: "" }));
  };
  const v = voiceLead();
  const padBars = {
    S: barsOf(["intro", "chorus1", "interlude", "verse2", "chorus2", "bridge", "final", "tag", "outro"], ["intro:0", "intro:1", "intro:2", "intro:3"]),
    A: barsOf(["intro", "verse1", "chorus1", "interlude", "verse2", "chorus2", "bridge", "final", "tag", "outro"]),
    T: barsOf(["intro", "verse1", "chorus1", "interlude", "verse2", "chorus2", "bridge", "final", "tag", "outro"]),
    B: barsOf(["intro", "verse1", "chorus1", "verse2", "chorus2", "bridge", "final", "tag", "outro"], ["intro:0", "intro:1", "intro:2", "intro:3"]),
  };
  const subRoot = (k: number) => {
    const r = CHORDS[BARS[k].chord][0];
    let m = 40;
    while (pc(m) !== r) m++;
    return m;
  };
  const ostBars = barsOf(["intro", "verse1", "chorus1", "interlude", "verse2", "chorus2", "final", "tag"], ["intro:0", "intro:1", "intro:2", "intro:3"]);
  const descBars = barsOf(["intro", "chorus2", "bridge", "final", "tag", "outro"], ["intro:0", "intro:1", "intro:2", "intro:3", "outro:5"]);
  const descant = nearestLine(descBars, 72, 83, 76, 4, false);
  const counterBars = barsOf(["verse2", "chorus2", "final", "tag"]);
  const counter = nearestLine(counterBars, 62, 72, 67, 2, true);
  const swellBars = new Set<number>();
  for (const s of ["chorus1", "chorus2", "bridge"]) [0, 1].forEach((i) => swellBars.add(SECTION_START[s] + i));
  for (const i of [0, 1, 2, 3]) swellBars.add(SECTION_START.final + i);
  const droneBars = barsOf(["intro", "verse1", "interlude", "verse2", "outro"]);
  for (const k of [...droneBars]) if (BARS[k].chord === "B") droneBars.delete(k);

  const tracks: Track[] = [
    // the lead, double-tracked three times
    ...layers("lead", 4, () => "female", () => leadIn(lead, sung), { cents: 5, width: 0.12, maxDelay: 18, vib: 22 }),
    // a third below, in the choruses and the bridge
    ...layers("harmony", 4, () => "female", () => leadIn(thirdBelow(lead), choruses), { cents: 6, width: 0.4, maxDelay: 22, vib: 18 }),
    // the melody an octave down, for warmth under the choruses
    ...layers("lowlead", 4, () => "male", () => leadIn(lead, choruses), { cents: 6, width: 0.3, maxDelay: 22, vib: 14, shift: () => -12 }),
    // the choir pad, twelve voices to a part
    ...layers("soprano", 12, (i) => (i % 3 === 2 ? "child" : "female"), (i) => sustained(padBars.S, (k) => v.S[k], i % 2), { cents: 12, width: 0.9, center: -0.1, maxDelay: 35, vib: 10 }),
    ...layers("alto", 12, () => "female", (i) => sustained(padBars.A, (k) => v.A[k], (i + 1) % 2), { cents: 12, width: 0.9, center: 0.1, maxDelay: 35, vib: 10 }),
    ...layers("tenor", 12, () => "male", (i) => sustained(padBars.T, (k) => v.T[k], i % 2), { cents: 12, width: 0.9, center: -0.1, maxDelay: 35, vib: 9 }),
    ...layers("bass", 12, () => "male", (i) => sustained(padBars.B, (k) => v.B[k], (i + 1) % 2), { cents: 10, width: 0.7, center: 0.1, maxDelay: 35, vib: 7 }),
    // the root an octave under the bass
    ...layers("sub", 6, () => "male", (i) => sustained(padBars.B, subRoot, i % 2), { cents: 6, width: 0.3, maxDelay: 25, vib: 0 }),
    // the plucked arpeggio, two interlocking patterns
    ...layers("ostinato", 8, () => "female", (i) => ostinato(ostBars, i < 4 ? 0 : 4, i < 4 ? "da" : "na"), { cents: 6, width: 0.35, maxDelay: 10, vib: 0, center: 0 }).map((t, i) => ({ ...t, pan: (i < 4 ? -0.55 : 0.55) + (t.pan * 0.4) })),
    // a high children's descant
    ...layers("descant", 6, () => "child", (i) => sustained(descBars, (k) => descant(k, 0), i % 2), { cents: 8, width: 0.6, maxDelay: 30, vib: 15 }),
    // a moving inner line, women and men an octave apart
    ...layers("counter", 6, (i) => (i < 3 ? "female" : "male"), (i) => halfNotes(counterBars, counter, i < 3 ? 0 : -12), { cents: 8, width: 0.7, maxDelay: 25, vib: 12 }),
    // the big "ah" that opens each chorus
    ...layers("swell", 4, (i) => (i < 2 ? "female" : "male"), (i) => sustained(swellBars, (k) => (i < 2 ? v.S[k] : v.T[k]), 0, 4), { cents: 8, width: 0.8, maxDelay: 20, vib: 12 }),
    // the alto line an octave up, children, for the last choruses
    ...layers("shimmer", 4, () => "child", (i) => sustained(barsOf(["final", "tag", "outro"]), (k) => v.A[k] + 12, i % 2), { cents: 10, width: 1, maxDelay: 30, vib: 12 }),
    // the open-fifth drone on E
    ...layers("drone", 6, (i) => (i < 3 ? "male" : "female"), (i) => sustained(droneBars, () => [52, 59, 52, 64, 71, 64][i], i % 2, 4), { cents: 5, width: 0.6, maxDelay: 30, vib: 0 }),
  ];
  if (tracks.length !== 100) throw new Error(`${tracks.length} layers, want 100`);
  return tracks;
}

if (import.meta.main) {
  const ts = buildTracks();
  const by: Record<string, number> = {};
  for (const t of ts) by[t.group] = (by[t.group] ?? 0) + 1;
  console.log(`${ts.length} layers, ${BARS.length} bars at ${BPM} BPM (${((TOTAL_BEATS * 60) / BPM).toFixed(1)} s)`);
  console.log(by);
  for (const g of Object.keys(by)) {
    const t = ts.find((x) => x.group === g)!;
    console.log(`${t.id}: ${t.lyrics.slice(0, 110)}`);
  }
}
