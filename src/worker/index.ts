import { Chess } from "chess.js";
import { Hono, type Context } from "hono";
import { z } from "zod";
import { uciToMove } from "../shared/core";
import { isProvisional } from "../shared/glicko";
import { isValidTimeControl, perfOf, PERFS } from "../shared/tc";
import { createAuth, getSessionUser, type SessionUser } from "./auth";
import { playerInfo, serializeGame, summarizeGame, type GameRow } from "./db";
import { devMailbox } from "./email";
import type { Env } from "./env";
import { randomId } from "./ids";

export { GameRoom } from "./game";
export { Lobby } from "./lobby";

type AppEnv = { Bindings: Env; Variables: { user: SessionUser | null } };
const app = new Hono<AppEnv>();

const lobby = (env: Env) => env.LOBBY.get(env.LOBBY.idFromName("global"));
const gameStub = (env: Env, id: string) => env.GAME.get(env.GAME.idFromName(id));
const GAME_ID = /^[A-Za-z0-9]{8}$/;

// Same-origin enforcement for state-changing requests and authenticated WebSockets
// (defence in depth on top of SameSite=Lax cookies).
function sameOrigin(c: Context<AppEnv>): boolean {
  const origin = c.req.header("Origin");
  return !origin || origin === c.env.APP_ORIGIN;
}

app.use("/api/*", async (c, next) => {
  if (c.req.method !== "GET" && c.req.method !== "HEAD" && c.req.method !== "OPTIONS" && !sameOrigin(c)) return c.json({ error: "Cross-origin request refused." }, 403);
  await next();
  c.header("Cache-Control", c.res.headers.get("Cache-Control") ?? "no-store");
  c.header("X-Content-Type-Options", "nosniff");
});

app.on(["GET", "POST"], "/api/auth/*", (c) => createAuth(c.env).handler(c.req.raw));

async function user(c: Context<AppEnv>): Promise<SessionUser | null> {
  if (c.get("user") === undefined) c.set("user", await getSessionUser(c.env, c.req.raw.headers));
  return c.get("user");
}

app.get("/api/me", async (c) => {
  const u = await user(c);
  if (!u) return c.json({ user: null });
  const { results } = await c.env.DB.prepare(`SELECT perf, rating, rd, games FROM ratings WHERE user_id = ?1`).bind(u.id).all<{ perf: string; rating: number; rd: number; games: number }>();
  return c.json({
    user: { id: u.id, username: u.username, email: u.email },
    ratings: Object.fromEntries(results.map((r) => [r.perf, { rating: Math.round(r.rating), provisional: isProvisional(r), games: r.games }])),
  });
});

// ---------------------------------------------------------------- live

app.get("/api/lobby/ws", async (c) => {
  if (c.req.header("Upgrade") !== "websocket") return c.text("Expected WebSocket", 426);
  const u = sameOrigin(c) ? await user(c) : null;
  const headers = new Headers(c.req.raw.headers);
  headers.delete("x-uid");
  headers.delete("x-username");
  if (u) {
    headers.set("x-uid", u.id);
    headers.set("x-username", u.username);
  }
  return lobby(c.env).fetch(new Request(c.req.url, { headers }));
});

app.get("/api/live", async (c) => {
  const l = lobby(c.env);
  const [games, stats] = await Promise.all([l.liveGames(12), l.onlineStats()]);
  return c.json({ games, stats });
});

app.get("/api/games/:id/ws", async (c) => {
  const id = c.req.param("id");
  if (!GAME_ID.test(id)) return c.text("Not found", 404);
  if (c.req.header("Upgrade") !== "websocket") return c.text("Expected WebSocket", 426);
  const u = sameOrigin(c) ? await user(c) : null;
  const headers = new Headers(c.req.raw.headers);
  headers.delete("x-uid");
  if (u) headers.set("x-uid", u.id);
  return gameStub(c.env, id).fetch(new Request(c.req.url, { headers }));
});

const challengeSchema = z.object({
  base: z.number().int(),
  inc: z.number().int(),
  rated: z.boolean(),
  color: z.enum(["white", "black", "random"]),
});

