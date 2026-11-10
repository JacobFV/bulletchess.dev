import { useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { perfOf, PERF_LABEL, POOLS, tcLabel, type PoolId } from "../../shared/tc";
import { ChallengeCard } from "../components/ChallengeCard";
import { ChallengeDialog } from "../components/ChallengeDialog";
import { GameRow, type GameSummary } from "../components/GameRow";
import { PlayerTag } from "../components/PlayerTag";
import { api } from "../lib/api";
import { useLobby } from "../lib/lobby";
import { useMe } from "../lib/me";
import { unlockAudio } from "../lib/sound";
import { OnlineList, useOnlinePlayers, useOpenChallenges } from "./Players";
import type { LiveGame } from "../../shared/protocol";

/** 15 → "0:15", 120 → "2:00": a time control drawn the way the clock will show it. */
function clockFace(base: number) {
  return `${Math.floor(base / 60)}:${String(base % 60).padStart(2, "0")}`;
}

export function Home() {
  const { me } = useMe();
  const nav = useNavigate();
  const [params, setParams] = useSearchParams();
  const { stats, seeking, error, connected, seek: lobbySeek, cancelSeek, clearError } = useLobby();
  const [dialog, setDialog] = useState<{ to?: string } | null>(null);
  const [live, setLive] = useState<LiveGame[]>([]);
  const [recent, setRecent] = useState<GameSummary[]>([]);
  const players = useOnlinePlayers();
  const open = useOpenChallenges();
  const [, tick] = useState(0);

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
    clearError();
    if (!me?.user) {
      nav(`/signin?next=${encodeURIComponent(`/?seek=${pool}`)}`);
      return;
    }
    if (seeking?.pool === pool) return cancelSeek();
    lobbySeek(pool);
  };

  // ?seek=1+0 (from "New opponent" or after signing in) starts seeking automatically.
  const auto = params.get("seek");
  useEffect(() => {
    if (!auto || !me || !connected) return;
    if (me.user && POOLS.some((p) => p.id === auto)) lobbySeek(auto as PoolId);
    setParams({}, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auto, me, connected]);

  const otherOpen = open.filter((c) => c.from.id !== me?.user?.id);

  return (
    <div className="page home">
      <section className="hero">
        <div className="hero-copy">
          <p className="eyebrow">15 seconds to 3 minutes</p>
          <h1>
            Bullet chess. <em>Nothing else.</em>
          </h1>
          <p className="lede">Server-side clocks, premoves, lag compensation and Glicko-2 ratings. Free and open source.</p>
        </div>
        <dl className="hero-stats" aria-live="polite">
          <div>
            <dt>
              <span className={`dot${connected ? " on" : ""}`} /> Online
            </dt>
            <dd>{stats ? stats.players : "–"}</dd>
          </div>
          <div>
            <dt>Playing now</dt>
            <dd>{stats ? stats.games : "–"}</dd>
          </div>
        </dl>
      </section>

      <section className="pools" aria-label="Quick pairing">
        {POOLS.map((p) => {
          const active = seeking?.pool === p.id;
          const waiting = stats?.pools[p.id] ?? 0;
          const r = me?.ratings?.[perfOf(p)];
          return (
            <button key={p.id} className={`pool${active ? " active" : ""}`} onClick={() => seek(p.id)} aria-pressed={active} aria-label={`${tcLabel(p)} ${PERF_LABEL[perfOf(p)]}`}>
              <span className="pool-top">
                <span className="pool-name">{PERF_LABEL[perfOf(p)]}</span>
                {active ? (
                  <span className="pool-wait">{Math.floor((performance.now() - seeking.since) / 1000)}s</span>
                ) : waiting > 0 ? (
                  <span className="pool-wait live">{waiting} waiting</span>
                ) : me?.user ? (
                  <span className="pool-wait">{r ? `${r.rating}${r.provisional ? "?" : ""}` : "1500?"}</span>
                ) : null}
              </span>
              <span className="pool-tc">
                <span className="pool-base">{clockFace(p.base)}</span>
                <span className="pool-inc">+{p.inc}</span>
              </span>
              <span className="pool-foot">{active ? "Searching · tap to cancel" : p.inc ? `${p.inc}s increment` : "no increment"}</span>
              {active && <span className="pool-scan" aria-hidden="true" />}
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
        <button className="btn" onClick={() => (me?.user ? setDialog({}) : nav("/signin?next=/"))}>
          Challenge someone
        </button>
        <Link className="btn" to="/bot">
          Play the computer
        </Link>
      </section>

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

      <div className="home-columns">
        <section>
          <div className="section-head">
            <h2>Online players</h2>
            <Link to="/players" className="small">
              All players →
            </Link>
          </div>
          {players === null ? (
            <p className="muted small">Loading…</p>
          ) : players.length === 0 ? (
            <p className="muted small">Nobody signed in right now.</p>
          ) : (
            <OnlineList players={players} limit={8} onChallenge={(u) => setDialog({ to: u })} />
          )}
        </section>
        <section>
          <div className="section-head">
            <h2>Open challenges</h2>
            <Link to="/challenges" className="small">
              My challenges →
            </Link>
          </div>
          {otherOpen.length === 0 ? (
            <p className="muted small">No open challenges. Post one with “Challenge someone” → Anyone, now or at a set time.</p>
          ) : (
            <div className="challenge-list">
              {otherOpen.slice(0, 6).map((c) => (
                <ChallengeCard key={c.id} c={c} compact />
              ))}
            </div>
          )}
        </section>
      </div>

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

      {dialog && <ChallengeDialog to={dialog.to} onClose={() => setDialog(null)} />}
    </div>
  );
}
