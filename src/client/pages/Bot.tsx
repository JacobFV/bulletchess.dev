import type { Api } from "chessground/api";
import type { Key } from "chessground/types";
import { Chess } from "chess.js";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router";
import { canMate, statusText, uciToMove } from "../../shared/core";
import type { Color, GameStatus } from "../../shared/protocol";
import { POOLS, tcLabel } from "../../shared/tc";
import { Board } from "../components/Board";
import { Clock } from "../components/Clock";
import { MoveList } from "../components/MoveList";
import { PlayerTag } from "../components/PlayerTag";
import { PromotionPicker } from "../components/Promotion";
import { api } from "../lib/api";
import { isPromotion, lastMoveKeys, legalDests } from "../lib/chess";
import { BOT_LEVELS, Engine } from "../lib/engine";
import { useMe } from "../lib/me";
import { getPrefs, usePrefs } from "../lib/prefs";
import { playMoveSound, sound, unlockAudio } from "../lib/sound";
import { clockValue, type ClockAnchor } from "../lib/useLiveGame";

interface Setup {
  level: number;
  color: Color | "random";
  pool: string;
}

interface BotGame {
  level: number;
  you: Color;
  base: number;
  inc: number;
  moves: string[];
  sans: string[];
  clocks: number[];
  fen: string;
  anchor: ClockAnchor;
  status: GameStatus;
  winner: Color | null;
  startedAt: number;
}

const SETUP_KEY = "bc:bot-setup";
function loadSetup(): Setup {
  try {
    return { level: 3, color: "random", pool: "1+0", ...JSON.parse(localStorage.getItem(SETUP_KEY) ?? "{}") };
  } catch {
    return { level: 3, color: "random", pool: "1+0" };
  }
}

export function BotPage() {
  const [setup, setSetup] = useState<Setup>(loadSetup);
  const [game, setGame] = useState<BotGame | null>(null);
  const engine = useRef<Engine | null>(null);

  useEffect(() => {
    engine.current = new Engine();
    return () => engine.current?.destroy();
  }, []);

  const start = async () => {
    unlockAudio();
    try {
      localStorage.setItem(SETUP_KEY, JSON.stringify(setup));
    } catch {
      /* ignore */
    }
    const pool = POOLS.find((p) => p.id === setup.pool) ?? POOLS[2];
    const you: Color = setup.color === "random" ? (Math.random() < 0.5 ? "white" : "black") : setup.color;
    const lvl = BOT_LEVELS[setup.level - 1]!;
    await engine.current!.newGame();
    await engine.current!.setOption("Skill Level", lvl.skill);
    sound.start();
    setGame({
      level: setup.level,
      you,
      base: pool.base,
      inc: pool.inc,
      moves: [],
      sans: [],
      clocks: [],
      fen: new Chess().fen(),
      anchor: { clocks: { white: pool.base * 1000, black: pool.base * 1000 }, at: performance.now(), running: false, turn: "white" },
      status: "started",
      winner: null,
      startedAt: Date.now(),
    });
  };

  if (!game)
    return (
      <div className="page narrow">
        <div className="card">
          <h1>Play the computer</h1>
          <p className="muted">Stockfish 19 runs in your browser. Games are casual and saved to your history when you are signed in.</p>
          <div className="field">
            <span>Strength</span>
            <div className="seg levels">
              {BOT_LEVELS.map((l) => (
                <button key={l.level} className={l.level === setup.level ? "on" : ""} onClick={() => setSetup({ ...setup, level: l.level })} title={l.label}>
                  {l.level}
                </button>
              ))}
            </div>
            <small className="muted">Level {setup.level} · roughly {BOT_LEVELS[setup.level - 1]!.label}</small>
          </div>
          <div className="field">
            <span>Time control</span>
            <div className="seg">
              {POOLS.map((p) => (
                <button key={p.id} className={p.id === setup.pool ? "on" : ""} onClick={() => setSetup({ ...setup, pool: p.id })}>
                  {tcLabel(p)}
                </button>
              ))}
            </div>
          </div>
          <div className="field">
            <span>Your color</span>
            <div className="seg">
              {(["white", "random", "black"] as const).map((c) => (
                <button key={c} className={c === setup.color ? "on" : ""} onClick={() => setSetup({ ...setup, color: c })}>
                  {c === "white" ? "♔ White" : c === "black" ? "♚ Black" : "⚄ Random"}
                </button>
              ))}
            </div>
          </div>
          <button className="btn primary big" onClick={start}>
            Play
          </button>
        </div>
      </div>
    );

  return <BotBoard key={game.startedAt} initial={game} engine={engine.current!} onNew={() => setGame(null)} onRematch={start} />;
}

