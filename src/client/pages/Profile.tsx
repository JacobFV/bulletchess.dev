import { useEffect, useState } from "react";
import { Link, useParams } from "react-router";
import { PERF_LABEL, PERFS, type Perf } from "../../shared/tc";
import { GameRow, type GameSummary } from "../components/GameRow";
import { api } from "../lib/api";
import { timeAgo } from "../lib/format";
import { useMe } from "../lib/me";

interface ProfileData {
  user: { id: string; username: string; createdAt: number };
  ratings: Partial<Record<Perf, { rating: number; rd: number; provisional: boolean; games: number; wins: number; losses: number; draws: number; best: number | null; lastPlayedAt: number | null }>>;
  totals: { games: number; wins: number | null; losses: number | null; draws: number | null; bot: number | null };
}

export function Profile() {
  const { username = "" } = useParams();
  const { me } = useMe();
  const [p, setP] = useState<ProfileData | null>(null);
  const [missing, setMissing] = useState(false);
  const [games, setGames] = useState<GameSummary[]>([]);
  const [next, setNext] = useState<number | null>(null);
  const [perf, setPerf] = useState<Perf>("bullet");
  const [history, setHistory] = useState<[number, number][]>([]);

  useEffect(() => {
    setP(null);
    setMissing(false);
    setGames([]);
    api<ProfileData>(`/api/users/${encodeURIComponent(username)}`).then(
      (d) => {
        setP(d);
        const best = (PERFS as readonly Perf[]).reduce<Perf>((a, b) => ((d.ratings[b]?.games ?? 0) > (d.ratings[a]?.games ?? 0) ? b : a), "bullet");
        setPerf(best);
      },
      () => setMissing(true),
    );
    api<{ games: GameSummary[]; next: number | null }>(`/api/users/${encodeURIComponent(username)}/games`).then(
      (r) => {
        setGames(r.games);
        setNext(r.next);
      },
      () => {},
    );
  }, [username]);

  useEffect(() => {
    api<{ points: [number, number][] }>(`/api/users/${encodeURIComponent(username)}/history?perf=${perf}`).then((r) => setHistory(r.points), () => setHistory([]));
  }, [username, perf]);

  const more = async () => {
    if (!next) return;
    const r = await api<{ games: GameSummary[]; next: number | null }>(`/api/users/${encodeURIComponent(username)}/games?before=${next}`);
    setGames((g) => [...g, ...r.games]);
    setNext(r.next);
  };

  if (missing)
    return (
      <div className="page center">
        <h1>No such player</h1>
        <Link to="/leaderboard">See the leaderboard</Link>
      </div>
    );
  if (!p) return <div className="page center muted">Loading…</div>;
  const isMe = me?.user?.username.toLowerCase() === p.user.username.toLowerCase();

  return (
    <div className="page">
      <header className="profile-head">
        <div className="avatar" aria-hidden>
          {p.user.username[0]!.toUpperCase()}
        </div>
        <div>
          <h1>{p.user.username}</h1>
          <div className="muted">
            Joined {new Date(p.user.createdAt).toLocaleDateString(undefined, { year: "numeric", month: "long" })} · {p.totals.games} games
            {p.totals.bot ? ` (${p.totals.bot} vs computer)` : ""}
          </div>
        </div>
        {isMe && (
          <Link className="btn small" to="/settings">
            Settings
          </Link>
        )}
      </header>

      <section className="rating-cards">
        {PERFS.map((pf) => {
          const r = p.ratings[pf];
          return (
            <button key={pf} className={`rating-card${pf === perf ? " on" : ""}`} onClick={() => setPerf(pf)}>
              <div className="rc-perf">{PERF_LABEL[pf]}</div>
              <div className="rc-rating">
                {r ? r.rating : 1500}
                {!r || r.provisional ? "?" : ""}
              </div>
              <div className="rc-sub muted">
                {r ? (
                  <>
                    {r.games} rated · {r.wins}W {r.losses}L {r.draws}D{r.best ? ` · peak ${r.best}` : ""}
                    {r.lastPlayedAt ? ` · ${timeAgo(r.lastPlayedAt)}` : ""}
                  </>
                ) : (
                  "No rated games yet"
                )}
              </div>
            </button>
          );
        })}
      </section>

      {history.length > 1 && <RatingChart points={history} />}

      <section>
        <h2>Games</h2>
        {games.length === 0 ? (
          <p className="muted">No games yet.</p>
        ) : (
          <div className="game-grid">
            {games.map((g) => (
              <GameRow key={g.id} g={g} perspective={p.user.id} />
            ))}
          </div>
        )}
        {next && (
          <button className="btn" onClick={more}>
            More games
          </button>
        )}
      </section>
    </div>
  );
}

function RatingChart({ points }: { points: [number, number][] }) {
  const W = 800;
  const H = 180;
  const P = 28;
  const ys = points.map((p) => p[1]);
  const min = Math.min(...ys) - 20;
  const max = Math.max(...ys) + 20;
  const x = (i: number) => P + (i / (points.length - 1)) * (W - 2 * P);
  const y = (v: number) => H - P - ((v - min) / (max - min)) * (H - 2 * P);
  const d = points.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p[1]).toFixed(1)}`).join(" ");
  const ticks = [min + 20, Math.round((min + max) / 2), max - 20];
  return (
    <figure className="chart">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Rating history: from ${ys[0]} to ${ys[ys.length - 1]}`}>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={P} x2={W - P} y1={y(t)} y2={y(t)} className="grid" />
            <text x={4} y={y(t) + 4} className="tick">
              {Math.round(t)}
            </text>
          </g>
        ))}
        <path d={`${d} L${x(points.length - 1)},${H - P} L${x(0)},${H - P} Z`} className="area" />
        <path d={d} className="line" />
        <circle cx={x(points.length - 1)} cy={y(ys[ys.length - 1]!)} r={4} className="last" />
      </svg>
      <figcaption className="muted small">
        Rating over the last {points.length} rated games · now {ys[ys.length - 1]}
      </figcaption>
    </figure>
  );
}
