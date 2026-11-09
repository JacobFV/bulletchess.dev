import { Link } from "react-router";
import { useLobby } from "../lib/lobby";
import { ChallengeCard } from "./ChallengeCard";

export function Toasts() {
  const { toasts, dismissToast } = useLobby();
  if (!toasts.length) return null;
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className="toast">
          <button className="toast-x" onClick={() => dismissToast(t.id)} aria-label="Dismiss">
            ×
          </button>
          {t.kind === "note" ? (
            <span>{t.text}</span>
          ) : t.kind === "started" ? (
            <div className="toast-started">
              <div className="toast-title">Your game has started</div>
              <Link className="btn primary small" to={`/game/${t.gameId}`} onClick={() => dismissToast(t.id)}>
                Open game
              </Link>
            </div>
          ) : (
            <>
              <div className="toast-title">{t.c.scheduledAt ? "Scheduled challenge" : "Challenge!"}</div>
              <ChallengeCard c={t.c} compact />
            </>
          )}
        </div>
      ))}
    </div>
  );
}