function BotBoard({ initial, engine, onNew, onRematch }: { initial: BotGame; engine: Engine; onNew: () => void; onRematch: () => void }) {
  const { me } = useMe();
  const prefs = usePrefs();
  const [g, setG] = useState<BotGame>(initial);
  const gRef = useRef(g);
  gRef.current = g;
  const cgApi = useRef<Api | null>(null);
  const [promo, setPromo] = useState<{ from: Key; to: Key } | null>(null);
  const [viewPly, setViewPly] = useState<number | null>(null);
  const [saved, setSaved] = useState<{ id?: string; error?: string } | null>(null);
  const [confirmResign, setConfirmResign] = useState(false);
  const thinking = useRef(false);

  const bot: Color = g.you === "white" ? "black" : "white";
  const turn: Color = g.moves.length % 2 === 0 ? "white" : "black";
  const chess = useMemo(() => new Chess(g.fen), [g.fen]);
  const dests = useMemo(() => (g.status === "started" ? legalDests(chess) : new Map<Key, Key[]>()), [chess, g.status]);
  const finished = g.status !== "started";

  const end = useCallback((status: GameStatus, winner: Color | null, at = performance.now()) => {
    const cur = gRef.current;
    if (cur.status !== "started") return;
    const clocks = { white: clockValue(cur.anchor, "white", at), black: clockValue(cur.anchor, "black", at) };
    const next = { ...cur, status, winner, anchor: { ...cur.anchor, clocks, running: false } };
    gRef.current = next;
    setG(next);
    engine.stop();
    sound.end();
  }, [engine]);

  const apply = useCallback(
    (uci: string, by: Color): boolean => {
      const cur = gRef.current;
      if (cur.status !== "started") return false;
      const c = new Chess(cur.fen);
      let san: string;
      try {
        san = c.move(uciToMove(uci)).san;
      } catch {
        return false;
      }
      const now = performance.now();
      const ply = cur.moves.length;
      let mine = clockValue(cur.anchor, by, now);
      if (mine <= 0 && ply >= 2) {
        end(canMate(c, by === "white" ? "black" : "white") ? "timeout" : "timeout-draw", canMate(c, by === "white" ? "black" : "white") ? (by === "white" ? "black" : "white") : null, now);
        return false;
      }
      if (ply >= 2) mine += cur.inc * 1000;
      const clocks = { ...cur.anchor.clocks, [by]: mine };
      const next: BotGame = {
        ...cur,
        moves: [...cur.moves, uci],
        sans: [...cur.sans, san],
        clocks: [...cur.clocks, Math.round(mine)],
        fen: c.fen(),
        anchor: { clocks, at: now, running: ply + 1 >= 2, turn: by === "white" ? "black" : "white" },
      };
      gRef.current = next;
      setG(next);
      playMoveSound(san);
      if (c.isCheckmate()) end("mate", by);
      else if (c.isStalemate()) end("stalemate", null);
      else if (c.isInsufficientMaterial()) end("insufficient", null);
      else if (c.isThreefoldRepetition()) end("repetition", null);
      else if (c.isDrawByFiftyMoves()) end("fifty", null);
      return true;
    },
    [end],
  );

  // Bot move.
  useEffect(() => {
    if (g.status !== "started" || turn !== bot || thinking.current) return;
    thinking.current = true;
    const lvl = BOT_LEVELS[g.level - 1]!;
    const remaining = clockValue(g.anchor, bot);
    // Think less when short of time, like a human would; never more than the level's budget.
    const ms = Math.max(30, Math.min(lvl.ms, remaining / 25));
    const startedAt = performance.now();
    void engine.go({ moves: g.moves }, `depth ${lvl.depth} movetime ${Math.round(ms)}`).then((best) => {
      // Lower levels pause a little so the game feels human, bounded by the clock.
      const pause = Math.max(0, Math.min(remaining / 40, 120 + Math.random() * 250 * (1 - g.level / 10)) - (performance.now() - startedAt));
      window.setTimeout(() => {
        thinking.current = false;
        if (best && gRef.current.moves.length === g.moves.length) apply(best, bot);
      }, g.moves.length < 2 ? 300 : pause);
    });
  }, [g.moves, g.status, turn, bot, g.level, g.anchor, engine, apply]);

  // Flag watcher.
  useEffect(() => {
    if (finished || !g.anchor.running) return;
    let raf = 0;
    const loop = () => {
      const cur = gRef.current;
      const stm = cur.anchor.turn;
      if (clockValue(cur.anchor, stm) <= 0) {
        const winner = stm === "white" ? "black" : "white";
        const c = new Chess(cur.fen);
        if (canMate(c, winner)) end("timeout", winner);
        else end("timeout-draw", null);
        return;
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [finished, g.anchor, end]);

  // Save finished games for signed-in players.
  useEffect(() => {
    if (!finished || saved || !me?.user || g.moves.length < 2) return;
    setSaved({});
    api<{ id: string }>("/api/games/bot", {
      method: "POST",
      json: { level: g.level, color: g.you, base: g.base, inc: g.inc, moves: g.moves, clocks: g.clocks, status: g.status, winner: g.winner, startedAt: g.startedAt },
    }).then(
      (r) => setSaved({ id: r.id }),
      (e) => setSaved({ error: (e as Error).message }),
    );
  }, [finished, saved, me, g]);

  useEffect(() => setViewPly(null), [g.moves.length]);

  const onMove = (from: Key, to: Key, premove: boolean) => {
    unlockAudio();
    if (isPromotion(chess, from, to)) {
      const aq = getPrefs().autoQueen;
      if (aq === "always" || (aq === "premove" && premove)) apply(`${from}${to}q`, g.you);
      else setPromo({ from, to });
      return;
    }
    if (!apply(`${from}${to}`, g.you)) cgApi.current?.set({ fen: gRef.current.fen });
  };

  const orientation = g.you;
  const top: Color = orientation === "white" ? "black" : "white";
  const lowAt = g.base >= 60 ? 10_000 : 5_000;
  const fenShown = viewPly === null ? g.fen : (() => {
    const c = new Chess();
    for (const m of g.moves.slice(0, viewPly)) c.move(uciToMove(m));
    return c.fen();
  })();
  const name = (c: Color) => (c === g.you ? <PlayerTag name={me?.user?.username ?? "You"} link={!!me?.user} /> : <PlayerTag name={`Stockfish level ${g.level}`} bot />);

  return (
    <div className="game-layout">
      <div className="game-board-col">
        <div className="pbar top">
          {name(top)}
          <Clock anchor={g.anchor} color={top} active={!finished && turn === top} lowAt={lowAt} />
        </div>
        <div className="board-stage" onPointerDown={unlockAudio}>
          <Board
            fen={fenShown}
            orientation={orientation}
            turnColor={viewPly === null ? turn : viewPly % 2 === 0 ? "white" : "black"}
            lastMove={lastMoveKeys(g.moves[(viewPly ?? g.moves.length) - 1])}
            check={viewPly === null ? chess.isCheck() : new Chess(fenShown).isCheck()}
            movableColor={!finished && viewPly === null ? g.you : undefined}
            dests={dests}
            onMove={onMove}
            premove={!finished && viewPly === null}
            viewOnly={viewPly !== null}
            apiRef={cgApi}
          />
          {promo && (
            <PromotionPicker
              color={g.you}
              onPick={(r) => {
                apply(`${promo.from}${promo.to}${r}`, g.you);
                setPromo(null);
              }}
              onCancel={() => {
                setPromo(null);
                cgApi.current?.set({ fen: g.fen });
              }}
            />
          )}
        </div>
        <div className="pbar bottom">
          {name(orientation)}
          <Clock anchor={g.anchor} color={orientation} active={!finished && turn === orientation} lowAt={lowAt} warn />
        </div>
      </div>
      <aside className="game-side">
        <div className="game-meta">
          <span className="tc">{tcLabel(g)}</span>
          <span>Casual · vs Stockfish {g.level}</span>
        </div>
        <MoveList sans={g.sans} current={viewPly ?? g.moves.length} onSelect={(p) => setViewPly(p >= g.moves.length ? null : p)} clocks={g.clocks} />
        {!finished ? (
          <div className="controls">
            <button
              className={`btn${confirmResign ? " danger" : ""}`}
              onClick={() => {
                if (prefs.confirmResign && !confirmResign) {
                  setConfirmResign(true);
                  window.setTimeout(() => setConfirmResign(false), 3000);
                  return;
                }
                end("resign", bot);
              }}
            >
              {confirmResign ? "Confirm resign" : "Resign"}
            </button>
          </div>
        ) : (
          <div className="result">
            <div className="result-score">{g.winner === "white" ? "1–0" : g.winner === "black" ? "0–1" : "½–½"}</div>
            <div className="result-text">{statusText(g.status, g.winner)}</div>
            <div className="controls">
              <button className="btn primary" onClick={onRematch}>
                Play again
              </button>
              <button className="btn" onClick={onNew}>
                Change settings
              </button>
            </div>
            <div className="small muted">
              {!me?.user ? (
                <>
                  <Link to="/signup">Sign up</Link> to keep your games.
                </>
              ) : saved?.id ? (
                <Link to={`/game/${saved.id}`}>Saved · open analysis →</Link>
              ) : saved?.error ? (
                <span className="bad">Not saved: {saved.error}</span>
              ) : g.moves.length < 2 ? (
                "Too short to save."
              ) : (
                "Saving…"
              )}
            </div>
          </div>
        )}
      </aside>
    </div>
  );
}
