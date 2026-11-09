/**
 * Lobby: a single Durable Object that runs matchmaking, tracks live games and serialises
 * rating updates (so two results for one player can never race).
 * Seeks live on WebSocket attachments, so they survive hibernation.
 */
import { DurableObject } from "cloudflare:workers";
import type { CoreState } from "../shared/core";
import type { ClientLobbyMsg, LiveGame, ServerLobbyMsg } from "../shared/protocol";
import { perfOf, poolById, POOLS, type PoolId } from "../shared/tc";
import { loadRating, playerInfo, recordResult } from "./db";
import type { Env } from "./env";
import { randomId } from "./ids";

interface Seek {
  pool: PoolId;
  since: number;
  rating: number;
  rd: number;
}
interface Attachment {
  uid: string | null;
  username: string | null;
  seek: Seek | null;
}
type Seeker = { ws: WebSocket; att: Attachment & { seek: Seek } };
export type { LiveGame };

const ACTIVE_TTL = 30 * 60_000;

export class Lobby extends DurableObject<Env> {
  private chain: Promise<unknown> = Promise.resolve();
  private lastStats = "";

  async fetch(req: Request): Promise<Response> {
    if (req.headers.get("Upgrade") !== "websocket") return new Response("expected websocket", { status: 426 });
    const uid = req.headers.get("x-uid") || null;
    const username = req.headers.get("x-username") || null;
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    this.ctx.acceptWebSocket(server, uid ? [`u:${uid}`] : []);
    server.serializeAttachment({ uid, username, seek: null } satisfies Attachment);
    server.send(JSON.stringify({ t: "hello", ...this.stats() } satisfies ServerLobbyMsg));
    await this.ensureAlarm(5000);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    if (typeof raw !== "string" || raw.length > 512) return;
    let m: ClientLobbyMsg;
    try {
      m = JSON.parse(raw);
    } catch {
      return;
    }
    const att = ws.deserializeAttachment() as Attachment;
    if (m.t === "ping") return send(ws, { t: "pong" });
    if (m.t === "cancel") {
      ws.serializeAttachment({ ...att, seek: null });
      send(ws, { t: "cancelled" });
      return;
    }
    if (m.t === "seek") {
      if (!att.uid) return send(ws, { t: "error", message: "Sign in to play rated games." });
      const pool = poolById(m.pool);
      if (!pool) return send(ws, { t: "error", message: "Unknown time control." });
      const current = await this.currentGame(att.uid);
      if (current) return send(ws, { t: "start", id: current });
      const now = Date.now();
      const r = await loadRating(this.env.DB, att.uid, perfOf(pool), now);
      // One seek per player: a new seek from another tab replaces the old one.
      for (const other of this.ctx.getWebSockets(`u:${att.uid}`)) {
        if (other === ws) continue;
        const oa = other.deserializeAttachment() as Attachment;
        if (oa.seek) {
          other.serializeAttachment({ ...oa, seek: null });
          send(other, { t: "cancelled" });
        }
      }
      const seek: Seek = { pool: pool.id, since: now, rating: r.rating, rd: r.rd };
      ws.serializeAttachment({ ...att, seek });
      send(ws, { t: "seeking", pool: pool.id, since: now });
      await this.pair();
      await this.ensureAlarm(1000);
    }
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    ws.serializeAttachment({ ...(ws.deserializeAttachment() as Attachment), seek: null });
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.webSocketClose(ws);
  }

  async alarm(): Promise<void> {
    await this.pair();
    const s = JSON.stringify(this.stats());
    if (s !== this.lastStats) {
      this.lastStats = s;
      const msg = JSON.stringify({ t: "stats", ...this.stats() } satisfies ServerLobbyMsg);
      for (const ws of this.ctx.getWebSockets()) trySend(ws, msg);
    }
    this.sweepActive();
    const seeking = this.seekers().length > 0;
    const sockets = this.ctx.getWebSockets().length > 0;
    if (seeking) await this.ctx.storage.setAlarm(Date.now() + 1000);
    else if (sockets) await this.ctx.storage.setAlarm(Date.now() + 4000);
  }

  private async ensureAlarm(inMs: number) {
    const cur = await this.ctx.storage.getAlarm();
    const at = Date.now() + inMs;
    if (cur === null || cur > at) await this.ctx.storage.setAlarm(at);
  }

  private seekers(): Seeker[] {
    const out: Seeker[] = [];
    for (const ws of this.ctx.getWebSockets()) {
      const att = ws.deserializeAttachment() as Attachment | null;
      if (att?.seek && att.uid) out.push({ ws, att: att as Attachment & { seek: Seek } });
    }
    return out;
  }

  private stats(): { players: number; games: number; pools: Record<string, number> } {
    const uids = new Set<string>();
    let anon = 0;
    const pools: Record<string, number> = Object.fromEntries(POOLS.map((p) => [p.id, 0]));
    for (const ws of this.ctx.getWebSockets()) {
      const a = ws.deserializeAttachment() as Attachment | null;
      if (a?.uid) uids.add(a.uid);
      else anon++;
      if (a?.seek) pools[a.seek.pool] = (pools[a.seek.pool] ?? 0) + 1;
    }
    let games = 0;
    for (const _ of this.ctx.storage.kv.list({ prefix: "g:" })) games++;
    return { players: uids.size + anon, games, pools };
  }

