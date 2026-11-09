import { Chessground } from "chessground";
import type { Api } from "chessground/api";
import type { Config } from "chessground/config";
import type { DrawShape } from "chessground/draw";
import type { Color, Key } from "chessground/types";
import { useEffect, useRef } from "react";
import { usePrefs } from "../lib/prefs";

export interface BoardProps {
  fen: string;
  orientation: Color;
  turnColor: Color;
  lastMove?: Key[];
  check?: boolean;
  /** Which side the user may move (undefined: nobody). */
  movableColor?: Color;
  dests?: Map<Key, Key[]>;
  onMove?: (orig: Key, dest: Key, premove: boolean) => void;
  premove?: boolean;
  viewOnly?: boolean;
  shapes?: DrawShape[];
  apiRef?: React.MutableRefObject<Api | null>;
}

export function Board(p: BoardProps) {
  const el = useRef<HTMLDivElement>(null);
  const cg = useRef<Api | null>(null);
  const onMove = useRef(p.onMove);
  onMove.current = p.onMove;
  const prefs = usePrefs();

  const config = (): Config => ({
    fen: p.fen,
    orientation: p.orientation,
    turnColor: p.turnColor,
    lastMove: p.lastMove,
    check: p.check ? p.turnColor : false,
    coordinates: prefs.coords,
    viewOnly: p.viewOnly,
    animation: { enabled: prefs.animation, duration: 120 },
    highlight: { lastMove: true, check: true },
    movable: {
      free: false,
      color: p.movableColor,
      dests: p.dests ?? new Map(),
      showDests: prefs.showDests,
      events: { after: (o, d, meta) => onMove.current?.(o, d, !!meta.premove) },
    },
    premovable: { enabled: !!p.premove && prefs.premove, showDests: prefs.showDests, castle: true },
    draggable: { enabled: true, showGhost: true },
    drawable: { enabled: true, visible: true, autoShapes: p.shapes ?? [] },
    blockTouchScroll: true,
  });

  useEffect(() => {
    if (!el.current) return;
    cg.current = Chessground(el.current, config());
    if (p.apiRef) p.apiRef.current = cg.current;
    return () => {
      cg.current?.destroy();
      cg.current = null;
      if (p.apiRef) p.apiRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const api = cg.current;
    if (!api) return;
    api.set(config());
    if (!p.premove || !p.movableColor) api.cancelPremove();
    // It is our turn: fire a queued premove (no-op when none is set).
    else if (p.movableColor === p.turnColor) api.playPremove();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.fen, p.orientation, p.turnColor, p.lastMove?.join(), p.check, p.movableColor, p.dests, p.premove, p.viewOnly, p.shapes, prefs]);

  return (
    <div className={`board-wrap theme-${prefs.board}`}>
      <div ref={el} className="cg-host" />
    </div>
  );
}
