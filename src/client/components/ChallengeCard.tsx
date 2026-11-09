import { useState } from "react";
import { Link, useNavigate } from "react-router";
import type { ChallengeView } from "../../shared/protocol";
import { PERF_LABEL, perfOf, tcLabel } from "../../shared/tc";
import { challengeAction, useLobby } from "../lib/lobby";
import { useMe } from "../lib/me";
import { PlayerTag } from "./PlayerTag";

export function fmtWhen(ts: number): string {
  const d = new Date(ts);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  const time = d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  return sameDay ? `today ${time}` : `${d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })} ${time}`;
}

function until(ts: number): string {
  const s = Math.max(0, Math.round((ts - Date.now()) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} h ${m % 60} min`;
  return `${Math.round(h / 24)} days`;
}

/** One challenge with the actions available to the viewer. */
export function ChallengeCard({ c, compact }: { c: ChallengeView; compact?: boolean }) {
  const { me } = useMe();
  const nav = useNavigate();
  const { refreshChallenges } = useLobby();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const uid = me?.user?.id;
  const mine = c.from.id === uid;
  const opponent = mine ? (c.to ?? c.acceptedBy) : c.from;
  const myColor = mine ? c.color : c.color === "white" ? "black" : c.color === "black" ? "white" : "random";

  const act = async (a: "accept" | "decline" | "cancel") => {
    if (!uid && a === "accept") return nav(`/signin?next=${encodeURIComponent(location.pathname)}`);
    setBusy(true);
    setError(null);
    try {
      const r = await challengeAction(c.id, a);
      if (r.gameId) nav(`/game/${r.gameId}`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
      void refreshChallenges();
    }
  };

  const canAccept = c.status === "pending" && !mine && (!c.to || c.to.id === uid);
  const canDecline = !mine && ((c.status === "pending" && c.to?.id === uid) || (c.status === "accepted" && (c.to?.id === uid || c.acceptedBy?.id === uid)));
  const canCancel = mine && (c.status === "pending" || c.status === "accepted");

  return (
    <div className={`challenge-card${compact ? " compact" : ""}`}>
      <div className="cc-main">
        <span className="tc">{tcLabel(c)}</span>
        <span className="muted small">
          {c.rated ? "Rated" : "Casual"} · {PERF_LABEL[perfOf(c)]}
        </span>
        {opponent ? (
          <span className="cc-who">
            {mine ? (c.to ? "to" : "vs") : "from"} <PlayerTag name={opponent.username} rating={opponent.rating} provisional={opponent.provisional} />
          </span>
        ) : (
          <span className="cc-who muted">open to anyone</span>
        )}
        <span className="muted small">{myColor === "random" ? "random colors" : `you play ${myColor}`}</span>
      </div>
      <div className="cc-when">
        {c.scheduledAt ? (
          <>
            <strong>{fmtWhen(c.scheduledAt)}</strong>
            <span className="muted small">in {until(c.scheduledAt)}</span>
          </>
        ) : c.status === "started" && c.gameId ? (
          <Link to={`/game/${c.gameId}`}>Game started →</Link>
        ) : (
          <span className="muted small">now · expires in {until(c.expiresAt)}</span>
        )}
        {c.status === "accepted" && <span className="badge win">accepted</span>}
      </div>
      <div className="cc-actions">
        {canAccept && (
          <button className="btn primary small" disabled={busy} onClick={() => act("accept")}>
            {c.scheduledAt ? "Accept" : "Play"}
          </button>
        )}
        {canDecline && (
          <button className="btn small" disabled={busy} onClick={() => act("decline")}>
            {c.status === "accepted" ? "Withdraw" : "Decline"}
          </button>
        )}
        {canCancel && (
          <button className="btn small" disabled={busy} onClick={() => act("cancel")}>
            Cancel
          </button>
        )}
      </div>
      {error && <div className="alert small">{error}</div>}
    </div>
  );
}
