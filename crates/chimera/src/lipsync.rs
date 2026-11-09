//! A voice rendered with its mouth, for animating a face to it (Weft's shows).
//!
//! Each take renders in 10 ms frames ([`MOUTH_RATE`]) and reads the articulators at every frame's
//! middle. The voice runs sample by sample, so stopping there doesn't change the sound. A take
//! carries:
//!
//! - `track`: the mouth's shape per frame, an index into [`MOUTH_SHAPES`] (the five shapes of
//!   cutout animation, Weft's visemes). Lips touching and the lip on the teeth are contacts;
//!   otherwise the lips and jaw are matched to the body's own calibrated vowels, because the
//!   bodies' tables are fitted to formants, not looks (the child's /i/ spreads its lips to 0.66
//!   where the man's spread to 1).
//! - `channels`: how open, round and spread the mouth is per frame, 0..1 scaled between the
//!   body's own vowel extremes, as base-36 digits (`0`..`z`), so a rig can size its mouth too.
//!
//! The silent tail is cut: `TAIL_FRAMES` after the last frame within 60 dB of the peak, so the
//! take is a whole number of frames and a dialogue line doesn't carry 0.2 s of nothing.
//!
//! Three takes: [`speak`] (English text, the `render text` plan), [`sing`] (a melody with lyrics,
//! the `render notes` plan), [`call`] (a creature's call, its beak or jaw as the mouth). No I/O:
//! the caller brings the pronouncing dictionary and writes the samples.

use crate::anatomy::human::{ArticKey, BodyMix, HumanArtic, HumanBody, BODY_CHILD, BODY_FEMALE, BODY_MALE, NEUTRAL};
use crate::control::articulators::artic_spec;
use crate::creatures::voice::CreatureVoice;
use crate::creatures::{CREATURES, creature_by_id};
use crate::math::{clamp, js_max, js_round, midi_to_hz, sqrt};
use crate::phonetics::english::{EnglishG2P, Phrase};
use crate::phonetics::planner::{PhraseInput, PlanOptions, expand, plan_phrases, vowel_artic};
use crate::phonetics::sing::{SongOptions, SungNote, plan_song};
use crate::phonetics::syllables::lyrics_to_syllables;
use crate::phonetics::{Intonation, Plan};
use crate::voice::human_voice::{HumanVoice, SourcePatch};
use serde_json::{Value, json};

/// Mouth frames per second.
pub const MOUTH_RATE: usize = 100;

/// The five mouth shapes: lips together or at rest, open (jaw down), wide (spread lips), round
/// (protruded lips), lower lip on the upper teeth. A track holds each frame's index.
pub const MOUTH_SHAPES: [&str; 5] = ["rest", "open", "wide", "round", "teeth"];
const REST: u8 = 0;
const OPEN: u8 = 1;
const WIDE: u8 = 2;
const ROUND: u8 = 3;
const TEETH: u8 = 4;

/// Lower lip tucked under the incisors at least this far (0 free, 1 tucked; /f v/ target 1).
const TEETH_FROM: f64 = 0.5;
/// Lips at most this far apart are touching (the bilabial target is −0.25; the closest vowel,
/// the child's /o/, keeps 0.13).
const SHUT_BELOW: f64 = 0.05;

/// The vowels whose calibrated lips and jaw stand for each open-mouth shape. /ɔ/ and /ə/ are left
/// out: they sit between shapes (the man's /ɔ/ is barely rounder than his /ʌ/).
const PROTOTYPES: [(u8, &[&str]); 3] = [(WIDE, &["i", "ɪ", "e", "ɛ"]), (OPEN, &["æ", "a", "ɑ", "ʌ"]), (ROUND, &["o", "u", "ʊ"])];
/// What the shape of an open mouth is matched on.
const LIP_KEYS: [ArticKey; 4] = [ArticKey::Jaw, ArticKey::LipAp, ArticKey::LipProt, ArticKey::LipWidth];

/// Frames quieter than this re the take's peak (RMS, as a ratio: −60 dB) are silence at the end.
const TAIL_FLOOR: f64 = 1e-3;
/// Frames kept after the last one that isn't silence (20 ms).
const TAIL_FRAMES: usize = 2;

