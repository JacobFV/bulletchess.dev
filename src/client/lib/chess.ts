import { Chess, SQUARES, type Square } from "chess.js";
import type { Key } from "chessground/types";
import { uciToMove } from "../../shared/core";

export function legalDests(chess: Chess): Map<Key, Key[]> {
  const dests = new Map<Key, Key[]>();
  for (const s of SQUARES) {
    const ms = chess.moves({ square: s, verbose: true });
    if (ms.length) dests.set(s, ms.map((m) => m.to));
  }
  return dests;
}

export function isPromotion(chess: Chess, from: string, to: string): boolean {
  const p = chess.get(from as Square);
  return !!p && p.type === "p" && (to[1] === "8" || to[1] === "1");
}

export function replay(moves: string[]): Chess {
  const c = new Chess();
  for (const m of moves) c.move(uciToMove(m));
  return c;
}

/** FEN after each ply (index 0 = start position). */
export function fensOf(moves: string[]): string[] {
  const c = new Chess();
  const out = [c.fen()];
  for (const m of moves) {
    c.move(uciToMove(m));
    out.push(c.fen());
  }
  return out;
}

export function lastMoveKeys(u: string | undefined): Key[] | undefined {
  return u ? [u.slice(0, 2) as Key, u.slice(2, 4) as Key] : undefined;
}
