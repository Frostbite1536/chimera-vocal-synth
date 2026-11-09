//! `chimera speak | sing | call`: a voice rendered with its mouth, for a tool that animates a
//! face to it (Weft's `weft voice synth|sing --provider chimera`). Each writes a 16-bit mono
//! 48 kHz WAV and prints one JSON object: the clip's duration, its mouth (`mouth.track`, one of
//! `mouth.shapes` per 10 ms; `mouth.channels`, how open, round and spread, base-36 per 10 ms)
//! and, for speech and song, the clip-relative `[start, end)` of each whitespace word. The
//! rendering and the mouth are the engine's (`chimera::lipsync`); this file reads arguments and
//! writes files.
//!
//! - `speak <out.wav> --text "…" [--body male|female|child]`: English text, the `render text`
//!   plan, cut after its silent tail.
//! - `sing <out.wav> --melody melody.json [--body …]`: `{ bpm, lyrics, notes: [[midi, beats], …],
//!   vibrato?, t0? }` as `render notes` reads it; also prints `lead` (the clip time of the first
//!   note's beat) and `notes` (each sounding note's `[start, end)`).
//! - `call <out.wav> --creature songbird|seal|alligator|elephant [--call <id>]`: one call, its
//!   beak or jaw as the mouth (`rest` or `open`). `call --list` prints the creatures' calls.

use crate::render::g2p;
use crate::{FS, wav};
use chimera::lipsync::{self, Melody};
use serde_json::{Value, json};

fn write(out: &str, pcm: &[f32], mut summary: Value) -> Result<(), String> {
    wav::write(out, pcm, FS as u32, false).map_err(|e| format!("{out}: {e}"))?;
    summary["file"] = json!(out);
    println!("{summary}");
    Ok(())
}

/// `<out.wav>` and the `--flag value` pairs in `flags`; anything else is an error.
fn parse<'a>(a: &'a [String], usage: &str, flags: &[&str]) -> Result<(Option<&'a str>, Vec<(&'a str, &'a str)>), String> {
    let mut out = None;
    let mut values = Vec::new();
    let mut it = a.iter();
    while let Some(x) = it.next() {
        match x.as_str() {
            flag if flags.contains(&flag) => values.push((flag, it.next().ok_or(usage)?.as_str())),
            flag if flag.starts_with("--") => return Err(format!("unknown flag {flag}\n{usage}")),
            path if out.is_none() => out = Some(path),
            extra => return Err(format!("unexpected argument {extra:?}\n{usage}")),
        }
    }
    Ok((out, values))
}

fn flag<'a>(values: &[(&str, &'a str)], name: &str) -> Option<&'a str> {
    values.iter().rev().find(|(k, _)| *k == name).map(|(_, v)| *v)
}

/// `speak <out.wav> --text "…" [--body male|female|child]`
pub fn speak(a: &[String]) -> Result<(), String> {
    const USE: &str = "speak <out.wav> --text \"English text.\" [--body male|female|child]";
    let (out, v) = parse(a, USE, &["--text", "--body"])?;
    let (Some(out), Some(text)) = (out, flag(&v, "--text")) else { return Err(USE.to_string()) };
    let spoken = lipsync::speak(&g2p()?, text, flag(&v, "--body").unwrap_or("male"), FS)?;
    write(out, &spoken.take.pcm, spoken.to_json())
}

/// `sing <out.wav> --melody melody.json [--body male|female|child]`
pub fn sing(a: &[String]) -> Result<(), String> {
    const USE: &str = "sing <out.wav> --melody melody.json [--body male|female|child]";
    let (out, v) = parse(a, USE, &["--melody", "--body"])?;
    let (Some(out), Some(path)) = (out, flag(&v, "--melody")) else { return Err(USE.to_string()) };
    let text = std::fs::read_to_string(path).map_err(|e| format!("{path}: {e}"))?;
    let melody: Melody = serde_json::from_str(&text).map_err(|e| format!("{path}: {e}"))?;
    let sung = lipsync::sing(&g2p()?, &melody, flag(&v, "--body").unwrap_or("male"), FS)?;
    write(out, &sung.take.pcm, sung.to_json())
}

