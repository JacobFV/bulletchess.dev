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
  const [tab, setTab] = useState<"online" | "open" | "live" | "recent">("online");

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

  const tabs = [
    { id: "online", label: "Online", n: players?.length ?? 0 },
    { id: "open", label: "Challenges", n: otherOpen.length },
    { id: "live", label: "Live", n: live.length },
    { id: "recent", label: "Recent", n: 0 },
  ] as const;

  return (
    <div className="home">
      <h1 className="title-sticker">
        <span className="ts-1">Bullet</span>
        <span className="ts-2">Chess!</span>
        <span className="ts-tag">15 seconds → 3 minutes</span>
      </h1>

      <div className="page menu">
        <div className="ribbon">Pick your speed</div>

        <div className="status-pills">
          <span className="spill">
            <span className={`dot${connected ? " on" : ""}`} /> {stats ? `${stats.players} online` : "connecting…"}
          </span>
          {stats && (
            <span className="spill">
              {stats.games} game{stats.games === 1 ? "" : "s"} on now
            </span>
          )}
        </div>

        <section className="pools" aria-label="Quick pairing">
          {POOLS.map((p) => {
            const active = seeking?.pool === p.id;
            const waiting = stats?.pools[p.id] ?? 0;
            const r = me?.ratings?.[perfOf(p)];
            return (
              <button key={p.id} className={`pool${active ? " active" : ""}`} onClick={() => seek(p.id)} aria-pressed={active} aria-label={`${tcLabel(p)} ${PERF_LABEL[perfOf(p)]}`}>
                {waiting > 0 && !active && <span className="pool-bubble">{waiting}</span>}
                <span className="pool-tc">
                  <span className="pool-base">{clockFace(p.base)}</span>
                  <span className="pool-inc">+{p.inc}</span>
                </span>
                <span className="pool-name">
                  {active ? (
                    <>
                      Searching<span className="dots" /> {Math.floor((performance.now() - seeking.since) / 1000)}s
                    </>
                  ) : (
                    <>
                      {PERF_LABEL[perfOf(p)]}
                      {me?.user && <span className="pool-rating"> · {r ? `${r.rating}${r.provisional ? "?" : ""}` : "1500?"}</span>}
                    </>
                  )}
                </span>
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
          <button className="btn blue" onClick={() => (me?.user ? setDialog({}) : nav("/signin?next=/"))}>
            Challenge a friend
          </button>
          <Link className="btn purple" to="/bot">
            Vs. the computer
          </Link>
        </section>

        {!me?.user && me && (
          <div className="cta">
            <span>
              <strong>Play rated games</strong> <span className="muted">— just an email and a password.</span>
            </span>
            <Link className="btn primary small" to="/signup">
              Sign up
            </Link>
          </div>
        )}

        <div className="menu-tabs" role="tablist">
          {tabs.map((t) => (
            <button key={t.id} role="tab" aria-selected={tab === t.id} className={tab === t.id ? "on" : ""} onClick={() => setTab(t.id)}>
              {t.label}
              {t.n > 0 && <span className="count">{t.n}</span>}
            </button>
          ))}
        </div>
        <div className="menu-tab-body">
          {tab === "online" &&
            (players === null ? (
              <p className="empty-note">Loading…</p>
            ) : players.length === 0 ? (
              <p className="empty-note">Nobody signed in right now.</p>
            ) : (
              <>
                <OnlineList players={players} limit={8} onChallenge={(u) => setDialog({ to: u })} />
                <Link to="/players" className="more">
                  All players →
                </Link>
              </>
            ))}
          {tab === "open" &&
            (otherOpen.length === 0 ? (
              <p className="empty-note">No open challenges. Post one with “Challenge a friend” → Anyone.</p>
            ) : (
              <>
                <div className="challenge-list">
                  {otherOpen.slice(0, 6).map((c) => (
                    <ChallengeCard key={c.id} c={c} compact />
                  ))}
                </div>
                <Link to="/challenges" className="more">
                  My challenges →
                </Link>
              </>
            ))}
          {tab === "live" &&
            (live.length === 0 ? (
              <p className="empty-note">No games on right now. Start one!</p>
            ) : (
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
            ))}
          {tab === "recent" &&
            (recent.length === 0 ? (
              <p className="empty-note">No finished games yet.</p>
            ) : (
              <div className="game-grid">
                {recent.slice(0, 8).map((g) => (
                  <GameRow key={g.id} g={g} />
                ))}
              </div>
            ))}
        </div>
      </div>

      {dialog && <ChallengeDialog to={dialog.to} onClose={() => setDialog(null)} />}
    </div>
  );
}
