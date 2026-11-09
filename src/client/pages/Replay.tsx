import type { DrawShape } from "chessground/draw";
import type { Key } from "chessground/types";
import { Chess } from "chess.js";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router";
import { statusText } from "../../shared/core";
import type { Color, GameStatus } from "../../shared/protocol";
import { PERF_LABEL, tcLabel, type Perf } from "../../shared/tc";
import { Board } from "../components/Board";
import { MoveList } from "../components/MoveList";
import { PlayerTag } from "../components/PlayerTag";
import { fensOf, lastMoveKeys } from "../lib/chess";
import { Engine, type EngineInfo } from "../lib/engine";
import { fmtClock, timeAgo } from "../lib/format";
import { useMe } from "../lib/me";

export interface ArchivedGame {
  id: string;
  white: { id: string | null; username: string; rating: number | null; ratingDiff: number | null };
  black: { id: string | null; username: string; rating: number | null; ratingDiff: number | null };
  rated: boolean;
  perf: Perf;
  base: number;
  inc: number;
  source: string;
  botLevel: number | null;
  status: GameStatus;
  winner: Color | null;
  moves: string[];
  sans: string[];
  moveClocks: number[];
  fen: string;
  ply: number;
  startedAt: number;
  endedAt: number;
  pgn: string;
}

