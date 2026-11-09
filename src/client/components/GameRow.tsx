import { Link } from "react-router";
import { tcLabel, type Perf } from "../../shared/tc";
import type { Color, GameStatus } from "../../shared/protocol";
import { signed, timeAgo } from "../lib/format";
import { MiniBoard } from "./MiniBoard";

export interface GameSummary {
  id: string;
  white: { id: string | null; username: string; rating: number | null; ratingDiff: number | null };
  black: { id: string | null; username: string; rating: number | null; ratingDiff: number | null };
  rated: boolean;
  perf: Perf;
  base: number;
  inc: number;
  botLevel: number | null;
  status: GameStatus;
  winner: Color | null;
  fen: string;
  ply: number;
  endedAt: number;
}

export function GameRow({ g, perspective }: { g: GameSummary; perspective?: string }) {
  const myColor: Color | null = perspective ? (g.white.id === perspective ? "white" : g.black.id === perspective ? "black" : null) : null;
  const outcome = myColor ? (g.winner === null ? "draw" : g.winner === myColor ? "win" : "loss") : null;
  const side = (c: Color) => {
    const p = g[c];
    return (
      <div className={`gr-player${g.winner === c ? " won" : ""}`}>
        <span className={`piece-dot ${c}`} />
        <span className="pname">{p.username}</span>
        {p.rating != null && <span className="prating">{p.rating}</span>}
        {p.ratingDiff != null && <span className={`pdiff ${p.ratingDiff > 0 ? "up" : p.ratingDiff < 0 ? "down" : ""}`}>{signed(p.ratingDiff)}</span>}
      </div>
    );
  };
  return (
    <Link to={`/game/${g.id}`} className={`game-row${outcome ? ` ${outcome}` : ""}`}>
      <MiniBoard fen={g.fen} orientation={myColor ?? "white"} />
      <div className="gr-body">
        <div className="gr-head">
          <span className="tc">{tcLabel(g)}</span>
          <span>{g.botLevel ? `Stockfish ${g.botLevel}` : g.rated ? "Rated" : "Casual"}</span>
          <span className="muted">{timeAgo(g.endedAt)}</span>
        </div>
        {side("white")}
        {side("black")}
        <div className="gr-foot muted">
          {g.winner === "white" ? "1–0" : g.winner === "black" ? "0–1" : "½–½"} · {Math.ceil(g.ply / 2)} moves
          {outcome && <span className={`badge ${outcome}`}>{outcome}</span>}
        </div>
      </div>
    </Link>
  );
}