fn lip_point(get: impl Fn(ArticKey) -> f64) -> [f64; 4] {
    LIP_KEYS.map(|k| {
        let s = artic_spec(k);
        (get(k) - s.min) / (s.max - s.min)
    })
}

/// A body's mouth: its prototype vowels as lip points, and the extremes its vowels reach, which
/// scale the channels.
pub struct MouthModel {
    prototypes: Vec<(u8, [f64; 4])>,
    /// (lo, hi) of lipAp, lipProt, lipWidth over the prototype vowels
    ranges: [(f64, f64); 3],
}

impl MouthModel {
    pub fn new(body: BodyMix) -> MouthModel {
        let mut prototypes = Vec::new();
        let mut ranges = [(f64::INFINITY, f64::NEG_INFINITY); 3];
        for (shape, vowels) in PROTOTYPES {
            for v in vowels {
                if let Some(p) = vowel_artic(v, body) {
                    let get = |k: ArticKey| p.get(k).unwrap_or(NEUTRAL.get(k));
                    prototypes.push((shape, lip_point(get)));
                    for (r, k) in ranges.iter_mut().zip([ArticKey::LipAp, ArticKey::LipProt, ArticKey::LipWidth]) {
                        r.0 = r.0.min(get(k));
                        r.1 = r.1.max(get(k));
                    }
                }
            }
        }
        // a closure is the bottom of "open", whatever the closest vowel keeps
        ranges[0].0 = SHUT_BELOW;
        MouthModel { prototypes, ranges }
    }

    /// The shape the articulators `x` show. Outside speech the mouth rests, whatever the lips
    /// drift to on the way back to neutral. In speech, contacts first (lip on teeth, lips
    /// together), then the shape of the nearest prototype vowel.
    pub fn shape(&self, x: &HumanArtic, speaking: bool) -> u8 {
        if !speaking {
            return REST;
        }
        if x.labiodental >= TEETH_FROM {
            return TEETH;
        }
        if x.lip_ap <= SHUT_BELOW {
            return REST;
        }
        let here = lip_point(|k| x.get(k));
        let mut best = (OPEN, f64::INFINITY);
        for (shape, p) in &self.prototypes {
            let d: f64 = here.iter().zip(p).map(|(a, b)| (a - b) * (a - b)).sum();
            if d < best.1 {
                best = (*shape, d);
            }
        }
        best.0
    }

    /// How open, round and spread the mouth is, each 0..1 between the body's own vowel extremes.
    /// Outside speech, and with the lip on the teeth or the lips together, it is closed (0, and
    /// round and spread 0 too, so a rig's mouth rests).
    pub fn channels(&self, x: &HumanArtic, speaking: bool) -> [f64; 3] {
        if !speaking || x.labiodental >= TEETH_FROM || x.lip_ap <= SHUT_BELOW {
            return [0.0; 3];
        }
        let scaled = |v: f64, (lo, hi): (f64, f64)| if hi > lo { clamp((v - lo) / (hi - lo), 0.0, 1.0) } else { 0.0 };
        [scaled(x.lip_ap, self.ranges[0]), scaled(x.lip_prot, self.ranges[1]), scaled(x.lip_width, self.ranges[2])]
    }
}

/// One base-36 digit for an amount in 0..1 (`0` closed .. `z` fully).
fn digit36(v: f64) -> char {
    let d = js_round(clamp(v, 0.0, 1.0) * 35.0) as u32;
    char::from_digit(d, 36).unwrap_or('0')
}

/// A rendered take: samples (a whole number of frames) and the mouth per frame.
#[derive(Clone, Debug, Default)]
pub struct Take {
    pub fs: f64,
    pub pcm: Vec<f32>,
    /// one `MOUTH_SHAPES` index per frame, as digits
    pub track: String,
    /// per frame, base-36: open, round, spread (a creature has only open)
    pub open: String,
    pub round: Option<String>,
    pub spread: Option<String>,
}

impl Take {
    pub fn duration(&self) -> f64 {
        self.pcm.len() as f64 / self.fs
    }

