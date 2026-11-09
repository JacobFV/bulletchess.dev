/**
 * Challenges: on-demand or scheduled, to a specific player or open to anyone. Stored in D1.
 * State changes are single conditional UPDATEs (… WHERE status = 'pending'), so two people
 * accepting the same open challenge cannot both win.
 *
 *   pending ──accept──▶ started            (on demand: game created immediately)
 *   pending ──accept──▶ accepted ──time──▶ started   (scheduled: Lobby alarm starts it)
 *   pending ──▶ declined | cancelled | expired;  accepted ──▶ cancelled (either player withdraws)
 */
import { isProvisional } from "../shared/glicko";
import type { ChallengeUser, ChallengeView } from "../shared/protocol";
import { perfOf, tcLabel } from "../shared/tc";
import { emailHtml, sendEmail } from "./email";
import type { Env } from "./env";

export interface ChallengeRow {
  id: string;
  from_id: string;
  to_id: string | null;
  accepted_by: string | null;
  base: number;
  inc: number;
  rated: number;
  color: "white" | "black" | "random";
  status: ChallengeView["status"];
  scheduled_at: number | null;
  expires_at: number;
  game_id: string | null;
  reminded: number;
  created_at: number;
  updated_at: number;
}

const lobby = (env: Env) => env.LOBBY.get(env.LOBBY.idFromName("global"));

export async function getRow(db: D1Database, id: string): Promise<ChallengeRow | null> {
  return db.prepare(`SELECT * FROM challenges WHERE id = ?1`).bind(id).first<ChallengeRow>();
}

/** Expands rows into views with usernames and current ratings for the challenge's perf. */
export async function toViews(db: D1Database, rows: ChallengeRow[]): Promise<ChallengeView[]> {
  if (rows.length === 0) return [];
  const ids = [...new Set(rows.flatMap((r) => [r.from_id, r.to_id, r.accepted_by]).filter((x): x is string => !!x))];
  const { results: users } = await db
    .prepare(`SELECT id, COALESCE(display_username, username) AS username FROM user WHERE id IN (${ids.map((_, i) => `?${i + 1}`).join(",")})`)
    .bind(...ids)
    .all<{ id: string; username: string }>();
  const names = new Map(users.map((u) => [u.id, u.username]));
  const { results: ratings } = await db
    .prepare(`SELECT user_id, perf, rating, rd FROM ratings WHERE user_id IN (${ids.map((_, i) => `?${i + 1}`).join(",")})`)
    .bind(...ids)
    .all<{ user_id: string; perf: string; rating: number; rd: number }>();
  const rmap = new Map(ratings.map((r) => [`${r.user_id}:${r.perf}`, r]));
  const user = (id: string | null, perf: string): ChallengeUser | null => {
    if (!id) return null;
    const r = rmap.get(`${id}:${perf}`);
    return { id, username: names.get(id) ?? "(deleted)", rating: Math.round(r?.rating ?? 1500), provisional: r ? isProvisional(r) : true };
  };
  return rows.map((r) => {
    const perf = perfOf(r);
    return {
      id: r.id,
      from: user(r.from_id, perf)!,
      to: user(r.to_id, perf),
      acceptedBy: user(r.accepted_by, perf),
      base: r.base,
      inc: r.inc,
      rated: !!r.rated,
      color: r.color,
      status: r.status,
      scheduledAt: r.scheduled_at,
      expiresAt: r.expires_at,
      gameId: r.game_id,
      createdAt: r.created_at,
    };
  });
}

/** Everyone a challenge concerns (for notifications). */
export function parties(r: ChallengeRow): string[] {
  return [r.from_id, r.to_id, r.accepted_by].filter((x): x is string => !!x);
}

export async function acceptsChallenges(db: D1Database, userId: string): Promise<boolean> {
  const p = await db.prepare(`SELECT challenges FROM user_prefs WHERE user_id = ?1`).bind(userId).first<{ challenges: string }>();
  return (p?.challenges ?? "everyone") === "everyone";
}

/**
 * Creates the game for an accepted challenge and marks it started. Used both for on-demand
 * accepts (from the Worker) and for scheduled starts (from the Lobby alarm). The caller must
 * already hold the row (status moved to 'started' by a conditional UPDATE).
 */
export async function launchGame(env: Env, r: ChallengeRow, opponentId: string, createGame: (o: { whiteId: string; blackId: string; base: number; inc: number; rated: boolean; source: "direct" | "open" | "scheduled" }) => Promise<string>): Promise<string> {
  const creatorWhite = r.color === "white" ? true : r.color === "black" ? false : Math.random() < 0.5;
  const source = r.scheduled_at ? "scheduled" : r.to_id ? "direct" : "open";
  const gameId = await createGame({
    whiteId: creatorWhite ? r.from_id : opponentId,
    blackId: creatorWhite ? opponentId : r.from_id,
    base: r.base,
    inc: r.inc,
    rated: !!r.rated,
    source,
  });
  await env.DB.prepare(`UPDATE challenges SET game_id = ?2, updated_at = ?3 WHERE id = ?1`).bind(r.id, gameId, Date.now()).run();
  return gameId;
}