app.post("/api/challenges", async (c) => {
  const u = await user(c);
  if (!u) return c.json({ error: "Sign in to create a challenge." }, 401);
  const parsed = challengeSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success || !isValidTimeControl(parsed.data)) return c.json({ error: "Invalid challenge." }, 400);
  const { base, inc, rated, color } = parsed.data;
  const me = await playerInfo(c.env.DB, u.id, perfOf({ base, inc }), Date.now());
  if (!me) return c.json({ error: "Account not found." }, 404);
  const id = randomId(8);
  await gameStub(c.env, id).create({
    id,
    base,
    inc,
    rated,
    source: "challenge",
    white: color === "black" ? null : me,
    black: color === "black" ? me : null,
    creatorId: u.id,
    creatorColor: color,
  });
  return c.json({ id });
});

// ---------------------------------------------------------------- games

app.get("/api/games/:id", async (c) => {
  const id = c.req.param("id");
  if (!GAME_ID.test(id)) return c.json({ error: "Not found" }, 404);
  const row = await c.env.DB.prepare(`SELECT * FROM games WHERE id = ?1`).bind(id).first<GameRow>();
  if (row) return c.json({ archived: serializeGame(row, c.env.APP_ORIGIN) });
  const u = await user(c);
  const live = await gameStub(c.env, id).view(u?.id ?? null);
  if (!live) return c.json({ error: "Not found" }, 404);
  return c.json({ live });
});

app.get("/api/games/:id/pgn", async (c) => {
  const id = c.req.param("id");
  const row = GAME_ID.test(id) ? await c.env.DB.prepare(`SELECT * FROM games WHERE id = ?1`).bind(id).first<GameRow>() : null;
  if (!row) return c.text("Not found", 404);
  return new Response(serializeGame(row, c.env.APP_ORIGIN).pgn, {
    headers: { "Content-Type": "application/x-chess-pgn; charset=utf-8", "Content-Disposition": `attachment; filename="bulletchess-${id}.pgn"` },
  });
});

const botSchema = z.object({
  level: z.number().int().min(1).max(8),
  color: z.enum(["white", "black"]),
  base: z.number().int(),
  inc: z.number().int(),
  moves: z.array(z.string().regex(/^[a-h][1-8][a-h][1-8][qrbn]?$/)).max(1000),
  clocks: z.array(z.number().int().min(0).max(600_000)).max(1000),
  status: z.enum(["mate", "resign", "timeout", "stalemate", "repetition", "fifty", "insufficient", "timeout-draw"]),
  winner: z.enum(["white", "black"]).nullable(),
  startedAt: z.number().int(),
});