    /// The take's `mouth` object.
    pub fn mouth_json(&self) -> Value {
        let mut channels = json!({ "open": self.open });
        if let Some(r) = &self.round {
            channels["round"] = json!(r);
        }
        if let Some(s) = &self.spread {
            channels["spread"] = json!(s);
        }
        json!({ "rate": MOUTH_RATE, "shapes": MOUTH_SHAPES, "track": self.track, "channels": channels })
    }

    /// Cut the silent tail (see the module docs).
    fn trim(&mut self) {
        let hop = hop(self.fs);
        let peak = self.pcm.iter().fold(0f64, |m, &x| m.max((x as f64).abs()));
        let floor = peak * TAIL_FLOOR;
        let frames = self.pcm.len() / hop;
        let rms = |f: usize| sqrt(self.pcm[f * hop..(f + 1) * hop].iter().map(|&x| (x as f64) * (x as f64)).sum::<f64>() / hop as f64);
        let last = (0..frames).rev().find(|&f| rms(f) > floor).map_or(0, |f| f + 1);
        let keep = (last + TAIL_FRAMES).min(frames);
        self.pcm.truncate(keep * hop);
        self.track.truncate(keep);
        self.open.truncate(keep);
        if let Some(r) = self.round.as_mut() {
            r.truncate(keep);
        }
        if let Some(s) = self.spread.as_mut() {
            s.truncate(keep);
        }
    }
}

fn hop(fs: f64) -> usize {
    (fs as usize) / MOUTH_RATE
}

fn check_rate(fs: f64) -> Result<(), String> {
    if fs <= 0.0 || fs.fract() != 0.0 || (fs as usize) % MOUTH_RATE != 0 {
        return Err(format!("the sample rate must be a whole multiple of {MOUTH_RATE} Hz, got {fs}"));
    }
    Ok(())
}

fn render_blocks(v: &mut HumanVoice, out: &mut [f32]) {
    for block in out.chunks_mut(128) {
        v.render(block);
    }
}

/// Render a human voice (already scheduled) for `seconds`, reading the mouth at each frame's
/// middle; `speaking(t)` says whether the mouth is in speech at plan time `t`.
fn render_human(voice: &mut HumanVoice, fs: f64, seconds: f64, model: &MouthModel, speaking: impl Fn(f64) -> bool) -> Take {
    let hop = hop(fs);
    let frames = (js_round(fs * seconds) as usize).div_ceil(hop);
    let mut take = Take { fs, pcm: vec![0f32; frames * hop], ..Default::default() };
    let (mut round, mut spread) = (String::with_capacity(frames), String::with_capacity(frames));
    let half = hop / 2;
    for f in 0..frames {
        let frame = &mut take.pcm[f * hop..(f + 1) * hop];
        render_blocks(voice, &mut frame[..half]);
        let on = speaking((f * hop + half) as f64 / fs);
        let x = &voice.artic.x;
        take.track.push(char::from(b'0' + model.shape(x, on)));
        let [o, r, s] = model.channels(x, on);
        take.open.push(digit36(o));
        round.push(digit36(r));
        spread.push(digit36(s));
        render_blocks(voice, &mut frame[half..]);
    }
    take.round = Some(round);
    take.spread = Some(spread);
    take.trim();
    take
}

/// Each phrase's `[t0, t1]`: planned segments follow each other without a gap inside a phrase,
/// and a pause separates phrases.
fn phrase_spans(plan: &Plan) -> Vec<[f64; 2]> {
    let mut spans: Vec<[f64; 2]> = Vec::new();
    for s in &plan.segments {
        match spans.last_mut() {
            Some(span) if s.t0 <= span[1] + 1e-9 => span[1] = s.t1,
            _ => spans.push([s.t0, s.t1]),
        }
    }
    spans
}

/// Seconds to microseconds, so JSON prints short numbers (spans keep their order).
fn us(t: f64) -> f64 {
    js_round(t * 1e6) / 1e6
}

