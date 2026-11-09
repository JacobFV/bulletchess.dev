import type { CoreState } from "../shared/core";
import { buildPgn } from "../shared/core";
import { DEFAULT_RATING, inflateRd, isProvisional, updateRating, type Rating } from "../shared/glicko";
import type { Color, PlayerInfo } from "../shared/protocol";
import type { Perf } from "../shared/tc";

interface RatingRow {
  rating: number;
  rd: number;
  vol: number;
  games: number;
  last_played_at: number | null;
}

export async function loadRating(db: D1Database, userId: string, perf: Perf, now: number): Promise<Rating & { lastPlayedAt: number | null }> {
  const row = await db.prepare(`SELECT rating, rd, vol, games, last_played_at FROM ratings WHERE user_id = ?1 AND perf = ?2`).bind(userId, perf).first<RatingRow>();
  if (!row) return { ...DEFAULT_RATING, lastPlayedAt: null };
  const r = inflateRd({ rating: row.rating, rd: row.rd, vol: row.vol }, row.last_played_at, now);
  return { ...r, lastPlayedAt: row.last_played_at };
}

export async function playerInfo(db: D1Database, userId: string, perf: Perf, now: number): Promise<PlayerInfo | null> {
  const u = await db.prepare(`SELECT id, COALESCE(display_username, username, name) AS username FROM user WHERE id = ?1`).bind(userId).first<{ id: string; username: string }>();
  if (!u) return null;
  const r = await loadRating(db, userId, perf, now);
  return { id: u.id, username: u.username, rating: Math.round(r.rating), provisional: isProvisional(r) };
}

/**
 * Persist a finished game and (for rated games) apply Glicko-2 to both players.
 * Must be called serially (the Lobby DO does this behind a mutex) so concurrent results
 * for the same player cannot lose an update. Idempotent per game id.
 */
export async function recordResult(db: D1Database, s: CoreState, fen: string, countsForRating: boolean, now: number): Promise<{ white?: number; black?: number }> {
  const existing = await db.prepare(`SELECT white_diff, black_diff FROM games WHERE id = ?1`).bind(s.id).first<{ white_diff: number | null; black_diff: number | null }>();
  if (existing) return { white: existing.white_diff ?? undefined, black: existing.black_diff ?? undefined };
  if (!s.white || !s.black) throw new Error("recordResult: game has no players");

  const stmts: D1PreparedStatement[] = [];
  const diffs: { white?: number; black?: number } = {};
  const endedAt = s.endedAt ?? now;
  if (countsForRating) {
    const w = await loadRating(db, s.white.id, s.perf, endedAt);
    const b = await loadRating(db, s.black.id, s.perf, endedAt);
    const scoreW = s.winner === "white" ? 1 : s.winner === "black" ? 0 : 0.5;
    const nw = updateRating(w, b, scoreW);
    const nb = updateRating(b, w, 1 - scoreW);
    diffs.white = Math.round(nw.rating) - Math.round(w.rating);
    diffs.black = Math.round(nb.rating) - Math.round(b.rating);
    for (const [color, id, r, score] of [
      ["white", s.white.id, nw, scoreW],
      ["black", s.black.id, nb, 1 - scoreW],
    ] as [Color, string, Rating, number][]) {
      void color;
      stmts.push(
        db
          .prepare(
            `INSERT INTO ratings (user_id, perf, rating, rd, vol, games, wins, losses, draws, best, last_played_at)
             VALUES (?1, ?2, ?3, ?4, ?5, 1, ?6, ?7, ?8, ?3, ?9)
             ON CONFLICT(user_id, perf) DO UPDATE SET rating = ?3, rd = ?4, vol = ?5, games = games + 1,
               wins = wins + ?6, losses = losses + ?7, draws = draws + ?8, best = MAX(COALESCE(best, 0), ?3), last_played_at = ?9`,
          )
          .bind(id, s.perf, r.rating, r.rd, r.vol, score === 1 ? 1 : 0, score === 0 ? 1 : 0, score === 0.5 ? 1 : 0, endedAt),
        db.prepare(`INSERT INTO rating_history (user_id, perf, game_id, rating, at) VALUES (?1, ?2, ?3, ?4, ?5)`).bind(id, s.perf, s.id, r.rating, endedAt),
      );
    }
  }
  stmts.unshift(
    db
      .prepare(
        `INSERT INTO games (id, white_id, black_id, white_name, black_name, white_rating, black_rating, white_diff, black_diff, rated, perf, base, inc, source, bot_level, status, winner, moves, sans, clocks, final_fen, ply, started_at, ended_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, NULL, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23)`,
      )
      .bind(
        s.id,
        s.white.id,
        s.black.id,
        s.white.username,
        s.black.username,
        s.white.rating,
        s.black.rating,
        diffs.white ?? null,
        diffs.black ?? null,
        s.rated ? 1 : 0,
        s.perf,
        s.base,
        s.inc,
        s.source,
        s.status,
        s.winner,
        s.moves.join(" "),
        s.sans.join(" "),
        s.moveClocks.join(","),
        fen,
        s.moves.length,
        s.startedAt ?? s.createdAt,
        endedAt,
      ),
  );
  await db.batch(stmts);
  return diffs;
}

export interface GameRow {
  id: string;
  white_id: string | null;
  black_id: string | null;
  white_name: string;
  black_name: string;
  white_rating: number | null;
  black_rating: number | null;
  white_diff: number | null;
  black_diff: number | null;
  rated: number;
  perf: Perf;
  base: number;
  inc: number;
  source: string;
  bot_level: number | null;
  status: CoreState["status"];
  winner: Color | null;
  moves: string;
  sans: string;
  clocks: string;
  final_fen: string;
  ply: number;
  started_at: number;
  ended_at: number;
}

export function serializeGame(r: GameRow, site: string) {
  const sans = r.sans ? r.sans.split(" ") : [];
  const moveClocks = r.clocks ? r.clocks.split(",").map(Number) : [];
  return {
    id: r.id,
    white: { id: r.white_id, username: r.white_name, rating: r.white_rating, ratingDiff: r.white_diff },
    black: { id: r.black_id, username: r.black_name, rating: r.black_rating, ratingDiff: r.black_diff },
    rated: !!r.rated,
    perf: r.perf,
    base: r.base,
    inc: r.inc,
    source: r.source,
    botLevel: r.bot_level,
    status: r.status,
    winner: r.winner,
    moves: r.moves ? r.moves.split(" ") : [],
    sans,
    moveClocks,
    fen: r.final_fen,
    ply: r.ply,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    pgn: buildPgn({
      id: r.id,
      site,
      white: r.white_name,
      black: r.black_name,
      whiteElo: r.white_rating,
      blackElo: r.black_rating,
      rated: !!r.rated,
      base: r.base,
      inc: r.inc,
      status: r.status,
      winner: r.winner,
      sans,
      moveClocks,
      startedAt: r.started_at,
    }),
  };
}

/** Compact summary for lists (no moves). */
export function summarizeGame(r: Omit<GameRow, "moves" | "sans" | "clocks">) {
  return {
    id: r.id,
    white: { id: r.white_id, username: r.white_name, rating: r.white_rating, ratingDiff: r.white_diff },
    black: { id: r.black_id, username: r.black_name, rating: r.black_rating, ratingDiff: r.black_diff },
    rated: !!r.rated,
    perf: r.perf,
    base: r.base,
    inc: r.inc,
    botLevel: r.bot_level,
    status: r.status,
    winner: r.winner,
    fen: r.final_fen,
    ply: r.ply,
    endedAt: r.ended_at,
  };
}
