import type { Api } from "chessground/api";
import type { Key } from "chessground/types";
import { Chess } from "chess.js";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { statusText } from "../../shared/core";
import type { Color, GameView } from "../../shared/protocol";
import { FINISHED } from "../../shared/protocol";
import { PERF_LABEL, tcLabel } from "../../shared/tc";
import { Board } from "../components/Board";
import { Clock } from "../components/Clock";
import { MoveList } from "../components/MoveList";
import { PlayerTag } from "../components/PlayerTag";
import { PromotionPicker } from "../components/Promotion";
import { api } from "../lib/api";
import { fensOf, isPromotion, lastMoveKeys, legalDests } from "../lib/chess";
import { useMe } from "../lib/me";
import { getPrefs, usePrefs } from "../lib/prefs";
import { unlockAudio } from "../lib/sound";
import { useLiveGame } from "../lib/useLiveGame";
import { Replay, type ArchivedGame } from "./Replay";

export function GamePage() {
  const { id = "" } = useParams();
  const [archived, setArchived] = useState<ArchivedGame | null>(null);
  const [mode, setMode] = useState<"loading" | "live" | "archived" | "missing">("loading");

  useEffect(() => {
    let alive = true;
    setMode("loading");
    setArchived(null);
    api<{ archived?: ArchivedGame; live?: GameView }>(`/api/games/${id}`)
      .then((r) => {
        if (!alive) return;
        if (r.archived) {
          setArchived(r.archived);
          setMode("archived");
        } else setMode("live");
      })
      .catch(() => alive && setMode("missing"));
    return () => {
      alive = false;
    };
  }, [id]);

  if (mode === "loading") return <div className="page center muted">Loading game…</div>;
  if (mode === "missing")
    return (
      <div className="page center">
        <h1>Game not found</h1>
        <p className="muted">It may have been aborted, or the link is wrong.</p>
        <Link className="btn primary" to="/">
          Back to the lobby
        </Link>
      </div>
    );
  if (mode === "archived" && archived) return <Replay game={archived} />;
  return <LiveGame id={id} onArchived={() => api<{ archived?: ArchivedGame }>(`/api/games/${id}`).then((r) => r.archived && (setArchived(r.archived), setMode("archived")))} />;
}

function poolOf(g: { base: number; inc: number }) {
  return g.base < 60 ? `${g.base}+${g.inc}` : `${g.base / 60}+${g.inc}`;
}

