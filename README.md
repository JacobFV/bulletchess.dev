# bulletchess.dev

Fast, free, open-source bullet chess: **15 seconds to 3 minutes**, nothing slower. Live at **https://bulletchess.dev**.

- **Real-time play** over WebSockets, one Durable Object per game. Moves are validated and **clocks run on the server**; the browser only displays them.
- **Lag compensation**: the server measures each player's latency and refunds it per move, capped by a small quota so it can't be abused.
- **Premoves**, auto-queen (configurable), draw offers, resign, abort (until both sides have moved), rematch, and spectating.
- **Matchmaking** pools: ¼+0, ½+0, 1+0, 1+1, 2+0, 2+1. The rating window widens the longer you wait. **Friend challenges** by link with a custom time control.
- **Glicko-2 ratings** for Bullet and UltraBullet, with rating history, profiles, and a leaderboard.
- **Play the computer**: Stockfish 19 (lite WASM) runs in your browser at 8 strength levels. When you're signed in the game is saved, after the server has replayed and checked it.
- **Game archive** in D1: replay with move clocks, PGN download, and in-browser Stockfish analysis.
- **Email + password accounts** (Better Auth): email verification, password reset, change password, sign out of other sessions, delete account. Database-backed rate limits.

## Stack

| Part | What |
| --- | --- |
| Worker (`src/worker`) | Hono API, Better Auth (Drizzle adapter on D1, PBKDF2 password hashing via WebCrypto), static assets |
| `Lobby` Durable Object | matchmaking, live-game index, **serialised rating updates** |
| `GameRoom` Durable Object | authoritative game state (`src/shared/core.ts`), clocks, alarms for flagging, WebSocket hibernation |
| D1 | users, sessions, ratings, rating history, finished games |
| Email | Cloudflare Email Sending (`send_email` binding) from `mail.bulletchess.dev` |
| Client (`src/client`) | React 19, React Router, chessground, chess.js, Stockfish WASM |

The game rules and clock logic live in `src/shared/core.ts` as pure code, with no I/O, and are unit-tested directly.

## Develop

Requires Node ≥ 22 and pnpm.

```bash
pnpm install
cp .dev.vars.example .dev.vars      # ENVIRONMENT=development, EMAIL_PROVIDER=log
pnpm db:migrate:local
pnpm dev                            # http://localhost:5173 (Vite + workerd)
```

In development, emails are written to the console and to `GET /api/dev/mailbox`. That endpoint only exists when `ENVIRONMENT=development` and `EMAIL_PROVIDER=log`.

## Test

```bash
pnpm typecheck
pnpm test                 # unit tests: game core, clocks, lag compensation, Glicko-2, PGN
pnpm e2e                  # end-to-end against `pnpm dev`: two real accounts, matchmaking, a full
                          # game over WebSockets, ratings, archive/PGN, rematch, friend challenge,
                          # server-side flagging, bot-game validation, password reset, CSRF refusal
```

## Deploy

```bash
wrangler d1 create bulletchess                 # once; put the id in wrangler.jsonc
wrangler email sending enable mail.bulletchess.dev
wrangler secret put BETTER_AUTH_SECRET          # e.g. openssl rand -base64 48
pnpm deploy                                     # build, apply D1 migrations, deploy
```

## License

GPL-3.0-or-later (see `LICENSE`). This matches chessground and Stockfish, which are both GPL-3.0. The cburnett pieces are GPLv2+.