/// A body preset by name: the anatomy, the app's body mix, and its speaking pitch.
pub fn body_preset(name: &str) -> Result<(HumanBody, BodyMix, f64), String> {
    match name {
        "male" => Ok((BODY_MALE, BodyMix::new(0.0, 0.0), 112.0)),
        "female" => Ok((BODY_FEMALE, BodyMix::new(1.0, 0.0), 205.0)),
        "child" => Ok((BODY_CHILD, BodyMix::new(0.0, 1.0), 250.0)),
        _ => Err(format!("unknown body {name:?}; have male, female, child")),
    }
}

// ------------------------------------------------------------------------------------- speech

/// A spoken line.
pub struct Spoken {
    pub take: Take,
    pub ipa: String,
    /// clip-relative `[start, end)` per whitespace word of the text, or `None`
    pub words: Option<Vec<[f64; 2]>>,
    pub body: String,
}

impl Spoken {
    pub fn to_json(&self) -> Value {
        json!({
            "sampleRate": self.take.fs as u32,
            "samples": self.take.pcm.len(),
            "durationSec": self.take.duration(),
            "body": self.body,
            "ipa": self.ipa,
            "words": self.words,
            "mouth": self.take.mouth_json(),
            "engine": engine(),
        })
    }
}

/// The engine's name and version, as takes report it.
pub fn engine() -> String {
    format!("chimera {}", env!("CARGO_PKG_VERSION"))
}

/// Each said word's `[t0, t1]`, from the phrases' segments and the planned segments they expand
/// to (a diphthong plans two). `None` if the plan doesn't line up with the phrases.
fn word_spans(phrases: &[Phrase], plan: &Plan) -> Option<Vec<[f64; 2]>> {
    let mut spans = Vec::new();
    let mut at = 0usize;
    let mut start: Option<f64> = None;
    for p in phrases {
        for s in &p.segments {
            let n = expand(&s.ipa).map_or(1, <[&str]>::len);
            let first = plan.segments.get(at)?;
            let last = plan.segments.get(at + n - 1)?;
            start.get_or_insert(first.t0);
            at += n;
            if s.word_end == Some(true) {
                spans.push([start.take()?, last.t1]);
            }
        }
    }
    (at == plan.segments.len()).then_some(spans)
}

/// Spans of units (said words, sung notes) regrouped into the text's whitespace words, given how
/// many units each whitespace word makes. `None` when a whitespace word makes none, or the
/// counts disagree.
fn regroup(text: &str, units: &[[f64; 2]], count: impl Fn(&str) -> usize) -> Option<Vec<[f64; 2]>> {
    let mut out = Vec::new();
    let mut at = 0usize;
    for token in text.split_whitespace() {
        let n = count(token);
        if n == 0 {
            return None;
        }
        let first = units.get(at)?;
        let last = units.get(at + n - 1)?;
        out.push([us(first[0]), us(last[1])]);
        at += n;
    }
    (at == units.len()).then_some(out)
}

/// Plan and render English `text` in a body's voice (`male`, `female`, `child`).
pub fn speak(g2p: &EnglishG2P, text: &str, body_name: &str, fs: f64) -> Result<Spoken, String> {
    check_rate(fs)?;
    let (b, mix, f0) = body_preset(body_name)?;
    let phrases = g2p.to_phrases(text);
    if phrases.is_empty() {
        return Err(format!("{text:?} has no words to say"));
    }
    let ipa = phrases
        .iter()
        .map(|p| p.segments.iter().map(|s| format!("{}{}", if s.stress == Some(1) { "ˈ" } else { "" }, s.ipa)).collect::<String>() + if p.intonation == Intonation::Question { "?" } else { "" })
        .collect::<Vec<_>>()
        .join(" | ");
    let inputs: Vec<PhraseInput> = phrases.iter().map(|p| PhraseInput { segments: p.segments.clone(), intonation: Some(p.intonation), pause: Some(p.pause) }).collect();
    let plan = plan_phrases(&inputs, &PlanOptions { body: body_name.into(), t0: 0.05, f0: Some(f0), ..Default::default() });
    let mut voice = HumanVoice::new(fs, b, 2);
    voice.set_source(&SourcePatch::f0(f0));
    voice.schedule(&plan.gestures);
    let spans = phrase_spans(&plan);
    let take = render_human(&mut voice, fs, plan.end + 0.3, &MouthModel::new(mix), |t| spans.iter().any(|s| t >= s[0] && t < s[1]));
    let words = word_spans(&phrases, &plan).and_then(|said| regroup(text, &said, |token| g2p.to_phrases(token).iter().map(|p| p.words.len()).sum()));
    Ok(Spoken { take, ipa, words, body: body_name.to_string() })
}