  /** Rating-window matchmaking. The window widens the longer both players wait. */
  private async pair(): Promise<void> {
    const now = Date.now();
    const byPool = new Map<string, Seeker[]>();
    for (const s of this.seekers()) {
      const l = byPool.get(s.att.seek.pool) ?? [];
      l.push(s);
      byPool.set(s.att.seek.pool, l);
    }
    const pairs: [Seeker, Seeker][] = [];
    for (const list of byPool.values()) {
      list.sort((a, b) => a.att.seek.since - b.att.seek.since);
      const used = new Set<number>();
      for (let i = 0; i < list.length; i++) {
        if (used.has(i)) continue;
        const a = list[i]!;
        let best = -1;
        let bestDiff = Infinity;
        for (let j = i + 1; j < list.length; j++) {
          if (used.has(j)) continue;
          const b = list[j]!;
          if (b.att.uid === a.att.uid) continue;
          const diff = Math.abs(a.att.seek.rating - b.att.seek.rating);
          if (diff <= window(a.att.seek, now) && diff <= window(b.att.seek, now) && diff < bestDiff) {
            best = j;
            bestDiff = diff;
          }
        }
        if (best >= 0) {
          used.add(i).add(best);
          pairs.push([a, list[best]!]);
        }
      }
    }
    // Clear seeks synchronously before any await so a concurrent pass cannot pair them again.
    for (const [a, b] of pairs) {
      a.ws.serializeAttachment({ ...a.att, seek: null });
      b.ws.serializeAttachment({ ...b.att, seek: null });
    }
    await Promise.all(
      pairs.map(async ([a, b]) => {
        const pool = poolById(a.att.seek.pool)!;
        const [white, black] = Math.random() < 0.5 ? [a, b] : [b, a];
        try {
          const id = await this.createGame({ whiteId: white.att.uid!, blackId: black.att.uid!, base: pool.base, inc: pool.inc, rated: true, source: "pool" });
          for (const p of [a, b]) for (const ws of this.ctx.getWebSockets(`u:${p.att.uid}`)) send(ws, { t: "start", id });
        } catch (e) {
          console.error("pairing failed", e);
          for (const p of [a, b]) send(p.ws, { t: "error", message: "Could not start the game. Please seek again." });
        }
      }),
    );
  }

  /** Creates a game Durable Object for two known users. Also used for rematches. */
  async createGame(o: { whiteId: string; blackId: string; base: number; inc: number; rated: boolean; source: CoreState["source"] }): Promise<string> {
    const now = Date.now();
    const perf = perfOf(o);
    const [white, black] = await Promise.all([playerInfo(this.env.DB, o.whiteId, perf, now), playerInfo(this.env.DB, o.blackId, perf, now)]);
    if (!white || !black) throw new Error("player not found");
    const id = randomId(8);
    await this.env.GAME.get(this.env.GAME.idFromName(id)).create({ id, base: o.base, inc: o.inc, rated: o.rated, source: o.source, white, black });
    this.markActive({ id, white, black, base: o.base, inc: o.inc, rated: o.rated, startedAt: now });
    return id;
  }

  markActive(g: LiveGame): void {
    this.ctx.storage.kv.put(`g:${g.id}`, g);
    this.ctx.storage.kv.put(`u:${g.white.id}`, g.id);
    this.ctx.storage.kv.put(`u:${g.black.id}`, g.id);
  }

  gameEnded(id: string): void {
    const g = this.ctx.storage.kv.get<LiveGame>(`g:${id}`);
    if (!g) return;
    this.ctx.storage.kv.delete(`g:${id}`);
    for (const uid of [g.white.id, g.black.id]) if (this.ctx.storage.kv.get(`u:${uid}`) === id) this.ctx.storage.kv.delete(`u:${uid}`);
  }

  /** The user's in-progress game, verified against the game itself. */
  private async currentGame(uid: string): Promise<string | null> {
    const id = this.ctx.storage.kv.get<string>(`u:${uid}`);
    if (!id) return null;
    const v = await this.env.GAME.get(this.env.GAME.idFromName(id)).view(null);
    if (v && v.status === "started") return id;
    this.gameEnded(id);
    if (this.ctx.storage.kv.get(`u:${uid}`) === id) this.ctx.storage.kv.delete(`u:${uid}`);
    return null;
  }

  private sweepActive() {
    const now = Date.now();
    for (const [k, g] of this.ctx.storage.kv.list<LiveGame>({ prefix: "g:" })) {
      // Bullet games cannot outlive this; anything older is a lost notification.
      if (now - g.startedAt > ACTIVE_TTL) this.gameEnded(k.slice(2));
    }
  }

  liveGames(limit = 12): LiveGame[] {
    const all = [...this.ctx.storage.kv.list<LiveGame>({ prefix: "g:" })].map(([, g]) => g);
    all.sort((a, b) => b.white.rating + b.black.rating - (a.white.rating + a.black.rating));
    return all.slice(0, limit);
  }

  onlineStats() {
    return this.stats();
  }

  /** Serialised: persist a finished game and update both ratings. */
  recordResult(s: CoreState, fen: string, countsForRating: boolean): Promise<{ white?: number; black?: number }> {
    const run = this.chain.then(() => recordResult(this.env.DB, s, fen, countsForRating, Date.now()));
    this.chain = run.catch(() => undefined);
    return run.finally(() => this.gameEnded(s.id));
  }
}

function window(s: Seek, now: number): number {
  const waited = (now - s.since) / 1000;
  if (waited > 12) return Infinity;
  return 100 + 60 * waited + Math.max(0, s.rd - 100) / 2;
}

function send(ws: WebSocket, m: ServerLobbyMsg) {
  trySend(ws, JSON.stringify(m));
}
function trySend(ws: WebSocket, m: string) {
  try {
    ws.send(m);
  } catch {
    /* closed */
  }
}
