//! `chimera speak <out.wav> --text "…" [--body male|female|child]`: one English line for a tool
//! that animates a face to it (Weft's `weft voice synth --provider chimera`). It writes the line
//! as a 16-bit mono 48 kHz WAV, as `render text` does, and prints one JSON object:
//!
//! - `words`: clip-relative `[start, end)` seconds per whitespace word of the text, or `null`
//!   when a word says nothing (a lone "--") or the words can't be matched up;
//! - `mouth`: the mouth's shape every 1/100 s, read from the simulated lips and jaw (one of
//!   `MOUTH_SHAPES` per character, by index), so the face moves the way the voice was made.
//!   Lips touching and the lip on the teeth are contacts; otherwise the lips and jaw are
//!   matched to the body's own calibrated vowels (`mouth_prototypes`), because the bodies'
//!   tables differ: the child's /i/ spreads its lips to 0.66 where the man's spread to 1.
//!
//! The sound is `render text`'s: the same plan, source and voice. Only the tail differs: it is
//! cut `TAIL_FRAMES` after the last frame within 60 dB of the clip's peak (`render text`
//! keeps 0.3 s, of which ~0.2 s is silence a dialogue line has no room for), so the clip is a
//! whole number of mouth frames.

use crate::render::{g2p, render_blocks};
use crate::{FS, body, body_mix, wav};
use chimera::anatomy::human::{ArticKey, BodyMix, HumanArtic, NEUTRAL};
use chimera::control::articulators::artic_spec;
use chimera::math::js_round;
use chimera::phonetics::english::{EnglishG2P, Phrase};
use chimera::phonetics::planner::{PhraseInput, PlanOptions, expand, plan_phrases, vowel_artic};
use chimera::phonetics::{Intonation, Plan};
use chimera::voice::human_voice::{HumanVoice, SourcePatch};
use serde_json::json;

/// Mouth frames per second.
pub const MOUTH_RATE: usize = 100;
const HOP: usize = FS as usize / MOUTH_RATE;

/// The five mouth shapes of cutout animation (a reduced Preston-Blair set, Weft's visemes): lips
/// together or at rest, open (jaw down), wide (spread lips), round (protruded lips), lower lip on
/// the upper teeth. `mouth.track` holds each frame's index into this list.
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

/// One shape's lips and jaw, each in its articulator's range (0..1), so they weigh alike.
pub type Prototype = (u8, [f64; 4]);

fn lip_point(get: impl Fn(ArticKey) -> f64) -> [f64; 4] {
    LIP_KEYS.map(|k| {
        let s = artic_spec(k);
        (get(k) - s.min) / (s.max - s.min)
    })
}

/// The body's calibrated vowels in `PROTOTYPES`, as lip points.
pub fn mouth_prototypes(body: BodyMix) -> Vec<Prototype> {
    let mut out = Vec::new();
    for (shape, vowels) in PROTOTYPES {
        for v in vowels {
            if let Some(p) = vowel_artic(v, body) {
                out.push((shape, lip_point(|k| p.get(k).unwrap_or(NEUTRAL.get(k)))));
            }
        }
    }
    out
}

/// The mouth shape the articulators `x` show. Outside speech the mouth rests, whatever the lips
/// drift to on the way back to neutral. In speech, contacts first (lip on teeth, lips together),
/// then the shape of the nearest prototype vowel.
pub fn mouth_shape(x: &HumanArtic, speaking: bool, prototypes: &[Prototype]) -> u8 {
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
    for (shape, p) in prototypes {
        let d: f64 = here.iter().zip(p).map(|(a, b)| (a - b) * (a - b)).sum();
        if d < best.1 {
            best = (*shape, d);
        }
    }
    best.0
}

/// Frames quieter than this re the clip's peak (RMS, as a ratio: −60 dB) are silence at the end.
const TAIL_FLOOR: f64 = 1e-3;
/// Frames kept after the last one that isn't silence (20 ms).
const TAIL_FRAMES: usize = 2;

/// How many whole frames of `pcm` to keep: up to the last frame louder than `TAIL_FLOOR` re the
/// peak, plus `TAIL_FRAMES` (never more than there are).
fn frames_to_keep(pcm: &[f32]) -> usize {
    let peak = pcm.iter().fold(0f64, |m, &x| m.max((x as f64).abs()));
    let floor = peak * TAIL_FLOOR;
    let frames = pcm.len() / HOP;
    let last = (0..frames)
        .rev()
        .find(|&f| {
            let fr = &pcm[f * HOP..(f + 1) * HOP];
            (fr.iter().map(|&x| (x as f64) * (x as f64)).sum::<f64>() / HOP as f64).sqrt() > floor
        })
        .map_or(0, |f| f + 1);
    (last + TAIL_FRAMES).min(frames)
}

