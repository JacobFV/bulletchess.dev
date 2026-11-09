import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router";
import type { ChallengeView, OnlinePlayer } from "../../shared/protocol";
import { ChallengeCard } from "../components/ChallengeCard";
import { ChallengeDialog } from "../components/ChallengeDialog";
import { api } from "../lib/api";
import { useLobby } from "../lib/lobby";
import { useMe } from "../lib/me";

export function useOnlinePlayers(): OnlinePlayer[] | null {
  const { version } = useLobby();
  const [players, setPlayers] = useState<OnlinePlayer[] | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () => api<{ players: OnlinePlayer[] }>("/api/players/online").then((r) => alive && setPlayers(r.players), () => {});
    load();
    const t = window.setInterval(load, 10_000);
    return () => {
      alive = false;
      window.clearInterval(t);
    };
  }, [version]);
  return players;
}

export function useOpenChallenges(): ChallengeView[] {
  const { version } = useLobby();
  const [list, setList] = useState<ChallengeView[]>([]);
  useEffect(() => {
    let alive = true;
    const load = () => api<{ challenges: ChallengeView[] }>("/api/challenges/open").then((r) => alive && setList(r.challenges), () => {});
    load();
    const t = window.setInterval(load, 10_000);
    return () => {
      alive = false;
      window.clearInterval(t);
    };
  }, [version]);
  return list;
}

export function OnlineList({ players, limit, onChallenge }: { players: OnlinePlayer[]; limit?: number; onChallenge: (username: string) => void }) {
  const { me } = useMe();
  const nav = useNavigate();
  const shown = limit ? players.slice(0, limit) : players;
  return (
    <div className="online-list">
      {shown.map((p) => {
        const isMe = p.id === me?.user?.id;
        return (
          <div className="online-row" key={p.id}>
            <span className={`status-dot ${p.status}`} title={p.status} />
            <Link className="pname" to={`/@/${encodeURIComponent(p.username)}`}>
              {p.username}
            </Link>
            <span className="prating">
              {p.rating}
              {p.provisional ? "?" : ""}
            </span>
            <span className={`status-label ${p.status}`}>{p.status === "playing" ? "playing" : p.status === "seeking" ? "seeking a game" : "online"}</span>
            <span className="online-actions">
              {p.status === "playing" && p.gameId && (
                <Link className="btn small" to={`/game/${p.gameId}`}>
                  Watch
                </Link>
              )}
              {!isMe &&
                (p.acceptsChallenges ? (
                  <button className="btn small primary" onClick={() => (me?.user ? onChallenge(p.username) : nav("/signin?next=/players"))}>
                    Challenge
                  </button>
                ) : (
                  <span className="muted small">no challenges</span>
                ))}
              {isMe && <span className="muted small">you</span>}
            </span>
          </div>
        );
      })}
    </div>
  );
}

export function Players() {
  const players = useOnlinePlayers();
  const open = useOpenChallenges();
  const { me } = useMe();
  const [q, setQ] = useState("");
  const [dialog, setDialog] = useState<{ to?: string } | null>(null);
  const filtered = useMemo(() => (players ?? []).filter((p) => p.username.toLowerCase().includes(q.toLowerCase())), [players, q]);
  const counts = useMemo(() => ({ playing: (players ?? []).filter((p) => p.status === "playing").length, seeking: (players ?? []).filter((p) => p.status === "seeking").length }), [players]);
  const otherOpen = open.filter((c) => c.from.id !== me?.user?.id);
  const myOpen = open.filter((c) => c.from.id === me?.user?.id);

  return (
    <div className="page">
      <div className="page-head">
        <h1>Players online</h1>
        <button className="btn primary" onClick={() => setDialog({})}>
          New challenge
        </button>
      </div>
      <p className="muted">
        {players ? `${players.length} signed-in player${players.length === 1 ? "" : "s"} online · ${counts.playing} playing · ${counts.seeking} seeking` : "Loading…"}
      </p>

      {(otherOpen.length > 0 || myOpen.length > 0) && (
        <section>
          <h2>Open challenges</h2>
          <div className="challenge-list">
            {[...myOpen, ...otherOpen].map((c) => (
              <ChallengeCard key={c.id} c={c} />
            ))}
          </div>
        </section>
      )}

      <section>
        <h2>Online now</h2>
        {players && players.length > 8 && <input className="search" placeholder="Filter by username" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Filter players" />}
        {players && players.length === 0 && <p className="muted">Nobody is signed in right now. Post an open challenge and it will be waiting for the next player.</p>}
        {players && <OnlineList players={filtered} onChallenge={(u) => setDialog({ to: u })} />}
      </section>
      {dialog && <ChallengeDialog to={dialog.to} onClose={() => setDialog(null)} />}
    </div>
  );
}