// --------------------------------------------------------------------------------------- song

/// A melody: `{ bpm, lyrics, notes: [[midi, beats], …], vibrato?, t0? }`, one lyric syllable
/// per sounding note; a note with midi <= 0 is a rest, which splits the phrases.
#[derive(Clone, Debug, serde::Deserialize)]
pub struct Melody {
    pub bpm: f64,
    pub lyrics: String,
    pub notes: Vec<[f64; 2]>,
    /// vibrato depth in cents (default 35)
    #[serde(default)]
    pub vibrato: Option<f64>,
    /// clip time of the first note's beat (default 0.3 s: room for its onset consonants)
    #[serde(default)]
    pub t0: Option<f64>,
}

/// A sung take.
pub struct Sung {
    pub take: Take,
    pub body: String,
    /// clip-relative `[start, end)` per whitespace word of the lyrics, or `None`
    pub words: Option<Vec<[f64; 2]>>,
    /// clip-relative `[start, end)` of each sounding note, on the beat
    pub notes: Vec<[f64; 2]>,
    /// clip time of the first sounding note's beat: place the clip `lead` before that beat
    pub lead: f64,
    pub bpm: f64,
}

impl Sung {
    pub fn to_json(&self) -> Value {
        json!({
            "sampleRate": self.take.fs as u32,
            "samples": self.take.pcm.len(),
            "durationSec": self.take.duration(),
            "body": self.body,
            "bpm": self.bpm,
            "lead": us(self.lead),
            "notes": self.notes.iter().map(|n| [us(n[0]), us(n[1])]).collect::<Vec<_>>(),
            "words": self.words,
            "mouth": self.take.mouth_json(),
            "engine": engine(),
        })
    }
}

/// Plan and render a melody in a body's voice, as `render notes` does (phrases split at rests,
/// planned on one voice), and read its mouth.
pub fn sing(g2p: &EnglishG2P, melody: &Melody, body_name: &str, fs: f64) -> Result<Sung, String> {
    check_rate(fs)?;
    let (b, mix, _) = body_preset(body_name)?;
    if !(melody.bpm > 0.0 && melody.bpm <= 400.0) {
        return Err(format!("bpm must be in (0, 400], got {}", melody.bpm));
    }
    if melody.notes.iter().any(|n| !n[0].is_finite() || !(n[1] > 0.0)) {
        return Err("every note needs a finite midi and beats > 0".to_string());
    }
    let syl = lyrics_to_syllables(&melody.lyrics, g2p);
    let sounding = melody.notes.iter().filter(|n| n[0] > 0.0).count();
    if sounding == 0 {
        return Err("the melody has no sounding notes".to_string());
    }
    if syl.len() != sounding {
        return Err(format!("{} syllables for {sounding} notes: {}", syl.len(), syl.iter().map(|s| s.text.as_str()).collect::<Vec<_>>().join(" ")));
    }
    let t0 = melody.t0.unwrap_or(0.3);
    let vibrato = melody.vibrato.unwrap_or(35.0);
    let beat = 60.0 / melody.bpm;
    let mut v = HumanVoice::new(fs, b, 2);
    let first = melody.notes.iter().find(|n| n[0] > 0.0).ok_or("no notes")?;
    v.set_source(&SourcePatch { f0: Some(midi_to_hz(first[0])), voiced: Some(true), pressure: Some(9.0), tension: Some(0.55), ..Default::default() });
    let (mut t, mut k, mut end) = (t0, 0usize, 0.0f64);
    let mut phrase: Vec<SungNote> = Vec::new();
    let mut start = t;
    let mut spans: Vec<[f64; 2]> = Vec::new();
    let mut notes: Vec<[f64; 2]> = Vec::new();
    let mut lead: Option<f64> = None;
    let flush = |phrase: &mut Vec<SungNote>, start: f64, v: &mut HumanVoice, end: &mut f64, spans: &mut Vec<[f64; 2]>| {
        if phrase.is_empty() {
            return;
        }
        let plan = plan_song(phrase, &SongOptions { body: body_name.into(), bpm: melody.bpm, t0: start, vibrato });
        v.schedule(&plan.gestures);
        spans.extend(phrase_spans(&plan));
        *end = js_max(*end, plan.end);
        phrase.clear();
    };
    for n in &melody.notes {
        if n[0] > 0.0 {
            if phrase.is_empty() {
                start = t;
            }
            lead.get_or_insert(t);
            notes.push([t, t + n[1] * beat]);
            phrase.push(SungNote { midi: n[0], beats: n[1], syl: syl[k].clone() });
            k += 1;
        } else {
            flush(&mut phrase, start, &mut v, &mut end, &mut spans);
        }
        t += n[1] * beat;
    }
    flush(&mut phrase, start, &mut v, &mut end, &mut spans);
    let take = render_human(&mut v, fs, end + 0.4, &MouthModel::new(mix), |t| spans.iter().any(|s| t >= s[0] && t < s[1]));
    let words = regroup(&melody.lyrics, &notes, |token| lyrics_to_syllables(token, g2p).len());
    let duration = take.duration();
    // a note held past the cut tail ends at the clip's end
    let notes = notes.iter().map(|n| [n[0].min(duration), n[1].min(duration)]).collect();
    Ok(Sung { take, body: body_name.to_string(), words, notes, lead: lead.unwrap_or(t0), bpm: melody.bpm })
}

