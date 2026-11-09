import { Chessground } from "chessground";
import type { Api } from "chessground/api";
import type { Key } from "chessground/types";
import { useEffect, useRef } from "react";
import { usePrefs } from "../lib/prefs";

export function MiniBoard({ fen, orientation = "white", lastMove }: { fen: string; orientation?: "white" | "black"; lastMove?: Key[] }) {
  const el = useRef<HTMLDivElement>(null);
  const cg = useRef<Api | null>(null);
  const prefs = usePrefs();
  useEffect(() => {
    if (!el.current) return;
    cg.current = Chessground(el.current, { fen, orientation, lastMove, viewOnly: true, coordinates: false, animation: { enabled: false }, drawable: { enabled: false } });
    return () => cg.current?.destroy();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    cg.current?.set({ fen, orientation, lastMove });
  }, [fen, orientation, lastMove]);
  return (
    <div className={`board-wrap mini theme-${prefs.board}`}>
      <div ref={el} className="cg-host" />
    </div>
  );
}
