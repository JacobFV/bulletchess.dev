import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router";
import type { ChallengeView } from "../../shared/protocol";
import { ALLOWED_BASES, ALLOWED_INCS, estimatedSeconds, perfOf, PERF_LABEL, SCHEDULE_MAX_LEAD_MS, SCHEDULE_MIN_LEAD_MS, tcLabel } from "../../shared/tc";
import { api } from "../lib/api";
import { challengeAction, useLobby } from "../lib/lobby";

type Target = "player" | "open" | "link";

function localInputValue(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function ChallengeDialog({ onClose, to }: { onClose: () => void; to?: string }) {
  const nav = useNavigate();
  const { refreshChallenges } = useLobby();
  const [target, setTarget] = useState<Target>("player");
  const [username, setUsername] = useState(to ?? "");
  const [scheduled, setScheduled] = useState(false);
  const defaultTime = useMemo(() => {
    const t = new Date(Date.now() + 60 * 60_000);
    t.setMinutes(t.getMinutes() < 30 ? 30 : 60, 0, 0);
    return localInputValue(t.getTime());
  }, []);
  const [when, setWhen] = useState(defaultTime);
  const [base, setBase] = useState(60);
  const [inc, setInc] = useState(0);
  const [rated, setRated] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<ChallengeView | null>(null);
  const [, tick] = useState(0);
  const valid = estimatedSeconds({ base, inc }) <= 180;
  const scheduledAt = scheduled && target !== "link" ? new Date(when).getTime() : null;
  const whenValid = scheduledAt === null || (scheduledAt >= Date.now() + SCHEDULE_MIN_LEAD_MS - 30_000 && scheduledAt <= Date.now() + SCHEDULE_MAX_LEAD_MS);

  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);

  useEffect(() => {
    if (!created || created.scheduledAt) return;
    const t = window.setInterval(() => tick((n) => n + 1), 500);
    return () => window.clearInterval(t);
  }, [created]);

  const create = async (color: "white" | "black" | "random") => {
    setBusy(true);
    setError(null);
    try {
      if (target === "link") {
        const r = await api<{ id: string }>("/api/challenges", { method: "POST", json: { base, inc, rated, color, mode: "link" } });
        nav(`/game/${r.id}`);
        return;
      }
      const r = await api<{ challenge: ChallengeView }>("/api/challenges", {
        method: "POST",
        json: { base, inc, rated, color, mode: target === "player" ? "direct" : "open", to: target === "player" ? username.trim() : undefined, scheduledAt },
      });
      setCreated(r.challenge);
      void refreshChallenges();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const cancel = async () => {
    if (created) await challengeAction(created.id, "cancel").catch(() => {});
    void refreshChallenges();
    onClose();
  };

  if (created) {
    const left = Math.max(0, Math.ceil((created.expiresAt - Date.now()) / 1000));
    return (
      <div className="modal-overlay" onClick={onClose}>
        <div className="modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
          <div className="tc big">{tcLabel(created)}</div>
          {created.scheduledAt ? (
            <>
              <h2>Scheduled for {new Date(created.scheduledAt).toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</h2>
              <p className="muted">
                {created.to ? `${created.to.username} has been notified and emailed.` : "Your challenge is listed for anyone to accept."} Once accepted, the game starts by itself at that time on whatever page you
                have open, and you get an email reminder 10 minutes before.
              </p>
              <div className="controls">
                <Link className="btn primary" to="/challenges" onClick={onClose}>
                  My challenges
                </Link>
                <button className="btn" onClick={onClose}>
                  Done
                </button>
              </div>
            </>
          ) : (
            <>
              <h2>{created.to ? `Waiting for ${created.to.username}…` : "Waiting for anyone to accept…"}</h2>
              <div className="spinner-row">
                <span className="spinner" /> {left > 0 ? `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")} left` : "Expired"}
              </div>
              <p className="muted small">The game opens automatically when accepted. You can keep browsing; closing this box does not cancel the challenge.</p>
              <div className="controls">
                <button className="btn" onClick={cancel}>
                  Cancel challenge
                </button>
                <button className="btn ghost" onClick={onClose}>
                  Hide
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="ch-title" onClick={(e) => e.stopPropagation()}>
        <h2 id="ch-title">New challenge</h2>
        <div className="field">
          <span>Who</span>
          <div className="seg">
            <button className={target === "player" ? "on" : ""} onClick={() => setTarget("player")}>
              A player
            </button>
            <button className={target === "open" ? "on" : ""} onClick={() => setTarget("open")}>
              Anyone
            </button>
            <button className={target === "link" ? "on" : ""} onClick={() => setTarget("link")}>
              Via link
            </button>
          </div>
          {target === "player" && <input placeholder="Username" value={username} onChange={(e) => setUsername(e.target.value)} aria-label="Opponent username" autoFocus={!to} spellCheck={false} />}
          {target === "open" && <small className="muted">Listed in the lobby; the first player to accept plays you.</small>}
          {target === "link" && <small className="muted">You get a link to send; whoever opens it and presses Join plays you.</small>}
        </div>
        {target !== "link" && (
          <div className="field">
            <span>When</span>
            <div className="seg">
              <button className={!scheduled ? "on" : ""} onClick={() => setScheduled(false)}>
                Now
              </button>
              <button className={scheduled ? "on" : ""} onClick={() => setScheduled(true)}>
                Schedule
              </button>
            </div>
            {scheduled && (
              <>
                <input type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} aria-label="Start time" />
                <small className={whenValid ? "muted" : "bad"}>{whenValid ? `Your local time (${Intl.DateTimeFormat().resolvedOptions().timeZone}).` : "Pick a time between 2 minutes and 30 days from now."}</small>
              </>
            )}
          </div>
        )}
        <div className="field">
          <span>Minutes per side</span>
          <div className="seg">
            {ALLOWED_BASES.map((b) => (
              <button key={b} className={b === base ? "on" : ""} onClick={() => setBase(b)}>
                {tcLabel({ base: b, inc: 0 }).split("+")[0]}
              </button>
            ))}
          </div>
        </div>
        <div className="field">
          <span>Increment (seconds)</span>
          <div className="seg">
            {ALLOWED_INCS.map((i) => (
              <button key={i} className={i === inc ? "on" : ""} onClick={() => setInc(i)}>
                {i}
              </button>
            ))}
          </div>
        </div>
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
          {(["white", "random", "black"] as const).map((c) => (
            <button
              key={c}
              className={`btn color ${c}${c === "random" ? " primary" : ""}`}
              disabled={!valid || busy || !whenValid || (target === "player" && username.trim().length < 3)}
              onClick={() => create(c)}
              title={`You play ${c}`}
            >
              {c === "white" ? "♔ White" : c === "black" ? "♚ Black" : "⚄ Random"}
            </button>
          ))}
        </div>
        <button className="btn ghost" onClick={onClose}>
          Cancel
        </button>
      </div>
    </div>
  );
}