/// `call <out.wav> --creature <id> [--call <id>]`, or `call --list`
pub fn call(a: &[String]) -> Result<(), String> {
    const USE: &str = "call <out.wav> --creature songbird|seal|alligator|elephant [--call <id>] | call --list";
    if a.iter().any(|x| x == "--list") {
        let list: serde_json::Map<String, Value> = lipsync::creature_calls().into_iter().map(|(c, calls)| (c.to_string(), json!(calls))).collect();
        println!("{}", Value::Object(list));
        return Ok(());
    }
    let (out, v) = parse(a, USE, &["--creature", "--call"])?;
    let (Some(out), Some(creature)) = (out, flag(&v, "--creature")) else { return Err(USE.to_string()) };
    let called = lipsync::call(creature, flag(&v, "--call"), FS)?;
    write(out, &called.take.pcm, called.to_json())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::body;
    use crate::render::render_blocks;
    use chimera::math::js_round;
    use chimera::phonetics::planner::{PhraseInput, PlanOptions, plan_phrases};
    use chimera::voice::human_voice::{HumanVoice, SourcePatch};

    const HOP: usize = 480;

    fn spoken(text: &str, body: &str) -> lipsync::Spoken {
        lipsync::speak(&g2p().unwrap(), text, body, FS).unwrap()
    }

    /// A track as letters (`.` rest, `O` open, `W` wide, `U` round, `T` teeth), without the rest
    /// before and after.
    fn letters(track: &str) -> String {
        track.chars().map(|c| ['.', 'O', 'W', 'U', 'T'][(c as u8 - b'0') as usize]).collect::<String>().trim_matches('.').to_string()
    }

    fn shapes(text: &str, body: &str) -> String {
        letters(&spoken(text, body).take.track)
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
    fn the_channels_follow_the_shapes() {
        // "ah" is the most open and least round; "oo" the roundest; "ee" the most spread
        let max = |s: &str| s.chars().map(|c| c.to_digit(36).unwrap()).max().unwrap();
        let ah = spoken("ah", "male").take;
        let oo = spoken("ooh", "male").take;
        let ee = spoken("eee", "male").take;
        assert!(max(&ah.open) > max(&oo.open), "open: ah {} oo {}", ah.open, oo.open);
        assert!(max(oo.round.as_ref().unwrap()) > max(ah.round.as_ref().unwrap()));
        assert!(max(ee.spread.as_ref().unwrap()) > max(oo.spread.as_ref().unwrap()));
        // closed where the track rests, and as long as it
        for t in [&ah, &oo, &ee] {
            assert_eq!(t.open.len(), t.track.len());
            for (shape, open) in t.track.chars().zip(t.open.chars()) {
                if shape == '0' || shape == '4' {
                    assert_eq!(open, '0');
                }
            }
        }
    }

    #[test]
    fn a_track_frame_covers_each_hundredth_of_the_clip_and_rests_at_both_ends() {
        let s = spoken("Hello there.", "female").take;
        assert_eq!(s.pcm.len() % HOP, 0);
        assert_eq!(s.track.len(), s.pcm.len() / HOP);
        assert!(s.track.starts_with("00000") && s.track.ends_with("00000"), "{}", s.track);
        assert!(s.track.bytes().all(|c| (b'0'..=b'4').contains(&c)));
    }

    #[test]
    fn words_follow_the_whitespace_words_of_the_text() {
        let s = spoken("I have 42 apples, don't I?", "male");
        let w = s.words.unwrap();
        assert_eq!(w.len(), 6, "{w:?}");
        let mut prev = 0.0;
        for [a, b] in &w {
            assert!(*a >= prev && b > a, "{w:?}");
            prev = *b;
        }
        assert!(prev <= s.take.duration());
        // "42" says two words, so it lasts longer than "I"
        assert!(w[2][1] - w[2][0] > w[0][1] - w[0][0]);
        // a whitespace word that says nothing can't be timed
        assert!(spoken("Wait -- what?", "male").words.is_none());
    }

    #[test]
    fn speak_sounds_like_render_text_up_to_the_silent_tail() {
        // the same plan and voice as `render text`, so the same samples until speak cuts the tail
        let text = "Tonight we vote.";
        let s = spoken(text, "male").take;
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

    fn melody(json: &str) -> Melody {
        serde_json::from_str(json).unwrap()
    }

    #[test]
    fn a_song_lands_its_notes_on_the_beat_and_its_words_on_its_notes() {
        // 120 bpm: a beat is 0.5 s; the first note's beat is t0 (0.3 s)
        let m = melody(r#"{ "bpm": 120, "lyrics": "Hel-lo moon", "notes": [[60, 1], [62, 1], [0, 1], [64, 2]] }"#);
        let s = lipsync::sing(&g2p().unwrap(), &m, "female", FS).unwrap();
        assert_eq!(s.lead, 0.3);
        assert_eq!(s.notes, vec![[0.3, 0.8], [0.8, 1.3], [1.8, 2.8]]);
        let w = s.words.as_ref().unwrap();
        // "Hel-lo" is one whitespace word over two notes
        assert_eq!(w, &vec![[0.3, 1.3], [1.8, 2.8]]);
        // the mouth opens for "moon" and closes between the phrases
        let track = letters(&s.take.track);
        assert!(track.contains('U') && track.contains(".........."), "{track}");
        assert_eq!(s.take.track.len() * HOP, s.take.pcm.len());
    }

    #[test]
    fn a_song_refuses_lyrics_that_do_not_fit_its_notes() {
        let m = melody(r#"{ "bpm": 120, "lyrics": "one two three", "notes": [[60, 1], [62, 1]] }"#);
        let e = lipsync::sing(&g2p().unwrap(), &m, "male", FS).err().unwrap();
        assert!(e.contains("3 syllables for 2 notes"), "{e}");
    }

    #[test]
    fn every_creature_call_renders_with_a_mouth_that_opens_while_it_sounds() {
        for (creature, calls) in lipsync::creature_calls() {
            let c = lipsync::call(creature, Some(calls[0]), FS).unwrap();
            let t = &c.take;
            assert_eq!(t.track.len() * HOP, t.pcm.len(), "{creature}");
            assert!(t.track.bytes().all(|b| b == b'0' || b == b'1'), "{creature}: {}", t.track);
            assert!(t.track.contains('1'), "{creature} {}: never opens: {}", calls[0], t.track);
            assert!(t.round.is_none() && t.spread.is_none());
        }
        assert!(lipsync::call("dodo", None, FS).is_err());
        assert!(lipsync::call("seal", Some("moo"), FS).err().unwrap().contains("trill"));
    }
}