export function Replay({ game: g }: { game: ArchivedGame }) {
  const fens = useMemo(() => fensOf(g.moves), [g.moves]);
  const [ply, setPly] = useState(g.moves.length);
  const [flip, setFlip] = useState(false);
  const [analyse, setAnalyse] = useState(false);
  const [info, setInfo] = useState<EngineInfo | null>(null);
  const engine = useRef<Engine | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === "INPUT" || (e.target as HTMLElement)?.tagName === "TEXTAREA") return;
      if (e.key === "ArrowLeft") setPly((p) => Math.max(0, p - 1));
      else if (e.key === "ArrowRight") setPly((p) => Math.min(g.moves.length, p + 1));
      else if (e.key === "ArrowUp" || e.key === "Home") setPly(0);
      else if (e.key === "ArrowDown" || e.key === "End") setPly(g.moves.length);
      else if (e.key === "f") setFlip((f) => !f);
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [g.moves.length]);

  useEffect(() => {
    if (!analyse) {
      engine.current?.destroy();
      engine.current = null;
      setInfo(null);
      return;
    }
    engine.current ??= new Engine();
    const e = engine.current;
    setInfo(null);
    let cancelled = false;
    void e.go({ fen: fens[ply], moves: [] }, "depth 22 movetime 4000", (i) => !cancelled && setInfo(i));
    return () => {
      cancelled = true;
      e.stop();
    };
  }, [analyse, ply, fens]);

  useEffect(() => () => engine.current?.destroy(), []);

  const { me } = useMe();
  const youAreBlack = !!me?.user && g.black.id === me.user.id;
  const orientation: Color = flip !== youAreBlack ? "black" : "white";
  const fen = fens[ply]!;
  const chess = useMemo(() => new Chess(fen), [fen]);
  const shapes: DrawShape[] = info?.pv[0] ? [{ orig: info.pv[0].slice(0, 2) as Key, dest: info.pv[0].slice(2, 4) as Key, brush: "paleBlue" }] : [];
  const top: Color = orientation === "white" ? "black" : "white";
  const bottom: Color = orientation;

  const tag = (c: Color) => {
    const p = g[c];
    const bot = g.botLevel !== null && p.id === null;
    return <PlayerTag name={p.username} rating={p.rating} diff={p.ratingDiff} bot={bot} link={!!p.id} />;
  };
  const clockAt = (c: Color) => {
    // clock after that side's latest move at or before `ply`
    const idx = c === "white" ? (ply % 2 === 1 ? ply - 1 : ply - 2) : ply % 2 === 0 ? ply - 1 : ply - 2;
    return idx >= 0 && g.moveClocks[idx] !== undefined ? g.moveClocks[idx]! : g.base * 1000;
  };

  const copy = async (what: string, text: string) => {
    await navigator.clipboard.writeText(text);
    setCopied(what);
    window.setTimeout(() => setCopied(null), 1500);
  };

  return (
    <div className="game-layout">
      <div className="game-board-col">
        <div className="pbar top">
          {tag(top)}
          <div className="clock static">{fmtClock(clockAt(top))}</div>
        </div>
        <div className="board-stage with-eval">
          {analyse && <EvalBar info={info} orientation={orientation} />}
          <Board fen={fen} orientation={orientation} turnColor={chess.turn() === "w" ? "white" : "black"} lastMove={lastMoveKeys(g.moves[ply - 1])} check={chess.isCheck()} viewOnly shapes={shapes} />
        </div>
        <div className="pbar bottom">
          {tag(bottom)}
          <div className="clock static">{fmtClock(clockAt(bottom))}</div>
        </div>
      </div>
      <aside className="game-side">
        <div className="game-meta">
          <span className="tc">{tcLabel(g)}</span>
          <span>{g.botLevel ? `vs Stockfish ${g.botLevel}` : g.rated ? "Rated" : "Casual"}</span>
          <span>{PERF_LABEL[g.perf]}</span>
          <span className="muted" title={new Date(g.endedAt).toLocaleString()}>
            {timeAgo(g.endedAt)}
          </span>
        </div>
        <div className="result compact">
          <div className="result-score">{g.winner === "white" ? "1–0" : g.winner === "black" ? "0–1" : "½–½"}</div>
          <div className="result-text">{statusText(g.status, g.winner)}</div>
        </div>
        {analyse && (
          <div className="engine-line">
            <strong>{fmtEval(info)}</strong> <span className="muted">depth {info?.depth ?? 0}</span>
            <div className="pv">{info ? pvToSan(fen, info.pv.slice(0, 8)) : "Thinking…"}</div>
          </div>
        )}
        <MoveList sans={g.sans} current={ply} onSelect={setPly} clocks={g.moveClocks} />
        <div className="nav-row">
          <button className="btn icon" onClick={() => setPly(0)} aria-label="First move">
            ⏮
          </button>
          <button className="btn icon" onClick={() => setPly((p) => Math.max(0, p - 1))} aria-label="Previous move">
            ◀
          </button>
          <button className="btn icon" onClick={() => setPly((p) => Math.min(g.moves.length, p + 1))} aria-label="Next move">
            ▶
          </button>
          <button className="btn icon" onClick={() => setPly(g.moves.length)} aria-label="Last move">
            ⏭
          </button>
          <button className="btn icon" onClick={() => setFlip((f) => !f)} title="Flip board (f)" aria-label="Flip board">
            ⇅
          </button>
        </div>
        <div className="controls wrap">
          <button className={`btn${analyse ? " primary" : ""}`} onClick={() => setAnalyse((a) => !a)}>
            {analyse ? "Stop analysis" : "Analyse with Stockfish"}
          </button>
          <a className="btn" href={`/api/games/${g.id}/pgn`}>
            Download PGN
          </a>
          <button className="btn" onClick={() => copy("pgn", g.pgn)}>
            {copied === "pgn" ? "Copied" : "Copy PGN"}
          </button>
          <button className="btn" onClick={() => copy("fen", fen)}>
            {copied === "fen" ? "Copied" : "Copy FEN"}
          </button>
          <Link className="btn" to="/">
            Lobby
          </Link>
        </div>
      </aside>
    </div>
  );
}

function fmtEval(i: EngineInfo | null): string {
  if (!i) return "…";
  if (i.mate !== null) return `#${i.mate}`;
  const v = (i.cp ?? 0) / 100;
  return `${v > 0 ? "+" : ""}${v.toFixed(1)}`;
}

function pvToSan(fen: string, pv: string[]): string {
  const c = new Chess(fen);
  const out: string[] = [];
  for (const u of pv) {
    try {
      const n = c.moveNumber();
      const white = c.turn() === "w";
      const san = c.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] }).san;
      out.push(white ? `${n}. ${san}` : out.length === 0 ? `${n}… ${san}` : san);
    } catch {
      break;
    }
  }
  return out.join(" ");
}

export function EvalBar({ info, orientation }: { info: EngineInfo | null; orientation: Color }) {
  let white = 50;
  if (info) {
    if (info.mate !== null) white = info.mate > 0 ? 100 : 0;
    else white = 50 + 50 * (2 / (1 + Math.exp(-0.004 * (info.cp ?? 0))) - 1);
  }
  return (
    <div className={`evalbar${orientation === "black" ? " flipped" : ""}`} aria-label="Evaluation">
      <div className="evalbar-white" style={{ height: `${white}%` }} />
    </div>
  );
}