// ------------------------------------------------------------------ email

async function emailOf(db: D1Database, userId: string): Promise<{ email: string; username: string } | null> {
  return db.prepare(`SELECT email, COALESCE(display_username, username) AS username FROM user WHERE id = ?1 AND email_verified = 1`).bind(userId).first();
}

function when(ts: number): string {
  return `${new Date(ts).toUTCString().replace(" GMT", " UTC")}`;
}

/** Best-effort: email failures never break the challenge flow. */
async function mail(env: Env, userId: string, subject: string, heading: string, body: string, cta: { label: string; path: string }) {
  try {
    const to = await emailOf(env.DB, userId);
    if (!to) return;
    const url = `${env.APP_ORIGIN}${cta.path}`;
    await sendEmail(env, {
      to: to.email,
      subject,
      text: `${heading}\n\n${body}\n\n${url}\n\nYou can turn off challenges in your settings: ${env.APP_ORIGIN}/settings`,
      html: emailHtml(heading, body, { label: cta.label, url }, "You can turn off challenges in your settings."),
    });
  } catch (e) {
    console.error("challenge email failed", String(e).slice(0, 120));
  }
}

export async function emailScheduledInvite(env: Env, r: ChallengeRow, fromName: string) {
  if (!r.to_id || !r.scheduled_at) return;
  await mail(
    env,
    r.to_id,
    `${fromName} challenged you: ${tcLabel(r)} on ${when(r.scheduled_at)}`,
    `${fromName} wants to play you`,
    `${r.rated ? "Rated" : "Casual"} ${tcLabel(r)} game, scheduled for ${when(r.scheduled_at)} (shown in your local time on the site). Accept or decline from your challenges page.`,
    { label: "See the challenge", path: "/challenges" },
  );
}

export async function emailReminder(env: Env, r: ChallengeRow, userId: string, opponentName: string) {
  await mail(
    env,
    userId,
    `Your game against ${opponentName} starts in 10 minutes`,
    `Game in 10 minutes`,
    `Your ${r.rated ? "rated" : "casual"} ${tcLabel(r)} game against ${opponentName} starts at ${when(r.scheduled_at!)}. Keep bulletchess.dev open in a tab and the game will open by itself.`,
    { label: "Open bulletchess", path: "/challenges" },
  );
}

export async function emailStarted(env: Env, userId: string, gameId: string, opponentName: string) {
  await mail(env, userId, `Your game against ${opponentName} has started`, "Your game has started", `Your scheduled game against ${opponentName} is waiting. You have three minutes to make your first move before it is aborted.`, {
    label: "Join the game",
    path: `/game/${gameId}`,
  });
}

// ------------------------------------------------------------------ maintenance (cron, every minute)

export async function maintain(env: Env, now = Date.now()) {
  const db = env.DB;
  // 1. Expire pending challenges whose time ran out; tell the people involved.
  const { results: expired } = await db.prepare(`UPDATE challenges SET status = 'expired', updated_at = ?1 WHERE status = 'pending' AND expires_at <= ?1 RETURNING *`).bind(now).all<ChallengeRow>();
  if (expired.length) await lobby(env).notify([...new Set(expired.flatMap(parties))], { t: "challenges" });

  // 2. Reminders 10 minutes before scheduled games.
  const { results: soon } = await db
    .prepare(`UPDATE challenges SET reminded = 1, updated_at = ?1 WHERE status = 'accepted' AND reminded = 0 AND scheduled_at <= ?2 AND scheduled_at > ?1 RETURNING *`)
    .bind(now, now + 10 * 60_000)
    .all<ChallengeRow>();
  for (const r of soon) {
    const opp = r.to_id ?? r.accepted_by;
    if (!opp) continue;
    const [a, b] = await Promise.all([emailOf(db, r.from_id), emailOf(db, opp)]);
    await Promise.all([emailReminder(env, r, r.from_id, b?.username ?? "your opponent"), emailReminder(env, r, opp, a?.username ?? "your opponent")]);
  }

  // 3. Make sure the Lobby holds an alarm for every accepted game in the next hour, and start any overdue ones.
  const { results: upcoming } = await db.prepare(`SELECT id, scheduled_at FROM challenges WHERE status = 'accepted' AND scheduled_at <= ?1`).bind(now + 3600_000).all<{ id: string; scheduled_at: number }>();
  for (const r of upcoming) await lobby(env).scheduleStart(r.id, r.scheduled_at);

  // 4. Purge old finished challenge rows (keep 30 days).
  await db.prepare(`DELETE FROM challenges WHERE status IN ('declined','cancelled','expired','started') AND updated_at < ?1`).bind(now - 30 * 86_400_000).run();
}
