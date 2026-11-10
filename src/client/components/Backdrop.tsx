import { Chess } from "chess.js";
import { Chessground } from "chessground";
import type { Api } from "chessground/api";
import type { Key } from "chessground/types";
import { useEffect, useRef } from "react";

/** Morphy vs. Duke Karl & Count Isouard, Paris 1858: the Opera Game, replayed forever behind the menus. */
const OPERA =
  "e4 e5 Nf3 d6 d4 Bg4 dxe5 Bxf3 Qxf3 dxe5 Bc4 Nf6 Qb3 Qe7 Nc3 c6 Bg5 b5 Nxb5 cxb5 Bxb5+ Nbd7 O-O-O Rd8 Rxd7 Rxd7 Rd1 Qe6 Bxd7+ Nxd7 Qb8+ Nxb8 Rd8#".split(" ");

/**
 * The scene every page sits on: a big, tilted, blurred board that keeps playing a game.
 * It calms down (more blur, no moves) while a real board is on screen; see `body.has-board`.
 */
export function Backdrop() {
  const el = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!el.current) return;
    const cg: Api = Chessground(el.current, { viewOnly: true, coordinates: false, animation: { enabled: true, duration: 450 }, drawable: { enabled: false } });
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const chess = new Chess();
    let i = 0;
    const step = () => {
      if (document.hidden || document.body.classList.contains("has-board")) return;
      // Linger on the mate for a few beats before setting the pieces up again.
      if (i >= OPERA.length && i++ < OPERA.length + 3) return;
      if (i >= OPERA.length) {
        chess.reset();
        i = 0;
        cg.set({ fen: chess.fen(), lastMove: undefined });
        return;
      }
      const m = chess.move(OPERA[i++]!);
      cg.set({ fen: chess.fen(), lastMove: [m.from as Key, m.to as Key] });
    };
    if (reduced) {
      while (i < 20) step();
      return () => cg.destroy();
    }
    const t = window.setInterval(step, 1600);
    return () => {
      window.clearInterval(t);
      cg.destroy();
    };
  }, []);
  return (
    <div className="backdrop" aria-hidden="true">
      <div className="backdrop-board board-wrap theme-party">
        <div ref={el} className="cg-host" />
      </div>
      <div className="backdrop-tint" />
    </div>
  );
}
