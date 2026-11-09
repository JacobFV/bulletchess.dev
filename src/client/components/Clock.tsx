import { useEffect, useRef, useState } from "react";
import type { Color } from "../../shared/protocol";
import { fmtClock } from "../lib/format";
import { sound } from "../lib/sound";
import { clockValue, type ClockAnchor } from "../lib/useLiveGame";

export function Clock({ anchor, color, active, lowAt, warn }: { anchor: ClockAnchor | null; color: Color; active: boolean; lowAt: number; warn?: boolean }) {
  const [, force] = useState(0);
  const warned = useRef(false);
  const running = !!anchor?.running && anchor.turn === color;
  useEffect(() => {
    if (!running) return;
    let raf = 0;
    const tick = () => {
      force((n) => (n + 1) & 0xffff);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [running]);
  const ms = clockValue(anchor, color);
  const low = ms <= lowAt;
  useEffect(() => {
    if (warn && low && running && !warned.current) {
      warned.current = true;
      sound.lowTime();
    }
    if (!low) warned.current = false;
  }, [low, running, warn]);
  return (
    <div className={`clock${running ? " running" : ""}${active ? " active" : ""}${low ? " low" : ""}${ms === 0 ? " flagged" : ""}`} role="timer" aria-label={`${color} clock`}>
      {fmtClock(ms)}
    </div>
  );
}
