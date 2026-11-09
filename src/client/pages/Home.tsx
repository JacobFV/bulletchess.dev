import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import type { ClientLobbyMsg, ServerLobbyMsg } from "../../shared/protocol";
import { ALLOWED_BASES, ALLOWED_INCS, estimatedSeconds, perfOf, PERF_LABEL, POOLS, tcLabel, type PoolId } from "../../shared/tc";
import { GameRow, type GameSummary } from "../components/GameRow";
import { PlayerTag } from "../components/PlayerTag";
import { api, wsUrl } from "../lib/api";
import { useMe } from "../lib/me";
import { sound, unlockAudio } from "../lib/sound";
import type { LiveGame } from "../../shared/protocol";

interface Stats {
  players: number;
  games: number;
  pools: Record<string, number>;
}

export function Home() {
  const { me } = useMe();
  const nav = useNavigate();
  const [params, setParams] = useSearchParams();
  const [stats, setStats] = useState<Stats | null>(null);
  const [seeking, setSeeking] = useState<{ pool: PoolId; since: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [challengeOpen, setChallengeOpen] = useState(false);
  const [live, setLive] = useState<LiveGame[]>([]);
  const [recent, setRecent] = useState<GameSummary[]>([]);
  const ws = useRef<WebSocket | null>(null);
  const pendingSeek = useRef<PoolId | null>(null);
  const [, tick] = useState(0);

  const send = (m: ClientLobbyMsg) => {
    if (ws.current?.readyState === WebSocket.OPEN) ws.current.send(JSON.stringify(m));
  };

  useEffect(() => {
    let closed = false;
    let retry = 0;
    let timer: number | undefined;
    let keepalive: number | undefined;
    const connect = () => {
      const s = new WebSocket(wsUrl("/api/lobby/ws"));
      ws.current = s;
      s.onopen = () => {
        retry = 0;
        setConnected(true);
        keepalive = window.setInterval(() => s.readyState === WebSocket.OPEN && s.send(JSON.stringify({ t: "ping" })), 25_000);
        if (pendingSeek.current) {
          s.send(JSON.stringify({ t: "seek", pool: pendingSeek.current } satisfies ClientLobbyMsg));
        }
      };
      s.onmessage = (e) => {
        const m = JSON.parse(e.data) as ServerLobbyMsg;
        switch (m.t) {
          case "hello":
          case "stats":
            setStats({ players: m.players, games: m.games, pools: m.pools });
            break;
          case "seeking":
            setSeeking({ pool: m.pool, since: performance.now() });
            break;
          case "cancelled":
            pendingSeek.current = null;
            setSeeking(null);
            break;
          case "start":
            pendingSeek.current = null;
            sound.start();
            nav(`/game/${m.id}`);
            break;
          case "error":
            pendingSeek.current = null;
            setSeeking(null);
            setError(m.message);
            break;
        }
      };
      s.onclose = () => {
        window.clearInterval(keepalive);
        setConnected(false);
        if (!closed) timer = window.setTimeout(connect, Math.min(5000, 300 * 2 ** retry++));
      };
    };
    connect();
    return () => {
      closed = true;
      window.clearTimeout(timer);
      window.clearInterval(keepalive);
      ws.current?.close();
    };
  }, [nav]);

  useEffect(() => {
    const load = () => {
      api<{ games: LiveGame[] }>("/api/live").then((r) => setLive(r.games), () => {});
      api<{ games: GameSummary[] }>("/api/recent").then((r) => setRecent(r.games), () => {});
    };
    load();
    const t = window.setInterval(load, 15_000);
    return () => window.clearInterval(t);
  }, []);

  useEffect(() => {
    if (!seeking) return;
    const t = window.setInterval(() => tick((n) => n + 1), 250);
    return () => window.clearInterval(t);
  }, [seeking]);

  const seek = (pool: PoolId) => {
    unlockAudio();
    setError(null);
    if (!me?.user) {
      nav(`/signin?next=${encodeURIComponent(`/?seek=${pool}`)}`);
      return;
    }
    if (seeking?.pool === pool) {
      cancel();
      return;
    }
    pendingSeek.current = pool;
    setSeeking({ pool, since: performance.now() });
    send({ t: "seek", pool });
  };
  const cancel = () => {
    pendingSeek.current = null;
    setSeeking(null);
    send({ t: "cancel" });
  };

  // ?seek=1+0 (from "New opponent" or after signing in) starts seeking automatically.
  const auto = params.get("seek");
  useEffect(() => {
    if (!auto || !me) return;
    if (me.user && POOLS.some((p) => p.id === auto)) {
      pendingSeek.current = auto as PoolId;
      setSeeking({ pool: auto as PoolId, since: performance.now() });
      send({ t: "seek", pool: auto as PoolId });
    }
    setParams({}, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auto, me]);

  return (
    <div className="page home">
      <section className="hero">
        <h1>
          Bullet chess. <span className="accent">Nothing else.</span>
        </h1>
        <p className="muted">15 seconds to 3 minutes. Server-side clocks, premoves, lag compensation, Glicko-2 ratings. Free and open source.</p>
      </section>

      <section className="pools" aria-label="Quick pairing">
        {POOLS.map((p) => {
          const active = seeking?.pool === p.id;
          const waiting = stats?.pools[p.id] ?? 0;
          return (
            <button key={p.id} className={`pool${active ? " active" : ""}`} onClick={() => seek(p.id)} aria-pressed={active}>
              <span className="pool-tc">{tcLabel(p)}</span>
              <span className="pool-name">{PERF_LABEL[perfOf(p)]}</span>
              {active ? (
                <span className="pool-wait">
                  <span className="spinner" /> {Math.floor((performance.now() - seeking.since) / 1000)}s · cancel
                </span>
              ) : (
                <span className="pool-wait muted">{waiting > 0 ? `${waiting} waiting` : me?.user ? (me.ratings[perfOf(p)] ? `${me.ratings[perfOf(p)]!.rating}${me.ratings[perfOf(p)]!.provisional ? "?" : ""}` : "1500?") : " "}</span>
              )}
            </button>
          );
        })}
      </section>

      {error && (
        <div className="alert" role="alert">
          {error}
        </div>
      )}

      <section className="actions">
        <button className="btn big" onClick={() => (me?.user ? setChallengeOpen(true) : nav("/signin?next=/"))}>
          Challenge a friend
        </button>
        <Link className="btn big" to="/bot">
          Play the computer
        </Link>
      </section>

      <div className="online-line muted">
        <span className={`dot${connected ? " on" : ""}`} /> {stats ? `${stats.players} online · ${stats.games} game${stats.games === 1 ? "" : "s"} in progress` : "connecting…"}
      </div>

      {!me?.user && me && (
        <div className="card cta">
          <div>
            <strong>Create a free account to play rated games.</strong>
            <div className="muted">Just an email and a password. Or practise against Stockfish without one.</div>
          </div>
          <Link className="btn primary" to="/signup">
            Sign up
          </Link>
        </div>
      )}

      {live.length > 0 && (
        <section>
          <h2>Live now</h2>
          <div className="live-list">
            {live.map((g) => (
              <Link key={g.id} className="live-row" to={`/game/${g.id}`}>
                <span className="tc">{tcLabel(g)}</span>
                <PlayerTag name={g.white.username} rating={g.white.rating} provisional={g.white.provisional} link={false} />
                <span className="muted">vs</span>
                <PlayerTag name={g.black.username} rating={g.black.rating} provisional={g.black.provisional} link={false} />
                <span className="watch">Watch →</span>
              </Link>
            ))}
          </div>
        </section>
      )}

      {recent.length > 0 && (
        <section>
          <h2>Recent games</h2>
          <div className="game-grid">
            {recent.map((g) => (
              <GameRow key={g.id} g={g} />
            ))}
          </div>
        </section>
      )}

      {challengeOpen && <ChallengeDialog onClose={() => setChallengeOpen(false)} />}
    </div>
  );
}

function ChallengeDialog({ onClose }: { onClose: () => void }) {
  const nav = useNavigate();
  const [base, setBase] = useState(60);
  const [inc, setInc] = useState(0);
  const [rated, setRated] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const valid = estimatedSeconds({ base, inc }) <= 180;

  const create = async (color: "white" | "black" | "random") => {
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ id: string }>("/api/challenges", { method: "POST", json: { base, inc, rated, color } });
      nav(`/game/${r.id}`);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="ch-title" onClick={(e) => e.stopPropagation()}>
        <h2 id="ch-title">Challenge a friend</h2>
        <label className="field">
          <span>Minutes per side</span>
          <div className="seg">
            {ALLOWED_BASES.map((b) => (
              <button key={b} className={b === base ? "on" : ""} onClick={() => setBase(b)}>
                {tcLabel({ base: b, inc: 0 }).split("+")[0]}
              </button>
            ))}
          </div>
        </label>
        <label className="field">
          <span>Increment (seconds)</span>
          <div className="seg">
            {ALLOWED_INCS.map((i) => (
              <button key={i} className={i === inc ? "on" : ""} onClick={() => setInc(i)}>
                {i}
              </button>
            ))}
          </div>
        </label>
        <div className="field">
          <span>Mode</span>
          <div className="seg">
            <button className={rated ? "on" : ""} onClick={() => setRated(true)}>
              Rated
            </button>
            <button className={!rated ? "on" : ""} onClick={() => setRated(false)}>
              Casual
            </button>
          </div>
        </div>
        <div className="muted small">
          {tcLabel({ base, inc })} · {PERF_LABEL[perfOf({ base, inc })]}
          {!valid && <span className="bad"> · too slow for bullet (base + 40 × increment must be ≤ 3 min)</span>}
        </div>
        {error && <div className="alert">{error}</div>}
        <div className="color-pick">
          <button className="btn color white" disabled={!valid || busy} onClick={() => create("white")} title="Play white">
            ♔ White
          </button>
          <button className="btn color random primary" disabled={!valid || busy} onClick={() => create("random")} title="Random color">
            ⚄ Random
          </button>
          <button className="btn color black" disabled={!valid || busy} onClick={() => create("black")} title="Play black">
            ♚ Black
          </button>
        </div>
        <button className="btn ghost" onClick={onClose}>
          Cancel
        </button>
      </div>
    </div>
  );
}
