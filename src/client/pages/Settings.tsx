import { useEffect, useState, type FormEvent } from "react";
import { api } from "../lib/api";
import { Link, useNavigate } from "react-router";
import { MiniBoard } from "../components/MiniBoard";
import { authClient, authMessage } from "../lib/auth";
import { useMe } from "../lib/me";
import { BOARD_THEMES, setPrefs, usePrefs, type BoardTheme, type Prefs } from "../lib/prefs";
import { sound, unlockAudio } from "../lib/sound";

function Toggle({ k, label, hint }: { k: keyof Prefs; label: string; hint?: string }) {
  const prefs = usePrefs();
  return (
    <label className="toggle">
      <input type="checkbox" checked={!!prefs[k]} onChange={(e) => setPrefs({ [k]: e.target.checked } as Partial<Prefs>)} />
      <span>
        {label}
        {hint && <small className="muted"> · {hint}</small>}
      </span>
    </label>
  );
}

export function Settings() {
  const prefs = usePrefs();
  const { me, refresh } = useMe();
  return (
    <div className="page narrow">
      <h1>Settings</h1>
      <section className="card">
        <h2>Board</h2>
        <div className="theme-pick">
          {(Object.keys(BOARD_THEMES) as BoardTheme[]).map((t) => (
            <button key={t} className={`theme-swatch${prefs.board === t ? " on" : ""}`} onClick={() => setPrefs({ board: t })} aria-label={`${t} board`}>
              <span style={{ background: `conic-gradient(${BOARD_THEMES[t][1]} 0 90deg, ${BOARD_THEMES[t][0]} 0 180deg, ${BOARD_THEMES[t][1]} 0 270deg, ${BOARD_THEMES[t][0]} 0) 0 0/50% 50%` }} />
              {t}
            </button>
          ))}
        </div>
        <div className="settings-preview">
          <MiniBoard fen="r1bqkb1r/pppp1ppp/2n2n2/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR w KQkq - 4 4" lastMove={["g8", "f6"]} />
        </div>
        <Toggle k="coords" label="Show coordinates" />
        <Toggle k="showDests" label="Show legal moves" />
        <Toggle k="animation" label="Animate pieces" />
      </section>

      <section className="card">
        <h2>Play</h2>
        <Toggle k="premove" label="Premoves" hint="queue a move during your opponent's turn" />
        <label className="field">
          <span>Promote to queen automatically</span>
          <div className="seg">
            {(["always", "premove", "never"] as const).map((v) => (
              <button key={v} className={prefs.autoQueen === v ? "on" : ""} onClick={() => setPrefs({ autoQueen: v })}>
                {v === "always" ? "Always" : v === "premove" ? "On premove" : "Never"}
              </button>
            ))}
          </div>
        </label>
        <Toggle k="confirmResign" label="Confirm before resigning" />
        <Toggle k="zen" label="Zen mode" hint="hide everything but the board while playing" />
      </section>

      <section className="card">
        <h2>Sound</h2>
        <Toggle k="sound" label="Sounds" />
        <label className="field">
          <span>Volume</span>
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={prefs.volume}
            onChange={(e) => setPrefs({ volume: Number(e.target.value) })}
            onPointerUp={() => {
              unlockAudio();
              sound.move();
            }}
          />
        </label>
      </section>

      {me?.user ? (
        <>
          <ChallengePrefs />
          <Account refresh={refresh} />
        </>
      ) : <p className="muted">These preferences are stored in this browser. <Link to="/signin">Sign in</Link> to manage your account.</p>}
    </div>
  );
}

function ChallengePrefs() {
  const [value, setValue] = useState<"everyone" | "nobody" | null>(null);
  useEffect(() => {
    api<{ challenges: "everyone" | "nobody" }>("/api/me/prefs").then((r) => setValue(r.challenges), () => {});
  }, []);
  const set = async (v: "everyone" | "nobody") => {
    setValue(v);
    await api("/api/me/prefs", { method: "POST", json: { challenges: v } }).catch(() => {});
  };
  return (
    <section className="card">
      <h2>Challenges</h2>
      <div className="field">
        <span>Who can challenge you (now or scheduled)</span>
        <div className="seg">
          <button className={value === "everyone" ? "on" : ""} disabled={!value} onClick={() => set("everyone")}>
            Everyone
          </button>
          <button className={value === "nobody" ? "on" : ""} disabled={!value} onClick={() => set("nobody")}>
            Nobody
          </button>
        </div>
        <small className="muted">Open challenges and pool games are unaffected.</small>
      </div>
    </section>
  );
}

function Account({ refresh }: { refresh: () => Promise<void> }) {
  const nav = useNavigate();
  const { me } = useMe();
  const [cur, setCur] = useState("");
  const [nw, setNw] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [delPw, setDelPw] = useState("");
  const [delMsg, setDelMsg] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const change = async (e: FormEvent) => {
    e.preventDefault();
    setMsg(null);
    const r = await authClient.changePassword({ currentPassword: cur, newPassword: nw, revokeOtherSessions: true });
    if (r.error) return setMsg({ ok: false, text: authMessage(r.error) });
    setCur("");
    setNw("");
    setMsg({ ok: true, text: "Password changed. Other sessions were signed out." });
  };

  const signOutEverywhere = async () => {
    await authClient.revokeOtherSessions();
    setMsg({ ok: true, text: "All other sessions were signed out." });
  };

  const del = async (e: FormEvent) => {
    e.preventDefault();
    if (!confirmDelete) return setConfirmDelete(true);
    const r = await authClient.deleteUser({ password: delPw });
    if (r.error) return setDelMsg(authMessage(r.error));
    await refresh();
    nav("/", { replace: true });
  };

  return (
    <>
      <section className="card">
        <h2>Account</h2>
        <p className="muted">
          Signed in as <strong>{me?.user?.username}</strong> ({me?.user?.email}).
        </p>
        <form className="form" onSubmit={change}>
          <label className="field">
            <span>Current password</span>
            <input type="password" autoComplete="current-password" required value={cur} onChange={(e) => setCur(e.target.value)} />
          </label>
          <label className="field">
            <span>New password</span>
            <input type="password" autoComplete="new-password" required minLength={10} value={nw} onChange={(e) => setNw(e.target.value)} />
          </label>
          {msg && <div className={msg.ok ? "notice" : "alert"}>{msg.text}</div>}
          <div className="controls">
            <button className="btn primary">Change password</button>
            <button type="button" className="btn" onClick={signOutEverywhere}>
              Sign out other sessions
            </button>
          </div>
        </form>
      </section>
      <section className="card danger-zone">
        <h2>Delete account</h2>
        <p className="muted">Deletes your account, ratings and sessions. Finished games stay in opponents' histories under your old username, unlinked from any account.</p>
        <form className="form" onSubmit={del}>
          <label className="field">
            <span>Password</span>
            <input type="password" autoComplete="current-password" required value={delPw} onChange={(e) => setDelPw(e.target.value)} />
          </label>
          {delMsg && <div className="alert">{delMsg}</div>}
          <button className="btn danger">{confirmDelete ? "Really delete my account" : "Delete account"}</button>
        </form>
      </section>
    </>
  );
}
