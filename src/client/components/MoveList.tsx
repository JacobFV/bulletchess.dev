import { useEffect, useRef } from "react";
import { fmtClock } from "../lib/format";

export function MoveList({ sans, current, onSelect, clocks }: { sans: string[]; current: number; onSelect: (ply: number) => void; clocks?: number[] }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current?.querySelector(".mv.cur") as HTMLElement | null;
    if (el && ref.current) {
      const box = ref.current;
      if (el.offsetTop < box.scrollTop || el.offsetTop > box.scrollTop + box.clientHeight - 30) box.scrollTop = el.offsetTop - box.clientHeight / 2;
    } else if (ref.current && current >= sans.length) ref.current.scrollTop = ref.current.scrollHeight;
  }, [current, sans.length]);
  const rows: { n: number; w?: string; b?: string }[] = [];
  for (let i = 0; i < sans.length; i += 2) rows.push({ n: i / 2 + 1, w: sans[i], b: sans[i + 1] });
  return (
    <div className="movelist" ref={ref} role="list" aria-label="Moves">
      {rows.length === 0 && <div className="movelist-empty">No moves yet</div>}
      {rows.map((r) => (
        <div className="mvrow" key={r.n} role="listitem">
          <span className="mvn">{r.n}.</span>
          {[r.w, r.b].map((san, k) => {
            const ply = (r.n - 1) * 2 + k + 1;
            return san ? (
              <button key={k} className={`mv${ply === current ? " cur" : ""}`} onClick={() => onSelect(ply)}>
                <span>{san}</span>
                {clocks?.[ply - 1] !== undefined && <small>{fmtClock(clocks[ply - 1]!)}</small>}
              </button>
            ) : (
              <span key={k} className="mv empty" />
            );
          })}
        </div>
      ))}
    </div>
  );
}