// ---------------------------------------------------------------------------------- creatures

/// Each creature's mouth: the param that opens it (beak gape, jaw). The elephant calls through
/// its trunk, so its mouth simply opens while it sounds.
fn aperture_param(creature: &str) -> Option<&'static str> {
    match creature {
        "songbird" => Some("gape"),
        "seal" | "alligator" => Some("mouth"),
        _ => None,
    }
}

/// Audible frames: RMS within 40 dB of the take's peak.
const CALL_AUDIBLE: f64 = 1e-2;
/// The least openness an audible call shows. An alligator bellows with its mouth shut (its
/// `mouth` param stays near 0), which is right for the animal and reads as silence on a face.
const CALL_OPEN_FLOOR: f64 = 0.2;

/// A creature's call.
pub struct Called {
    pub take: Take,
    pub creature: String,
    pub call: String,
}

impl Called {
    pub fn to_json(&self) -> Value {
        json!({
            "sampleRate": self.take.fs as u32,
            "samples": self.take.pcm.len(),
            "durationSec": self.take.duration(),
            "creature": self.creature,
            "call": self.call,
            "mouth": self.take.mouth_json(),
            "engine": engine(),
        })
    }
}

/// The creatures and their calls, as `creature: [call, …]`.
pub fn creature_calls() -> Vec<(&'static str, Vec<&'static str>)> {
    CREATURES.iter().map(|c| (c.id, c.calls.iter().map(|k| k.id).collect())).collect()
}

