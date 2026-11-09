import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { PERF_LABEL, PERFS, type Perf } from "../../shared/tc";
import { api } from "../lib/api";

interface Row {
  username: string;
  rating: number;
  rd: number;
  games: number;
  wins: number;
  losses: number;
  draws: number;
  provisional: boolean;
}

export function Leaderboard() {
  const [params, setParams] = useSearchParams();
  const perf = ((PERFS as readonly string[]).includes(params.get("perf") ?? "") ? params.get("perf") : "bullet") as Perf;
  const [rows, setRows] = useState<Row[] | null>(null);
  useEffect(() => {
    setRows(null);
    api<{ players: Row[] }>(`/api/leaderboard?perf=${perf}`).then((r) => setRows(r.players), () => setRows([]));
  }, [perf]);
  return (
    <div className="page">
      <h1>Leaderboard</h1>
      <div className="seg tabs" role="tablist">
        {PERFS.map((p) => (
          <button key={p} role="tab" aria-selected={p === perf} className={p === perf ? "on" : ""} onClick={() => setParams({ perf: p })}>
            {PERF_LABEL[p]}
          </button>
        ))}
      </div>
      {!rows ? (
        <p className="muted">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="muted">Nobody has played a rated {PERF_LABEL[perf]} game in the last 90 days. Be the first.</p>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>#</th>
              <th>Player</th>
              <th className="num">Rating</th>
              <th className="num">Games</th>
              <th className="num hide-sm">W / L / D</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={r.username} className={r.provisional ? "prov" : ""}>
                <td>{i + 1}</td>
                <td>
                  <Link to={`/@/${encodeURIComponent(r.username)}`}>{r.username}</Link>
                </td>
                <td className="num">
                  {r.rating}
                  {r.provisional ? "?" : ""}
                </td>
                <td className="num">{r.games}</td>
                <td className="num hide-sm">
                  {r.wins} / {r.losses} / {r.draws}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="muted small">Ratings marked “?” are provisional (rating deviation above 110). Only players active in the last 90 days are listed.</p>
    </div>
  );
}
