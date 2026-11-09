import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { authClient, authMessage } from "../lib/auth";
import { useMe } from "../lib/me";

function safeNext(n: string | null): string {
  return n && n.startsWith("/") && !n.startsWith("//") ? n : "/";
}

function AuthCard({ title, children, footer }: { title: string; children: ReactNode; footer?: ReactNode }) {
  return (
    <div className="page narrow">
      <div className="card auth">
        <h1>{title}</h1>
        {children}
      </div>
      {footer && <div className="auth-footer">{footer}</div>}
    </div>
  );
}

export function SignIn() {
  const [params] = useSearchParams();
  const next = safeNext(params.get("next"));
  const nav = useNavigate();
  const { refresh } = useMe();
  const [id, setId] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [unverified, setUnverified] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setUnverified(false);
    const isEmail = id.includes("@");
    const res = isEmail
      ? await authClient.signIn.email({ email: id.trim(), password, callbackURL: `${location.origin}/` })
      : await authClient.signIn.username({ username: id.trim(), password });
    setBusy(false);
    if (res.error) {
      if (res.error.code === "EMAIL_NOT_VERIFIED" || res.error.status === 403) setUnverified(true);
      setError(authMessage(res.error));
      return;
    }
    await refresh();
    nav(next, { replace: true });
  };

  return (
    <AuthCard
      title="Sign in"
      footer={
        <>
          New here? <Link to={`/signup${next !== "/" ? `?next=${encodeURIComponent(next)}` : ""}`}>Create an account</Link>
        </>
      }
    >
      <form onSubmit={submit} className="form">
        <label className="field">
          <span>Email or username</span>
          <input autoComplete="username" required value={id} onChange={(e) => setId(e.target.value)} autoFocus />
        </label>
        <label className="field">
          <span>Password</span>
          <input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        {error && (
          <div className="alert" role="alert">
            {error}
            {unverified && <div className="small">Check your inbox (and spam folder) for the confirmation link.</div>}
          </div>
        )}
        <button className="btn primary big" disabled={busy}>
          {busy ? "Signing in…" : "Sign in"}
        </button>
        <Link className="small" to="/forgot-password">
          Forgot your password?
        </Link>
      </form>
    </AuthCard>
  );
}

export function SignUp() {
  const [params] = useSearchParams();
  const next = safeNext(params.get("next"));
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [available, setAvailable] = useState<boolean | null>(null);
  const validName = /^[A-Za-z0-9][A-Za-z0-9_-]{1,18}[A-Za-z0-9]$/.test(username);

  useEffect(() => {
    setAvailable(null);
    if (!validName) return;
    const t = window.setTimeout(async () => {
      const r = await authClient.isUsernameAvailable({ username });
      setAvailable(r.data?.available ?? null);
    }, 350);
    return () => window.clearTimeout(t);
  }, [username, validName]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!validName) return setError(authMessage({ code: "INVALID_USERNAME" }));
    setBusy(true);
    setError(null);
    try {
      sessionStorage.setItem("bc:after-verify", next);
    } catch {
      /* ignore */
    }
    const res = await authClient.signUp.email({ email: email.trim(), password, name: username, username, callbackURL: `${location.origin}/` });
    setBusy(false);
    if (res.error) return setError(authMessage(res.error));
    setDone(true);
  };

  if (done)
    return (
      <AuthCard title="Check your email">
        <p>
          We sent a confirmation link to <strong>{email}</strong>. Open it to activate your account; then you can play rated games.
        </p>
        <p className="muted small">Nothing after a few minutes? Check spam, or sign in to get a fresh link.</p>
        <Link className="btn" to="/signin">
          Go to sign in
        </Link>
      </AuthCard>
    );

  return (
    <AuthCard
      title="Create your account"
      footer={
        <>
          Already have one? <Link to="/signin">Sign in</Link>
        </>
      }
    >
      <form onSubmit={submit} className="form">
        <label className="field">
          <span>Username</span>
          <input autoComplete="username" required minLength={3} maxLength={20} value={username} onChange={(e) => setUsername(e.target.value)} autoFocus spellCheck={false} />
          <small className={username && !validName ? "bad" : available === false ? "bad" : available ? "good" : "muted"}>
            {username && !validName ? "3–20 letters, digits, _ or -" : available === false ? "Taken" : available ? "Available" : "Shown to opponents. Cannot be changed later."}
          </small>
        </label>
        <label className="field">
          <span>Email</span>
          <input type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
          <small className="muted">Only used to confirm your account and reset your password.</small>
        </label>
        <label className="field">
          <span>Password</span>
          <input type="password" autoComplete="new-password" required minLength={10} maxLength={256} value={password} onChange={(e) => setPassword(e.target.value)} />
          <small className="muted">At least 10 characters.</small>
        </label>
        {error && (
          <div className="alert" role="alert">
            {error}
          </div>
        )}
        <button className="btn primary big" disabled={busy || available === false}>
          {busy ? "Creating…" : "Create account"}
        </button>
        <p className="small muted">
          By signing up you agree to play fair: no engines, no help. See <Link to="/about">about</Link>.
        </p>
      </form>
    </AuthCard>
  );
}

