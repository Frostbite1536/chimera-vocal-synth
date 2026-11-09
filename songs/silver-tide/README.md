# Silver Tide

An original song in the Celtic new-age style (slow, modal, a multitracked choir in a long
hall), sung entirely by CHIMERA: 100 layers, each one `chimera render notes` melody on a male,
female or child body, mixed to stereo. No samples or instruments.

E minor with Dorian and harmonic-minor colour (A major and B major chords), 72 BPM, 70 bars, about 4 minutes.

Listen: [silver-tide.mp3](silver-tide.mp3) (4:03, 256 kbps).

| Section | Bars | Lead |
|---|---|---|
| intro | 8 | choir and drone swell up, the ostinato enters at bar 5 |
| verse 1 | 8 | "Wind on the water, across the bay…" |
| chorus 1 | 8 | "Silver tide, carry me over…" |
| interlude | 4 | wordless "ah" |
| verse 2 | 8 | "Stars in the darkness are shining through…" |
| chorus 2 | 8 | the descant and counter-melody join |
| bridge | 8 | "Lumen maris, lumen stellae" (invented Latin: light of the sea, light of the stars) |
| final chorus | 8 | all 100 voices |
| tag | 4 | "ever on, ever on, carry me home" |
| outro | 6 | the choir fades into the hall |

## The 100 layers

| Group | Layers | Body | Part |
|---|---|---|---|
| lead | 4 | female | the melody, double-tracked three times |
| harmony | 4 | female | a diatonic third below, in the choruses and bridge |
| lowlead | 4 | male | the melody an octave down, in the choruses |
| soprano, alto, tenor, bass | 12 each | female/child, female, male, male | the voice-led choir pad, `oo`/`ah`/`oh` by section |
| sub | 6 | male | chord roots an octave under the bass |
| ostinato | 8 | female | two interlocking eighth-note arpeggios, `da` and `na` |
| descant | 6 | child | high sustained line |
| counter | 6 | female, male | a moving inner line, octaves apart |
| swell | 4 | female, male | the big `ah` that opens each chorus |
| shimmer | 4 | child | the alto line an octave up, for the last choruses |
| drone | 6 | male, female | an open fifth on E |

Within a group, every layer has its own detune (up to ±12 cents), timing lag (up to 35 ms),
vibrato depth and pan position. In each pad part, half the layers take their breaths a bar
later than the other half, so the pad never drops out.

## Make it

```sh
cargo build --release -p chimera-cli
bun songs/silver-tide/score.ts             # print the layers
bun songs/silver-tide/render.ts            # 100 renders into out/silver-tide/layers (~45 min on 4 cores)
bun songs/silver-tide/mix.ts               # out/silver-tide/silver-tide.wav (and .mp3 with ffmpeg)
```

`render.ts` skips layers whose melody file hasn't changed. The mix sets each layer to the same sung
level, then applies per-group EQ, per-section gain automation, constant-power panning, a
dotted-eighth ping-pong delay on the lead, an 8-line FDN hall (RT60 5.2 s) and a look-ahead limiter.