app.post("/api/games/bot", async (c) => {
  const u = await user(c);
  if (!u) return c.json({ error: "Sign in to save games." }, 401);
  const parsed = botSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success || !isValidTimeControl(parsed.data)) return c.json({ error: "Invalid game." }, 400);
  const g = parsed.data;
  if (g.moves.length < 2) return c.json({ error: "Too short to save." }, 400);
  const recent = await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM games WHERE source = 'bot' AND (white_id = ?1 OR black_id = ?1) AND ended_at > ?2`)
    .bind(u.id, Date.now() - 5_000)
    .first<{ n: number }>();
  if ((recent?.n ?? 0) > 0) return c.json({ error: "Slow down." }, 429);

  const chess = new Chess();
  const sans: string[] = [];
  try {
    for (const m of g.moves) sans.push(chess.move(uciToMove(m)).san);
  } catch {
    return c.json({ error: "Illegal move in game." }, 400);
  }
  const mover = g.moves.length % 2 === 1 ? "white" : "black";
  const bot = g.color === "white" ? "black" : "white";
  const ok =
    (g.status === "mate" && chess.isCheckmate() && g.winner === mover) ||
    (g.status === "stalemate" && chess.isStalemate() && !g.winner) ||
    (g.status === "insufficient" && chess.isInsufficientMaterial() && !g.winner) ||
    (g.status === "repetition" && chess.isThreefoldRepetition() && !g.winner) ||
    (g.status === "fifty" && chess.isDrawByFiftyMoves() && !g.winner) ||
    (g.status === "resign" && g.winner === bot && !chess.isGameOver()) ||
    (g.status === "timeout" && !!g.winner && !chess.isGameOver()) ||
    (g.status === "timeout-draw" && !g.winner && !chess.isGameOver());
  if (!ok) return c.json({ error: "Result does not match the position." }, 400);

  const id = randomId(8);
  const now = Date.now();
  const botName = `Stockfish level ${g.level}`;
  await c.env.DB.prepare(
    `INSERT INTO games (id, white_id, black_id, white_name, black_name, white_rating, black_rating, white_diff, black_diff, rated, perf, base, inc, source, bot_level, status, winner, moves, sans, clocks, final_fen, ply, started_at, ended_at)
     VALUES (?1, ?2, ?3, ?4, ?5, NULL, NULL, NULL, NULL, 0, ?6, ?7, ?8, 'bot', ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18)`,
  )
    .bind(
      id,
      g.color === "white" ? u.id : null,
      g.color === "black" ? u.id : null,
      g.color === "white" ? u.username : botName,
      g.color === "black" ? u.username : botName,
      perfOf(g),
      g.base,
      g.inc,
      g.level,
      g.status,
      g.winner,
      g.moves.join(" "),
      sans.join(" "),
      g.clocks.slice(0, g.moves.length).join(","),
      chess.fen(),
      g.moves.length,
      Math.min(Math.max(g.startedAt, now - 3600_000), now),
      now,
    )
    .run();
  return c.json({ id });
});

app.get("/api/recent", async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT id, white_id, black_id, white_name, black_name, white_rating, black_rating, white_diff, black_diff, rated, perf, base, inc, source, bot_level, status, winner, final_fen, ply, started_at, ended_at
     FROM games WHERE source != 'bot' ORDER BY ended_at DESC LIMIT 12`,
  ).all<GameRow>();
  c.header("Cache-Control", "public, max-age=10");
  return c.json({ games: results.map(summarizeGame) });
});

// ---------------------------------------------------------------- people

interface UserRow {
  id: string;
  username: string;
  created_at: number;
}

async function findUser(env: Env, username: string): Promise<UserRow | null> {
  if (!/^[A-Za-z0-9_-]{3,20}$/.test(username)) return null;
  return env.DB.prepare(`SELECT id, COALESCE(display_username, username) AS username, created_at FROM user WHERE username = ?1 AND email_verified = 1`)
    .bind(username.toLowerCase())
    .first<UserRow>();
}

app.get("/api/users/:username", async (c) => {
  const u = await findUser(c.env, c.req.param("username"));
  if (!u) return c.json({ error: "No such player." }, 404);
  const [ratings, totals] = await c.env.DB.batch([
    c.env.DB.prepare(`SELECT perf, rating, rd, games, wins, losses, draws, best, last_played_at FROM ratings WHERE user_id = ?1`).bind(u.id),
    c.env.DB.prepare(
      `SELECT COUNT(*) AS games,
              SUM(CASE WHEN winner IS NOT NULL AND ((winner = 'white' AND white_id = ?1) OR (winner = 'black' AND black_id = ?1)) THEN 1 ELSE 0 END) AS wins,
              SUM(CASE WHEN winner IS NOT NULL AND NOT ((winner = 'white' AND white_id = ?1) OR (winner = 'black' AND black_id = ?1)) THEN 1 ELSE 0 END) AS losses,
              SUM(CASE WHEN winner IS NULL THEN 1 ELSE 0 END) AS draws,
              SUM(CASE WHEN source = 'bot' THEN 1 ELSE 0 END) AS bot
       FROM (SELECT winner, white_id, black_id, source FROM games WHERE white_id = ?1 UNION ALL SELECT winner, white_id, black_id, source FROM games WHERE black_id = ?1 AND (white_id IS NULL OR white_id != ?1))`,
    ).bind(u.id),
  ]);
  type R = { perf: string; rating: number; rd: number; games: number; wins: number; losses: number; draws: number; best: number | null; last_played_at: number | null };
  return c.json({
    user: { id: u.id, username: u.username, createdAt: u.created_at },
    ratings: Object.fromEntries(
      (ratings!.results as R[]).map((r) => [
        r.perf,
        { rating: Math.round(r.rating), rd: Math.round(r.rd), provisional: isProvisional(r), games: r.games, wins: r.wins, losses: r.losses, draws: r.draws, best: r.best ? Math.round(r.best) : null, lastPlayedAt: r.last_played_at },
      ]),
    ),
    totals: totals!.results[0] ?? { games: 0, wins: 0, losses: 0, draws: 0, bot: 0 },
  });
});