export function ForgotPassword() {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res = await authClient.requestPasswordReset({ email: email.trim(), redirectTo: `${location.origin}/reset-password` });
    setBusy(false);
    if (res.error && res.error.status === 429) return setError(authMessage(res.error));
    setSent(true);
  };
  if (sent)
    return (
      <AuthCard title="Check your email">
        <p>If an account exists for {email}, a reset link is on its way. It expires in an hour.</p>
        <Link className="btn" to="/signin">
          Back to sign in
        </Link>
      </AuthCard>
    );
  return (
    <AuthCard title="Reset your password">
      <form onSubmit={submit} className="form">
        <label className="field">
          <span>Email</span>
          <input type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
        </label>
        {error && <div className="alert">{error}</div>}
        <button className="btn primary big" disabled={busy}>
          Send reset link
        </button>
      </form>
    </AuthCard>
  );
}

function hashToken(): string | null {
  const h = new URLSearchParams(location.hash.slice(1));
  return h.get("token") ?? new URLSearchParams(location.search).get("token");
}

export function ResetPassword() {
  const [token] = useState(hashToken);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!token) return;
    setBusy(true);
    setError(null);
    const res = await authClient.resetPassword({ newPassword: password, token });
    setBusy(false);
    if (res.error) return setError(authMessage(res.error));
    history.replaceState(null, "", "/reset-password");
    setDone(true);
  };
  if (!token)
    return (
      <AuthCard title="Link incomplete">
        <p>This reset link is missing its token. Request a new one.</p>
        <Link className="btn" to="/forgot-password">
          Request a new link
        </Link>
      </AuthCard>
    );
  if (done)
    return (
      <AuthCard title="Password changed">
        <p>Your password was changed and every other session was signed out.</p>
        <Link className="btn primary" to="/signin">
          Sign in
        </Link>
      </AuthCard>
    );
  return (
    <AuthCard title="Choose a new password">
      <form onSubmit={submit} className="form">
        <label className="field">
          <span>New password</span>
          <input type="password" autoComplete="new-password" required minLength={10} maxLength={256} value={password} onChange={(e) => setPassword(e.target.value)} autoFocus />
        </label>
        {error && <div className="alert">{error}</div>}
        <button className="btn primary big" disabled={busy}>
          Change password
        </button>
      </form>
    </AuthCard>
  );
}

export function VerifyEmail() {
  const [token] = useState(hashToken);
  const nav = useNavigate();
  const { refresh } = useMe();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A deliberate click (not page load) consumes the token, so link scanners cannot.
  const confirm = async () => {
    if (!token) return;
    setBusy(true);
    const res = await authClient.verifyEmail({ query: { token } });
    setBusy(false);
    if (res.error) return setError(authMessage(res.error));
    history.replaceState(null, "", "/verify-email");
    await refresh();
    let next = "/";
    try {
      next = safeNext(sessionStorage.getItem("bc:after-verify"));
      sessionStorage.removeItem("bc:after-verify");
    } catch {
      /* ignore */
    }
    nav(next, { replace: true });
  };
  if (!token)
    return (
      <AuthCard title="Link incomplete">
        <p>This confirmation link is missing its token. Sign in to get a new one.</p>
        <Link className="btn" to="/signin">
          Sign in
        </Link>
      </AuthCard>
    );
  return (
    <AuthCard title="Confirm your email">
      <p>One click and you are in.</p>
      {error && <div className="alert">{error}</div>}
      <button className="btn primary big" onClick={confirm} disabled={busy} autoFocus>
        {busy ? "Confirming…" : "Confirm email"}
      </button>
    </AuthCard>
  );
}
