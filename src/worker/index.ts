import { Chess } from "chess.js";
import { Hono, type Context } from "hono";
import { z } from "zod";
import { uciToMove } from "../shared/core";
import { isProvisional } from "../shared/glicko";
import { DIRECT_CHALLENGE_TTL_MS, isValidTimeControl, OPEN_CHALLENGE_TTL_MS, perfOf, PERFS, SCHEDULE_MAX_LEAD_MS, SCHEDULE_MIN_LEAD_MS } from "../shared/tc";
import { createAuth, getSessionUser, type SessionUser } from "./auth";
import { acceptsChallenges, emailScheduledInvite, getRow, launchGame, maintain, parties, toViews, type ChallengeRow } from "./challenges";
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
  /** link: shareable waiting room (default) · open: listed for anyone · direct: to one player */
  mode: z.enum(["link", "open", "direct"]).default("link"),
  to: z.string().max(40).optional(),
  scheduledAt: z.number().int().nullable().optional(),
});

app.post("/api/challenges", async (c) => {
  const u = await user(c);
  if (!u) return c.json({ error: "Sign in to create a challenge." }, 401);
  const parsed = challengeSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success || !isValidTimeControl(parsed.data)) return c.json({ error: "Invalid challenge." }, 400);
  const { base, inc, rated, color, mode } = parsed.data;
  if (mode !== "link") return createListedChallenge(c, u, parsed.data);
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

async function createListedChallenge(c: Context<AppEnv>, u: SessionUser, d: z.infer<typeof challengeSchema>) {
  const now = Date.now();
  const db = c.env.DB;
  let toId: string | null = null;
  if (d.mode === "direct") {
    const target = d.to ? await findUser(c.env, d.to) : null;
    if (!target) return c.json({ error: "No such player." }, 404);
    if (target.id === u.id) return c.json({ error: "You cannot challenge yourself." }, 400);
    if (!(await acceptsChallenges(db, target.id))) return c.json({ error: `${target.username} is not accepting challenges.` }, 403);
    toId = target.id;
  }
  const scheduledAt = d.scheduledAt ?? null;
  // Development-only override so end-to-end tests need not wait two minutes.
  const minLead = c.env.ENVIRONMENT === "development" && c.env.DEV_SCHEDULE_MIN_LEAD_MS ? Number(c.env.DEV_SCHEDULE_MIN_LEAD_MS) : SCHEDULE_MIN_LEAD_MS - 30_000;
  if (scheduledAt !== null && (scheduledAt < now + minLead || scheduledAt > now + SCHEDULE_MAX_LEAD_MS))
    return c.json({ error: "Schedule between 2 minutes and 30 days from now." }, 400);
  const counts = await db
    .prepare(`SELECT SUM(CASE WHEN status IN ('pending','accepted') THEN 1 ELSE 0 END) AS open, SUM(CASE WHEN created_at > ?2 THEN 1 ELSE 0 END) AS recent FROM challenges WHERE from_id = ?1`)
    .bind(u.id, now - 60_000)
    .first<{ open: number | null; recent: number | null }>();
  if ((counts?.open ?? 0) >= 20) return c.json({ error: "You have too many open challenges. Cancel some first." }, 429);
  if ((counts?.recent ?? 0) >= 10) return c.json({ error: "Slow down." }, 429);
  if (toId && scheduledAt === null) {
    // One live on-demand challenge per pair: replace an older one.
    await db.prepare(`UPDATE challenges SET status = 'cancelled', updated_at = ?3 WHERE from_id = ?1 AND to_id = ?2 AND status = 'pending' AND scheduled_at IS NULL`).bind(u.id, toId, now).run();
  }
  const id = randomId(10);
  const expiresAt = scheduledAt ?? now + (toId ? DIRECT_CHALLENGE_TTL_MS : OPEN_CHALLENGE_TTL_MS);
  await db
    .prepare(`INSERT INTO challenges (id, from_id, to_id, base, inc, rated, color, status, scheduled_at, expires_at, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'pending', ?8, ?9, ?10, ?10)`)
    .bind(id, u.id, toId, d.base, d.inc, d.rated ? 1 : 0, d.color, scheduledAt, expiresAt, now)
    .run();
  const row = (await getRow(db, id))!;
  const [view] = await toViews(db, [row]);
  if (toId) {
    await lobby(c.env).notify([toId], { t: "challenge", c: view! });
    if (scheduledAt) c.executionCtx.waitUntil(emailScheduledInvite(c.env, row, u.username));
  }
  return c.json({ challenge: view });
}

app.get("/api/challenges", async (c) => {
  const u = await user(c);
  if (!u) return c.json({ error: "Sign in." }, 401);
  const now = Date.now();
  const { results } = await c.env.DB.prepare(
    `SELECT * FROM challenges WHERE (from_id = ?1 OR to_id = ?1 OR accepted_by = ?1)
       AND (status IN ('pending','accepted') OR (status = 'started' AND updated_at > ?2))
     ORDER BY COALESCE(scheduled_at, created_at) ASC LIMIT 100`,
  )
    .bind(u.id, now - 3600_000)
    .all<ChallengeRow>();
  const views = await toViews(c.env.DB, results.filter((r) => r.status !== "pending" || r.expires_at > now));
  return c.json({
    incoming: views.filter((v) => v.status === "pending" && v.to?.id === u.id),
    outgoing: views.filter((v) => v.status === "pending" && v.from.id === u.id),
    upcoming: views.filter((v) => v.status === "accepted"),
    started: views.filter((v) => v.status === "started"),
  });
});

app.get("/api/challenges/open", async (c) => {
  const now = Date.now();
  const { results } = await c.env.DB.prepare(`SELECT * FROM challenges WHERE status = 'pending' AND to_id IS NULL AND expires_at > ?1 ORDER BY COALESCE(scheduled_at, created_at) ASC LIMIT 50`)
    .bind(now)
    .all<ChallengeRow>();
  return c.json({ challenges: await toViews(c.env.DB, results) });
});

app.post("/api/challenges/:id/accept", async (c) => {
  const u = await user(c);
  if (!u) return c.json({ error: "Sign in to accept challenges." }, 401);
  const id = c.req.param("id");
  const now = Date.now();
  const row = await getRow(c.env.DB, id);
  if (!row || row.status !== "pending" || row.expires_at <= now) return c.json({ error: "This challenge is no longer available." }, 410);
  if (row.from_id === u.id) return c.json({ error: "You cannot accept your own challenge." }, 400);
  if (row.to_id && row.to_id !== u.id) return c.json({ error: "This challenge is for someone else." }, 403);
  const next = row.scheduled_at ? "accepted" : "started";
  const won = await c.env.DB.prepare(`UPDATE challenges SET status = ?2, accepted_by = ?3, updated_at = ?4 WHERE id = ?1 AND status = 'pending' AND expires_at > ?4 RETURNING *`)
    .bind(id, next, u.id, now)
    .first<ChallengeRow>();
  if (!won) return c.json({ error: "Someone else got there first." }, 409);
  const l = lobby(c.env);
  if (won.scheduled_at) {
    await l.scheduleStart(won.id, won.scheduled_at);
    await l.notify(parties(won), { t: "challenges", note: `${u.username} accepted your scheduled game.` });
    return c.json({ scheduledAt: won.scheduled_at });
  }
  try {
    const gameId = await launchGame(c.env, won, u.id, (o) => l.createGame(o));
    await l.notify(parties(won), { t: "start", id: gameId });
    await l.notify(parties(won), { t: "challenges" });
    return c.json({ gameId });
  } catch (e) {
    console.error("accept failed", e);
    await c.env.DB.prepare(`UPDATE challenges SET status = 'cancelled', updated_at = ?2 WHERE id = ?1`).bind(id, Date.now()).run();
    await l.notify(parties(won), { t: "challenges" });
    return c.json({ error: "Could not start the game." }, 500);
  }
});

app.post("/api/challenges/:id/decline", async (c) => {
  const u = await user(c);
  if (!u) return c.json({ error: "Sign in." }, 401);
  const id = c.req.param("id");
  const now = Date.now();
  const row = await getRow(c.env.DB, id);
  if (!row || (row.status !== "pending" && row.status !== "accepted")) return c.json({ error: "This challenge is no longer active." }, 410);
  const l = lobby(c.env);
  if (!row.to_id && row.accepted_by === u.id && row.status === "accepted") {
    // Withdrawing from an open scheduled challenge reopens it for others.
    await c.env.DB.prepare(`UPDATE challenges SET status = 'pending', accepted_by = NULL, reminded = 0, updated_at = ?2 WHERE id = ?1 AND status = 'accepted'`).bind(id, now).run();
    await l.unschedule(id);
    await l.notify(parties(row), { t: "challenges", note: `${u.username} withdrew from your scheduled game.` });
    return c.json({ ok: true });
  }
  if (row.to_id !== u.id) return c.json({ error: "Not your challenge." }, 403);
  await c.env.DB.prepare(`UPDATE challenges SET status = 'declined', updated_at = ?2 WHERE id = ?1 AND status IN ('pending','accepted')`).bind(id, now).run();
  await l.unschedule(id);
  await l.notify(parties(row), { t: "challenges", note: `${u.username} declined your challenge.` });
  return c.json({ ok: true });
});

app.post("/api/challenges/:id/cancel", async (c) => {
  const u = await user(c);
  if (!u) return c.json({ error: "Sign in." }, 401);
  const id = c.req.param("id");
  const row = await getRow(c.env.DB, id);
  if (!row || row.from_id !== u.id) return c.json({ error: "Not your challenge." }, 403);
  if (row.status !== "pending" && row.status !== "accepted") return c.json({ error: "This challenge is no longer active." }, 410);
  await c.env.DB.prepare(`UPDATE challenges SET status = 'cancelled', updated_at = ?2 WHERE id = ?1 AND status IN ('pending','accepted')`).bind(id, Date.now()).run();
  const l = lobby(c.env);
  await l.unschedule(id);
  await l.notify(parties(row), { t: "challenges", note: `${u.username} cancelled a challenge.` });
  return c.json({ ok: true });
});

app.get("/api/players/online", async (c) => {
  const players = await lobby(c.env).onlinePlayers(300);
  return c.json({ players });
});

app.get("/api/me/prefs", async (c) => {
  const u = await user(c);
  if (!u) return c.json({ error: "Sign in." }, 401);
  return c.json({ challenges: (await acceptsChallenges(c.env.DB, u.id)) ? "everyone" : "nobody" });
});

app.post("/api/me/prefs", async (c) => {
  const u = await user(c);
  if (!u) return c.json({ error: "Sign in." }, 401);
  const parsed = z.object({ challenges: z.enum(["everyone", "nobody"]) }).safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "Invalid preferences." }, 400);
  await c.env.DB.prepare(`INSERT INTO user_prefs (user_id, challenges, updated_at) VALUES (?1, ?2, ?3) ON CONFLICT(user_id) DO UPDATE SET challenges = ?2, updated_at = ?3`)
    .bind(u.id, parsed.data.challenges, Date.now())
    .run();
  await lobby(c.env).refreshPresence(u.id);
  return c.json({ ok: true });
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
    user: { id: u.id, username: u.username, createdAt: u.created_at, online: await lobby(c.env).isOnline(u.id), acceptsChallenges: await acceptsChallenges(c.env.DB, u.id) },
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
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(maintain(env));
  },
} satisfies ExportedHandler<Env>;