/// Render one of a creature's calls (the first when `call_id` is `None`). Its mouth is `rest` or
/// `open`: open while the call is audible. Its openness is the aperture param (beak gape, jaw)
/// while audible, at least `CALL_OPEN_FLOOR`, and closed otherwise.
pub fn call(creature: &str, call_id: Option<&str>, fs: f64) -> Result<Called, String> {
    check_rate(fs)?;
    let def = creature_by_id(creature).ok_or_else(|| format!("unknown creature {creature:?}; have {}", CREATURES.iter().map(|c| c.id).collect::<Vec<_>>().join(", ")))?;
    let call = match call_id {
        Some(id) => def.calls.iter().find(|c| c.id == id).ok_or_else(|| format!("{creature} has no call {id:?}; it has {}", def.calls.iter().map(|c| c.id).collect::<Vec<_>>().join(", ")))?,
        None => def.calls.first().ok_or_else(|| format!("{creature} has no calls"))?,
    };
    let mut v = CreatureVoice::new(def, fs, &[]);
    v.play_call_id(call.id, None, 1.0);
    let seconds = call.keys[call.keys.len() - 1].t + 0.5;
    let hop = hop(fs);
    let frames = (js_round(fs * seconds) as usize).div_ceil(hop);
    let mut pcm = vec![0f32; frames * hop];
    let aperture = aperture_param(creature).and_then(|key| def.param_index(key).map(|i| (i, &def.params[i])));
    let mut opening = Vec::with_capacity(frames);
    let half = hop / 2;
    for f in 0..frames {
        let frame = &mut pcm[f * hop..(f + 1) * hop];
        for block in frame[..half].chunks_mut(128) {
            v.render(block);
        }
        opening.push(match aperture {
            Some((i, p)) if p.max > p.min => clamp((v.values()[i] - p.min) / (p.max - p.min), 0.0, 1.0),
            _ => 1.0,
        });
        for block in frame[half..].chunks_mut(128) {
            v.render(block);
        }
    }
    let peak = pcm.iter().fold(0f64, |m, &x| m.max((x as f64).abs()));
    let mut take = Take { fs, pcm, ..Default::default() };
    for (f, &o) in opening.iter().enumerate() {
        let fr = &take.pcm[f * hop..(f + 1) * hop];
        let audible = sqrt(fr.iter().map(|&x| (x as f64) * (x as f64)).sum::<f64>() / hop as f64) > peak * CALL_AUDIBLE;
        let open = if audible { js_max(o, CALL_OPEN_FLOOR) } else { 0.0 };
        take.track.push(char::from(b'0' + if audible { OPEN } else { REST }));
        take.open.push(digit36(open));
    }
    take.trim();
    Ok(Called { take, creature: creature.to_string(), call: call.id.to_string() })
}

/// 16-bit little-endian samples as a WAV writes them: non-finite as 0, clamped to [−1, 1],
/// `round(v · 32767)`.
pub fn pcm16_le(pcm: &[f32]) -> Vec<u8> {
    let mut b = Vec::with_capacity(pcm.len() * 2);
    for &s in pcm {
        let mut v = s as f64;
        if !v.is_finite() {
            v = 0.0;
        }
        b.extend_from_slice(&(js_round(v.clamp(-1.0, 1.0) * 32767.0) as i16).to_le_bytes());
    }
    b
}

/// The take of a voice that never speaks: for tests of the framing alone.
#[cfg(test)]
fn silent_neutral(fs: f64) -> Take {
    let (b, mix, _) = body_preset("male").unwrap();
    let mut v = HumanVoice::new(fs, b, 2);
    render_human(&mut v, fs, 0.5, &MouthModel::new(mix), |_| false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_silent_take_trims_to_its_tail_and_rests() {
        let t = silent_neutral(48000.0);
        assert_eq!(t.pcm.len() % 480, 0);
        assert_eq!(t.track.len(), t.pcm.len() / 480);
        assert!(t.track.bytes().all(|c| c == b'0'));
    }

    #[test]
    fn the_rate_must_divide_into_mouth_frames() {
        assert!(check_rate(44100.0).is_ok());
        assert!(check_rate(44150.0).is_err());
        assert!(check_rate(48000.5).is_err());
    }

    #[test]
    fn channels_close_on_contacts_and_open_with_the_lips() {
        let m = MouthModel::new(BodyMix::new(0.0, 0.0));
        let mut x = NEUTRAL;
        assert_eq!(m.channels(&x, false), [0.0; 3]);
        x.lip_ap = 0.0;
        assert_eq!(m.channels(&x, true), [0.0; 3]);
        x.lip_ap = 2.0;
        assert_eq!(m.channels(&x, true)[0], 1.0);
        assert_eq!(digit36(1.0), 'z');
        assert_eq!(digit36(0.0), '0');
        assert_eq!(digit36(0.5), 'i');
    }

    #[test]
    fn every_creature_has_calls_and_a_known_mouth() {
        for (id, calls) in creature_calls() {
            assert!(!calls.is_empty(), "{id}");
            if let Some(key) = aperture_param(id) {
                assert!(creature_by_id(id).unwrap().param_index(key).is_some(), "{id} has no {key}");
            }
        }
    }
}