/// What `speak` made: the samples (a whole number of mouth frames), and the timings it printed.
pub struct Spoken {
    pub pcm: Vec<f32>,
    pub ipa: String,
    pub words: Option<Vec<[f64; 2]>>,
    /// one `MOUTH_SHAPES` index per frame, as digits
    pub mouth: String,
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

/// The said words' spans regrouped into the text's whitespace words: a whitespace word that
/// says several words ("42" says "forty two") spans them all. `None` when a whitespace word
/// says nothing, or the counts disagree.
fn whitespace_spans(g: &EnglishG2P, text: &str, said: &[[f64; 2]]) -> Option<Vec<[f64; 2]>> {
    let mut out = Vec::new();
    let mut at = 0usize;
    for token in text.split_whitespace() {
        let n: usize = g.to_phrases(token).iter().map(|p| p.words.len()).sum();
        if n == 0 {
            return None;
        }
        let first = said.get(at)?;
        let last = said.get(at + n - 1)?;
        out.push([first[0], last[1]]);
        at += n;
    }
    (at == said.len()).then_some(out)
}

/// Seconds to microseconds, so the JSON prints short numbers (spans keep their order).
fn us(t: f64) -> f64 {
    js_round(t * 1e6) / 1e6
}

/// Plan and render `text` in `body_name`'s voice, reading the mouth every frame.
pub fn speak_text(text: &str, body_name: &str) -> Result<Spoken, String> {
    let b = body(body_name)?;
    let f0 = match body_name {
        "female" => 205.0,
        "child" => 250.0,
        _ => 112.0,
    };
    let g = g2p()?;
    let phrases = g.to_phrases(text);
    if phrases.is_empty() {
        return Err(format!("{text:?} has no words to say"));
    }
    let ipa = phrases
        .iter()
        .map(|p| p.segments.iter().map(|s| format!("{}{}", if s.stress == Some(1) { "ˈ" } else { "" }, s.ipa)).collect::<String>() + if p.intonation == Intonation::Question { "?" } else { "" })
        .collect::<Vec<_>>()
        .join(" | ");
    let inputs: Vec<PhraseInput> = phrases
        .iter()
        .map(|p| PhraseInput { segments: p.segments.clone(), intonation: Some(p.intonation), pause: Some(p.pause) })
        .collect();
    let plan = plan_phrases(&inputs, &PlanOptions { body: body_name.into(), t0: 0.05, f0: Some(f0), ..Default::default() });
    let mut voice = HumanVoice::new(FS, b, 2);
    voice.set_source(&SourcePatch::f0(f0));
    voice.schedule(&plan.gestures);

    let speaking = phrase_spans(&plan);
    let prototypes = mouth_prototypes(body_mix(body_name)?);
    let frames = (js_round(FS * (plan.end + 0.3)) as usize).div_ceil(HOP);
    let mut pcm = vec![0f32; frames * HOP];
    let mut mouth = String::with_capacity(frames);
    let half = HOP / 2;
    for (f, frame) in pcm.chunks_mut(HOP).enumerate() {
        // the frame's shape is the mouth at its middle; the voice runs sample by sample, so
        // stopping there doesn't change the sound
        render_blocks(&mut voice, &mut frame[..half]);
        let t = (f * HOP + half) as f64 / FS;
        let on = speaking.iter().any(|s| t >= s[0] && t < s[1]);
        mouth.push(char::from(b'0' + mouth_shape(&voice.artic.x, on, &prototypes)));
        render_blocks(&mut voice, &mut frame[half..]);
    }

    let keep = frames_to_keep(&pcm);
    pcm.truncate(keep * HOP);
    mouth.truncate(keep);

    let words = word_spans(&phrases, &plan)
        .and_then(|said| whitespace_spans(&g, text, &said))
        .map(|spans| spans.iter().map(|s| [us(s[0]), us(s[1])]).collect());
    Ok(Spoken { pcm, ipa, words, mouth })
}

/// `speak <out.wav> --text "…" [--body male|female|child]`
pub fn run(a: &[String]) -> Result<(), String> {
    const USE: &str = "speak <out.wav> --text \"English text.\" [--body male|female|child]";
    let mut out: Option<&str> = None;
    let mut text: Option<&str> = None;
    let mut body_name = "male";
    let mut it = a.iter();
    while let Some(x) = it.next() {
        match x.as_str() {
            "--text" => text = Some(it.next().ok_or(USE)?),
            "--body" => body_name = it.next().ok_or(USE)?,
            flag if flag.starts_with("--") => return Err(format!("unknown flag {flag}\n{USE}")),
            path if out.is_none() => out = Some(path),
            extra => return Err(format!("unexpected argument {extra:?}\n{USE}")),
        }
    }
    let (Some(out), Some(text)) = (out, text) else { return Err(USE.to_string()) };
    let spoken = speak_text(text, body_name)?;
    wav::write(out, &spoken.pcm, FS as u32, false).map_err(|e| format!("{out}: {e}"))?;
    let summary = json!({
        "file": out,
        "sampleRate": FS as u32,
        "samples": spoken.pcm.len(),
        "durationSec": spoken.pcm.len() as f64 / FS,
        "body": body_name,
        "ipa": spoken.ipa,
        "words": spoken.words,
        "mouth": { "rate": MOUTH_RATE, "shapes": MOUTH_SHAPES, "track": spoken.mouth },
        "engine": format!("chimera {}", env!("CARGO_PKG_VERSION")),
    });
    println!("{summary}");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The track as letters (`.` rest, `O` open, `W` wide, `U` round, `T` teeth), without the
    /// rest before and after the speech.
    fn shapes(text: &str, body: &str) -> String {
        let s = speak_text(text, body).unwrap();
        s.mouth.chars().map(|c| ['.', 'O', 'W', 'U', 'T'][(c as u8 - b'0') as usize]).collect::<String>().trim_matches('.').to_string()
    }

    #[test]
    fn the_mouth_shows_the_sounds_being_made_in_every_body() {
        for body in ["male", "female", "child"] {
            // the lips shut for the m between two open vowels (the first m's closure joins the
            // rest before the speech)
            let mama = shapes("mama", body);
            assert!(mama.starts_with('O') && mama.ends_with('O') && mama.contains("O.....") && mama.contains(".....O"), "{body} mama: {mama}");
            // the lower lip on the teeth for the f, then round lips for the oo
            let food = shapes("food", body);
            assert!(food.starts_with("TTTTT") && food.contains("UUUUUUUUUUUUUUUUUUUU") && !food.contains('O'), "{body} food: {food}");
            // spread lips for the ee (the child's /i/ spreads them far less than the man's)
            let see = shapes("see", body);
            assert!(see.ends_with("WWWWWWWWWW"), "{body} see: {see}");
            // a jaw-open ah between the f and the r-coloured vowel
            let father = shapes("father", body);
            assert!(father.starts_with("TTTTT") && father.contains("OOOOOOOOOO") && father.ends_with('U'), "{body} father: {father}");
            // /aɪ/ opens, then spreads
            let i = shapes("I", body);
            assert!(i.starts_with("OOOOO") && i.ends_with("WWWWW"), "{body} I: {i}");
        }
    }

    #[test]
    fn a_track_frame_covers_each_hundredth_of_the_clip_and_rests_at_both_ends() {
        let s = speak_text("Hello there.", "female").unwrap();
        assert_eq!(s.pcm.len() % HOP, 0);
        assert_eq!(s.mouth.len(), s.pcm.len() / HOP);
        assert!(s.mouth.starts_with("00000") && s.mouth.ends_with("00000"), "{}", s.mouth);
        assert!(s.mouth.bytes().all(|c| (b'0'..=b'4').contains(&c)));
    }

    #[test]
    fn words_follow_the_whitespace_words_of_the_text() {
        let s = speak_text("I have 42 apples, don't I?", "male").unwrap();
        let w = s.words.unwrap();
        assert_eq!(w.len(), 6, "{w:?}");
        let mut prev = 0.0;
        for [a, b] in &w {
            assert!(*a >= prev && b > a, "{w:?}");
            prev = *b;
        }
        assert!(prev <= s.pcm.len() as f64 / FS);
        // "42" says two words, so it lasts longer than "I"
        assert!(w[2][1] - w[2][0] > w[0][1] - w[0][0]);
        // a whitespace word that says nothing can't be timed
        assert!(speak_text("Wait -- what?", "male").unwrap().words.is_none());
    }

    #[test]
    fn speak_sounds_like_render_text_up_to_the_silent_tail() {
        // the same plan and voice as `render text`, so the same samples until speak cuts the tail
        let text = "Tonight we vote.";
        let s = speak_text(text, "male").unwrap();
        let b = body("male").unwrap();
        let g = g2p().unwrap();
        let phrases = g.to_phrases(text);
        let inputs: Vec<PhraseInput> = phrases.iter().map(|p| PhraseInput { segments: p.segments.clone(), intonation: Some(p.intonation), pause: Some(p.pause) }).collect();
        let plan = plan_phrases(&inputs, &PlanOptions { body: "male".into(), t0: 0.05, f0: Some(112.0), ..Default::default() });
        let mut v = HumanVoice::new(FS, b, 2);
        v.set_source(&SourcePatch::f0(112.0));
        v.schedule(&plan.gestures);
        let mut x = vec![0f32; js_round(FS * (plan.end + 0.3)) as usize];
        render_blocks(&mut v, &mut x);
        assert!(s.pcm.len() < x.len() - FS as usize / 10, "the cut saves at least 0.1 s: {} of {}", s.pcm.len(), x.len());
        assert_eq!(&s.pcm[..], &x[..s.pcm.len()]);
        // what was cut is below -60 dB of the peak
        let peak = x.iter().fold(0f32, |m, v| m.max(v.abs()));
        assert!(x[s.pcm.len()..].iter().all(|v| v.abs() < peak * 1e-2), "the tail has sound");
    }
}