function LiveGame({ id, onArchived }: { id: string; onArchived: () => void }) {
  const nav = useNavigate();
  const { me, refresh } = useMe();
  const prefs = usePrefs();
  const live = useLiveGame(id, (rid) => nav(`/game/${rid}`));
  const { g, anchor } = live;
  const cgApi = useRef<Api | null>(null);
  const [viewPly, setViewPly] = useState<number | null>(null);
  const [flip, setFlip] = useState(false);
  const [promo, setPromo] = useState<{ from: Key; to: Key } | null>(null);
  const [confirmResign, setConfirmResign] = useState(false);
  const [, tick] = useState(0);

  useEffect(() => {
    if (live.archived) onArchived();
  }, [live.archived, onArchived]);

  const finished = !!g && FINISHED.includes(g.status);
  useEffect(() => {
    if (finished) void refresh();
  }, [finished, refresh]);

  // Snap back to the live position whenever a move arrives.
  const ply = g?.moves.length ?? 0;
  useEffect(() => setViewPly(null), [ply]);

  const you = g?.you ?? null;
  const turn: Color = ply % 2 === 0 ? "white" : "black";
  const chess = useMemo(() => (g ? new Chess(g.fen) : null), [g?.fen]); // eslint-disable-line react-hooks/exhaustive-deps
  const dests = useMemo(() => (chess && g?.status === "started" && you ? legalDests(chess) : new Map<Key, Key[]>()), [chess, g?.status, you]);
  const fens = useMemo(() => (viewPly !== null && g ? fensOf(g.moves) : null), [viewPly, g]);

  // First-move countdown re-render.
  useEffect(() => {
    if (!live.firstMoveDeadline) return;
    const t = window.setInterval(() => tick((n) => n + 1), 200);
    return () => window.clearInterval(t);
  }, [live.firstMoveDeadline]);

  // Keyboard: ←/→ browse, f flip.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === "INPUT") return;
      if (e.key === "f") setFlip((f) => !f);
      if (!g) return;
      if (e.key === "ArrowLeft") setViewPly((v) => Math.max(0, (v ?? g.moves.length) - 1));
      if (e.key === "ArrowRight") setViewPly((v) => (v === null || v + 1 >= g.moves.length ? null : v + 1));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [g]);

  // Tab title.
  useEffect(() => {
    if (!g) return;
    document.title = g.status === "started" && you && turn === you ? "Your turn · bulletchess" : g.white && g.black ? `${g.white.username} vs ${g.black.username} · bulletchess` : "bulletchess";
    return () => {
      document.title = "bulletchess";
    };
  }, [g, you, turn]);

  if (!g) return <div className="page center muted">{live.connected ? "Loading…" : "Connecting…"}</div>;

  if (g.status === "waiting") return <WaitingRoom g={g} send={live.send} signedIn={!!me?.user} error={live.error} />;

  const orientation: Color = (you ?? "white") === "white" ? (flip ? "black" : "white") : flip ? "white" : "black";
  const top: Color = orientation === "white" ? "black" : "white";
  const bottom: Color = orientation;
  const lowAt = g.base >= 60 ? 10_000 : 5_000;
  const playing = g.status === "started" && !!you;

  const onMove = (from: Key, to: Key, premove: boolean) => {
    unlockAudio();
    if (!chess) return;
    if (isPromotion(chess, from, to)) {
      const aq = getPrefs().autoQueen;
      if (aq === "always" || (aq === "premove" && premove)) live.playMove(`${from}${to}q`);
      else setPromo({ from, to });
      return;
    }
    live.playMove(`${from}${to}`);
  };

  const shownFen = viewPly !== null && fens ? fens[viewPly]! : g.fen;
  const shownLast = viewPly !== null ? lastMoveKeys(g.moves[viewPly - 1]) : lastMoveKeys(g.moves[ply - 1]);
  const shownCheck = viewPly === null ? !!chess?.isCheck() : new Chess(shownFen).isCheck();
  const shownTurn: Color = (viewPly ?? ply) % 2 === 0 ? "white" : "black";

  const fmLeft = live.firstMoveDeadline ? Math.max(0, Math.ceil((live.firstMoveDeadline - performance.now()) / 1000)) : null;

  const player = (c: Color) => {
    const p = g[c];
    return p ? <PlayerTag name={p.username} rating={p.rating} provisional={p.provisional} diff={p.ratingDiff} online={g.online[c]} /> : <span className="muted">—</span>;
  };

  const resign = () => {
    if (prefs.confirmResign && !confirmResign) {
      setConfirmResign(true);
      window.setTimeout(() => setConfirmResign(false), 3000);
      return;
    }
    setConfirmResign(false);
    live.send({ t: "resign" });
  };

  return (
    <div className={`game-layout${prefs.zen && playing ? " zen" : ""}`}>
      <div className="game-board-col">
        <div className="pbar top">
          {player(top)}
          <Clock anchor={anchor} color={top} active={g.status === "started" && turn === top} lowAt={lowAt} />
        </div>
        <div className="board-stage" onPointerDown={unlockAudio}>
          <Board
            fen={shownFen}
            orientation={orientation}
            turnColor={shownTurn}
            lastMove={shownLast}
            check={shownCheck}
            movableColor={playing && viewPly === null ? you! : undefined}
            dests={dests}
            onMove={onMove}
            premove={playing && viewPly === null}
            viewOnly={viewPly !== null}
            apiRef={cgApi}
          />
          {promo && you && (
            <PromotionPicker
              color={you}
              onPick={(r) => {
                live.playMove(`${promo.from}${promo.to}${r}`);
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
          {player(bottom)}
          <Clock anchor={anchor} color={bottom} active={g.status === "started" && turn === bottom} lowAt={lowAt} warn={you === bottom} />
        </div>
      </div>

      <aside className="game-side">
        <div className="game-meta">
          <span className="tc">{tcLabel(g)}</span>
          <span>{g.rated ? "Rated" : "Casual"}</span>
          <span>{PERF_LABEL[g.perf]}</span>
          {g.spectators > 0 && <span title="Spectators">👁 {g.spectators}</span>}
          {live.rtt !== null && <span className={`ping${live.rtt > 250 ? " bad" : ""}`} title="Round-trip time to the server">{live.rtt} ms</span>}
          {!live.connected && <span className="bad">reconnecting…</span>}
        </div>

        {fmLeft !== null && g.status === "started" && (
          <div className="notice">
            {you === turn ? "Your first move" : `${turn === "white" ? "White" : "Black"} to make the first move`} · {fmLeft}s
          </div>
        )}

        <MoveList sans={g.sans} current={viewPly ?? ply} onSelect={(p) => setViewPly(p >= ply ? null : p)} />

        {live.error && (
          <div className="alert" role="alert" onClick={live.clearError}>
            {live.error}
          </div>
        )}

        {g.drawOffer && g.status === "started" && you && g.drawOffer !== you && (
          <div className="offer">
            <span>Your opponent offers a draw</span>
            <button className="btn small primary" onClick={() => live.send({ t: "draw-accept" })}>
              Accept
            </button>
            <button className="btn small" onClick={() => live.send({ t: "draw-decline" })}>
              Decline
            </button>
          </div>
        )}

        {playing && (
          <div className="controls">
            {ply < 2 ? (
              <button className="btn" onClick={() => live.send({ t: "abort" })}>
                Abort
              </button>
            ) : (
              <>
                <button className={`btn${confirmResign ? " danger" : ""}`} onClick={resign}>
                  {confirmResign ? "Confirm resign" : "Resign"}
                </button>
                <button className="btn" disabled={g.drawOffer === you} onClick={() => live.send({ t: "draw-offer" })}>
                  {g.drawOffer === you ? "Draw offered" : "Offer draw"}
                </button>
              </>
            )}
            <button className="btn icon" title="Flip board (f)" onClick={() => setFlip((f) => !f)}>
              ⇅
            </button>
          </div>
        )}

        {!playing && !finished && (
          <div className="controls">
            <span className="muted">You are watching this game.</span>
            <button className="btn icon" title="Flip board (f)" onClick={() => setFlip((f) => !f)}>
              ⇅
            </button>
          </div>
        )}

        {finished && (
          <div className="result">
            <div className="result-score">{g.winner === "white" ? "1–0" : g.winner === "black" ? "0–1" : g.status === "aborted" || g.status === "noStart" ? "" : "½–½"}</div>
            <div className="result-text">{statusText(g.status, g.winner)}</div>
            {you && (
              <div className="controls">
                {g.status !== "aborted" && g.status !== "noStart" && (
                  <>
                    {g.rematchOffer === you ? (
                      <button className="btn" onClick={() => live.send({ t: "rematch-decline" })} title="Cancel rematch offer">
                        Rematch offered…
                      </button>
                    ) : g.rematchOffer ? (
                      <>
                        <button className="btn primary pulse" onClick={() => live.send({ t: "rematch-offer" })}>
                          Accept rematch
                        </button>
                        <button className="btn" onClick={() => live.send({ t: "rematch-decline" })}>
                          Decline
                        </button>
                      </>
                    ) : (
                      <button className="btn" onClick={() => live.send({ t: "rematch-offer" })}>
                        Rematch
                      </button>
                    )}
                  </>
                )}
                <button className="btn primary" onClick={() => nav(`/?seek=${encodeURIComponent(poolOf(g))}`)}>
                  New opponent
                </button>
              </div>
            )}
            <div className="controls">
              {g.status !== "aborted" && g.status !== "noStart" && (
                <a className="btn small" href={`/api/games/${g.id}/pgn`}>
                  Download PGN
                </a>
              )}
              <Link className="btn small" to="/">
                Lobby
              </Link>
            </div>
          </div>
        )}
      </aside>
    </div>
  );
}

function WaitingRoom({ g, send, signedIn, error }: { g: GameView; send: (m: { t: "join" } | { t: "abort" }) => void; signedIn: boolean; error: string | null }) {
  const [copied, setCopied] = useState(false);
  const url = `${location.origin}/game/${g.id}`;
  const creator = g.white ?? g.black;
  const isCreator = !!g.you;
  return (
    <div className="page narrow center">
      <div className="card waiting">
        <div className="tc big">{tcLabel(g)}</div>
        <div className="muted">
          {g.rated ? "Rated" : "Casual"} · {PERF_LABEL[g.perf]} · creator plays {g.creatorColor === "random" ? "a random color" : g.creatorColor}
        </div>
        {isCreator ? (
          <>
            <h1>Challenge a friend</h1>
            <p>Send this link. The game starts as soon as they open it and press Join.</p>
            <div className="copy-row">
              <input readOnly value={url} onFocus={(e) => e.currentTarget.select()} aria-label="Challenge link" />
              <button
                className="btn primary"
                onClick={async () => {
                  await navigator.clipboard.writeText(url);
                  setCopied(true);
                  window.setTimeout(() => setCopied(false), 1500);
                }}
              >
                {copied ? "Copied" : "Copy"}
              </button>
            </div>
            <div className="spinner-row">
              <span className="spinner" /> Waiting for your opponent…
            </div>
            <button className="btn" onClick={() => send({ t: "abort" })}>
              Cancel challenge
            </button>
          </>
        ) : (
          <>
            <h1>{creator?.username ?? "Someone"} challenges you</h1>
            {creator && <PlayerTag name={creator.username} rating={creator.rating} provisional={creator.provisional} />}
            {signedIn ? (
              <button
                className="btn primary big"
                onClick={() => {
                  unlockAudio();
                  send({ t: "join" });
                }}
              >
                Join game
              </button>
            ) : (
              <Link className="btn primary big" to={`/signin?next=${encodeURIComponent(`/game/${g.id}`)}`}>
                Sign in to join
              </Link>
            )}
          </>
        )}
        {error && <div className="alert">{error}</div>}
      </div>
    </div>
  );
}
