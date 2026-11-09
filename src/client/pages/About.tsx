import { Link } from "react-router";

export function About() {
  return (
    <div className="page narrow prose">
      <h1>About bulletchess</h1>
      <p>
        bulletchess.dev is a free, open-source site for one thing: bullet chess. Every game is between 15 seconds and 3 minutes per side. Source code:{" "}
        <a href="https://github.com/JacobFV/bulletchess.dev" rel="noopener">
          github.com/JacobFV/bulletchess.dev
        </a>{" "}
        (GPL-3.0).
      </p>

      <h2>How games work</h2>
      <ul>
        <li>
          <strong>Clocks run on the server.</strong> Your browser only displays them. Each player gets a small, bounded lag allowance measured by the server, so a slow connection does not
          cost you the game.
        </li>
        <li>
          <strong>Clocks start after both players have moved once.</strong> If a side does not make its first move within 10–20 seconds the game is aborted with no rating change. You can abort until
          both sides have moved.
        </li>
        <li>
          <strong>Premoves.</strong> Make a move during your opponent's turn; it plays instantly when legal. Right-click to cancel. Promotions during premoves become queens (configurable in{" "}
          <Link to="/settings">settings</Link>).
        </li>
        <li>
          <strong>Running out of time</strong> loses, unless your opponent has only a king, or a king and a single minor piece; then it is a draw.
        </li>
        <li>Checkmate, stalemate, threefold repetition, the fifty-move rule and insufficient material are detected automatically.</li>
      </ul>

      <h2>Time controls and ratings</h2>
      <p>
        Pools: ¼+0, ½+0, 1+0, 1+1, 2+0, 2+1. Friend challenges can use any base from 15 seconds to 3 minutes and an increment up to 2 seconds, as long as base + 40 × increment is at most 3 minutes.
        Games estimated under 30 seconds count as <em>UltraBullet</em>; the rest as <em>Bullet</em>.
      </p>
      <p>
        Ratings use Glicko-2 (start 1500, τ = 0.75, rating deviation between 45 and 350, growing during inactivity). A rating is provisional — shown with “?” — while its deviation is above 110.
        Matchmaking pairs players within a rating window that widens the longer you wait.
      </p>

      <h2>Challenges and scheduled games</h2>
      <p>
        Challenge a specific player or post an open challenge for anyone, either now or at a set time. On-demand challenges expire after two minutes (open ones after ten). Scheduled games
        start by themselves at the agreed time on whatever bulletchess page you have open; you get an email reminder ten minutes before, and each side has three minutes to make a first move. You
        can stop people from challenging you in <Link to="/settings">settings</Link>.
      </p>

      <h2>Fair play</h2>
      <p>No engines, no outside help, no multiple accounts. Games against the computer are always casual.</p>

      <h2>Privacy</h2>
      <p>
        We store your email (to confirm your account and reset your password), your username, a hash of your password, your games and ratings. Session cookies keep you signed in. IP addresses are
        used for rate-limiting sign-in attempts. Board and sound preferences stay in your browser. Nothing is sold or shared; there are no ads and no third-party trackers. Delete your account at
        any time in <Link to="/settings">settings</Link>.
      </p>
      <p className="muted small">
        Pieces: Colin M.L. Burnett (GPLv2+). Board: chessground (GPL-3.0). Engine: Stockfish 19 via stockfish.js (GPL-3.0). Move logic: chess.js (BSD-2).
      </p>
    </div>
  );
}

export function NotFound() {
  return (
    <div className="page center">
      <h1>404</h1>
      <p className="muted">That square is empty.</p>
      <Link className="btn primary" to="/">
        Back to the lobby
      </Link>
    </div>
  );
}
