/**
 * The bar under a pre-rendered show (the duet and choir pages): Play/Pause, the time, and a
 * scrubber. It follows the transport: at once on a change, and a few times a second while playing.
 */
import { useEffect, useState } from "react";
import type { Transport } from "../../show/transport.ts";

const clock = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`;

export function TransportBar(props: { transport: Transport | null; ready: boolean }) {
  const { transport, ready } = props;
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!transport) return;
    const off = transport.subscribe(() => setTick((n) => n + 1));
    const id = setInterval(() => transport.isPlaying && setTick((n) => n + 1), 250);
    return () => {
      off();
      clearInterval(id);
    };
  }, [transport]);
  const st = transport?.state ?? { playing: false, time: 0, duration: 0, epoch: 0 };
  return (
    <footer className="duet-bar">
      <button className="primary large" disabled={!ready} onClick={() => (st.playing ? transport?.pause() : transport?.play())}>
        {st.playing ? "Pause" : st.duration > 0 && st.time >= st.duration - 0.05 ? "Again" : "Play"}
      </button>
      <span className="duet-time">
        {clock(st.time)} / {clock(st.duration)}
      </span>
      <input
        type="range"
        aria-label="Position in the song"
        min={0}
        max={st.duration || 1}
        step={0.1}
        value={st.time}
        disabled={!ready}
        onChange={(e) => transport?.seek(Number(e.target.value))}
        style={{ "--pos": `${st.duration ? (100 * st.time) / st.duration : 0}%` } as React.CSSProperties}
      />
    </footer>
  );
}
