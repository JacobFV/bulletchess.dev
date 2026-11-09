import { useEffect, useState } from "react";
import { createBrowserRouter, Link, NavLink, Outlet, RouterProvider, useLocation, useNavigate } from "react-router";
import { authClient } from "./lib/auth";
import { Toasts } from "./components/Toasts";
import { LobbyProvider, useLobby } from "./lib/lobby";
import { MeProvider, useMe } from "./lib/me";
import { BOARD_THEMES, usePrefs } from "./lib/prefs";
import { About, NotFound } from "./pages/About";
import { ForgotPassword, ResetPassword, SignIn, SignUp, VerifyEmail } from "./pages/Auth";
import { BotPage } from "./pages/Bot";
import { Challenges } from "./pages/Challenges";
import { Players } from "./pages/Players";
import { GamePage } from "./pages/Game";
import { Home } from "./pages/Home";
import { Leaderboard } from "./pages/Leaderboard";
import { Profile } from "./pages/Profile";
import { Settings } from "./pages/Settings";

function Layout() {
  return (
    <LobbyProvider>
      <Shell />
    </LobbyProvider>
  );
}

function Shell() {
  const { me, refresh } = useMe();
  const { challenges } = useLobby();
  const incoming = challenges.incoming.length;
  const nav = useNavigate();
  const loc = useLocation();
  const prefs = usePrefs();
  const [menu, setMenu] = useState(false);
  useEffect(() => setMenu(false), [loc.pathname]);
  useEffect(() => {
    const [light, dark] = BOARD_THEMES[prefs.board];
    document.documentElement.style.setProperty("--sq-light", light);
    document.documentElement.style.setProperty("--sq-dark", dark);
  }, [prefs.board]);

  const signOut = async () => {
    await authClient.signOut();
    await refresh();
    nav("/");
  };

  return (
    <div className="app">
      <header className="topbar">
        <Link to="/" className="logo" aria-label="bulletchess home">
          bullet<span>chess</span>
        </Link>
        <button className="btn icon menu-btn" onClick={() => setMenu((m) => !m)} aria-expanded={menu} aria-label="Menu">
          ☰
        </button>
        <nav className={`nav${menu ? " open" : ""}`}>
          <NavLink to="/" end>
            Play
          </NavLink>
          <NavLink to="/players">Players</NavLink>
          {me?.user && (
            <NavLink to="/challenges" className="with-badge">
              Challenges
              {incoming > 0 && <span className="nav-badge">{incoming}</span>}
            </NavLink>
          )}
          <NavLink to="/bot">Computer</NavLink>
          <NavLink to="/leaderboard">Leaderboard</NavLink>
          <NavLink to="/about">About</NavLink>
          <span className="nav-sep" />
          {me?.user ? (
            <>
              <NavLink to={`/@/${encodeURIComponent(me.user.username)}`} className="me">
                {me.user.username}
                {me.ratings.bullet && <small>{me.ratings.bullet.rating}{me.ratings.bullet.provisional ? "?" : ""}</small>}
              </NavLink>
              <NavLink to="/settings" aria-label="Settings">
                Settings
              </NavLink>
              <button className="linklike" onClick={signOut}>
                Sign out
              </button>
            </>
          ) : (
            <>
              <NavLink to="/settings">Settings</NavLink>
              <NavLink to="/signin">Sign in</NavLink>
              <Link className="btn primary small" to="/signup">
                Sign up
              </Link>
            </>
          )}
        </nav>
      </header>
      <main>
        <Outlet />
      </main>
      <Toasts />
      <footer className="footer muted">
        <span>bulletchess.dev</span>
        <a href="https://github.com/JacobFV/bulletchess.dev" rel="noopener">
          Source
        </a>
        <Link to="/about">About &amp; privacy</Link>
      </footer>
    </div>
  );
}

const router = createBrowserRouter([
  {
    element: <Layout />,
    children: [
      { path: "/", element: <Home /> },
      { path: "/game/:id", element: <GamePage /> },
      { path: "/bot", element: <BotPage /> },
      { path: "/players", element: <Players /> },
      { path: "/challenges", element: <Challenges /> },
      { path: "/@/:username", element: <Profile /> },
      { path: "/leaderboard", element: <Leaderboard /> },
      { path: "/settings", element: <Settings /> },
      { path: "/about", element: <About /> },
      { path: "/signin", element: <SignIn /> },
      { path: "/signup", element: <SignUp /> },
      { path: "/forgot-password", element: <ForgotPassword /> },
      { path: "/reset-password", element: <ResetPassword /> },
      { path: "/verify-email", element: <VerifyEmail /> },
      { path: "*", element: <NotFound /> },
    ],
  },
]);

export function App() {
  return (
    <MeProvider>
      <RouterProvider router={router} />
    </MeProvider>
  );
}