app.get("/api/users/:username/games", async (c) => {
  const u = await findUser(c.env, c.req.param("username"));
  if (!u) return c.json({ error: "No such player." }, 404);
  const before = Number(c.req.query("before")) || Number.MAX_SAFE_INTEGER;
  const limit = Math.min(50, Math.max(1, Number(c.req.query("limit")) || 20));
  const cols = `id, white_id, black_id, white_name, black_name, white_rating, black_rating, white_diff, black_diff, rated, perf, base, inc, source, bot_level, status, winner, final_fen, ply, started_at, ended_at`;
  const { results } = await c.env.DB.prepare(
    `SELECT * FROM (
       SELECT ${cols} FROM games WHERE white_id = ?1 AND ended_at < ?2
       UNION
       SELECT ${cols} FROM games WHERE black_id = ?1 AND ended_at < ?2
     ) ORDER BY ended_at DESC LIMIT ?3`,
  )
    .bind(u.id, before, limit)
    .all<GameRow>();
  return c.json({ games: results.map(summarizeGame), next: results.length === limit ? results[results.length - 1]!.ended_at : null });
});

app.get("/api/users/:username/history", async (c) => {
  const u = await findUser(c.env, c.req.param("username"));
  if (!u) return c.json({ error: "No such player." }, 404);
  const perf = c.req.query("perf") ?? "bullet";
  if (!(PERFS as readonly string[]).includes(perf)) return c.json({ error: "Unknown perf." }, 400);
  const { results } = await c.env.DB.prepare(`SELECT rating, at FROM (SELECT rating, at FROM rating_history WHERE user_id = ?1 AND perf = ?2 ORDER BY at DESC LIMIT 500) ORDER BY at ASC`)
    .bind(u.id, perf)
    .all<{ rating: number; at: number }>();
  return c.json({ points: results.map((r) => [r.at, Math.round(r.rating)]) });
});

app.get("/api/leaderboard", async (c) => {
  const perf = c.req.query("perf") ?? "bullet";
  if (!(PERFS as readonly string[]).includes(perf)) return c.json({ error: "Unknown perf." }, 400);
  const { results } = await c.env.DB.prepare(
    `SELECT COALESCE(u.display_username, u.username) AS username, r.rating, r.rd, r.games, r.wins, r.losses, r.draws
     FROM ratings r JOIN user u ON u.id = r.user_id
     WHERE r.perf = ?1 AND r.games > 0 AND r.last_played_at > ?2
     ORDER BY (r.rd <= 110) DESC, r.rating DESC LIMIT 100`,
  )
    .bind(perf, Date.now() - 90 * 86_400_000)
    .all<{ username: string; rating: number; rd: number; games: number; wins: number; losses: number; draws: number }>();
  c.header("Cache-Control", "public, max-age=30");
  return c.json({ players: results.map((r) => ({ ...r, rating: Math.round(r.rating), rd: Math.round(r.rd), provisional: isProvisional(r) })) });
});

// ---------------------------------------------------------------- dev only

app.get("/api/dev/mailbox", (c) => {
  if (c.env.ENVIRONMENT !== "development" || c.env.EMAIL_PROVIDER !== "log") return c.json({ error: "Not found" }, 404);
  return c.json({ messages: devMailbox.slice(-20) });
});

app.all("/api/*", (c) => c.json({ error: "Not found" }, 404));

app.onError((err, c) => {
  console.error(err);
  return c.json({ error: "Something went wrong." }, 500);
});

export default {
  fetch(req, env, ctx) {
    const url = new URL(req.url);
    const canonical = new URL(env.APP_ORIGIN);
    if (url.hostname === `www.${canonical.hostname}`) {
      url.hostname = canonical.hostname;
      return Response.redirect(url.toString(), 301);
    }
    if (url.pathname.startsWith("/api/")) return app.fetch(req, env, ctx);
    return env.ASSETS.fetch(req);
  },
} satisfies ExportedHandler<Env>;
