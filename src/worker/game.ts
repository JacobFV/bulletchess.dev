/**
 * One Durable Object per game. Authoritative clocks and move validation; WebSocket hibernation
 * so idle spectators cost nothing. On completion the game is written to D1 (via the Lobby, which
 * serialises rating updates) and this object's storage is deleted a while later.
 */
import { DurableObject } from "cloudflare:workers";
import { GameCore, newCore, type CoreState } from "../shared/core";
import type { ClientGameMsg, Color, PlayerInfo, ServerGameMsg } from "../shared/protocol";
import { playerInfo } from "./db";
import type { Env } from "./env";

interface Attachment {
  uid: string | null;
}

const KEEP_AFTER_END_MS = 15 * 60_000;
const RETRY_PERSIST_MS = 5_000;

export interface CreateGame {
  id: string;
  base: number;
  inc: number;
  rated: boolean;
  source: CoreState["source"];
  white?: PlayerInfo | null;
  black?: PlayerInfo | null;
  creatorId?: string;
  creatorColor?: CoreState["creatorColor"];
}

export class GameRoom extends DurableObject<Env> {
  private core: GameCore | null | undefined;

  private load(): GameCore | null {
    if (this.core === undefined) {
      const s = this.ctx.storage.kv.get<CoreState>("state");
      this.core = s ? new GameCore(s) : null;
    }
    return this.core;
  }

  private save() {
    if (this.core) this.ctx.storage.kv.put("state", this.core.s);
  }

  private get persisted(): boolean {
    return this.ctx.storage.kv.get<boolean>("persisted") === true;
  }

  async create(init: CreateGame): Promise<void> {
    if (this.load()) throw new Error("game exists");
    this.core = new GameCore(newCore({ ...init, now: Date.now() }));
    this.save();
    await this.schedule();
  }

  async view(uid: string | null) {
    const core = this.load();
    if (!core) return null;
    const now = Date.now();
    if (core.checkTime(now)) await this.finish();
    return core.view(now, uid ? core.colorOf(uid) : null, this.online(), this.spectators());
  }

  async fetch(req: Request): Promise<Response> {
    const core = this.load();
    if (!core) return new Response("not found", { status: 404 });
    if (req.headers.get("Upgrade") !== "websocket") return new Response("expected websocket", { status: 426 });
    const uid = req.headers.get("x-uid") || null;
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ uid } satisfies Attachment);
    const now = Date.now();
    if (core.checkTime(now)) await this.finish();
    this.sendState(server);
    this.broadcastPresence();
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    if (typeof raw !== "string" || raw.length > 256) return;
    let m: ClientGameMsg;
    try {
      m = JSON.parse(raw);
    } catch {
      return;
    }
    const core = this.load();
    if (!core) return;
    const { uid } = ws.deserializeAttachment() as Attachment;
    const color = uid ? core.colorOf(uid) : null;
    const now = Date.now();

    switch (m.t) {
      case "ping":
        send(ws, { t: "pong", c: m.c, s: now });
        if (color && !core.finished) send(ws, { t: "ping", s: now });
        return;
      case "pong":
        if (color && typeof m.s === "number" && now >= m.s) {
          core.recordLag(color, (now - m.s) / 2);
          this.save();
        }
        return;
      case "join": {
        if (!uid) return send(ws, { t: "error", message: "Sign in to accept this challenge." });
        if (core.s.status !== "waiting") return;
        if (color) return send(ws, { t: "error", message: "You cannot play yourself." });
        const info = await playerInfo(this.env.DB, uid, core.s.perf, now);
        if (!info) return send(ws, { t: "error", message: "Account not found." });
        const err = core.seat(info, now);
        if (err) return send(ws, { t: "error", message: err });
        this.save();
        await this.lobby().markActive({ id: core.s.id, white: core.s.white!, black: core.s.black!, base: core.s.base, inc: core.s.inc, rated: core.s.rated, startedAt: now });
        await this.schedule();
        this.broadcastState();
        this.broadcastPresence();
        return;
      }
      case "move": {
        if (!color) return send(ws, { t: "error", message: "You are not playing in this game." });
        if (typeof m.u !== "string" || typeof m.ply !== "number") return;
        if (m.ply !== core.ply) return this.sendState(ws); // stale premove or duplicate: resync
        const hadOffer = core.s.drawOffer;
        const r = core.move(color, m.u, now);
        if (!r.ok) {
          if (r.ended) return this.finish();
          send(ws, { t: "error", message: r.error });
          return this.sendState(ws);
        }
        this.save();
        const msg: ServerGameMsg = {
          t: "move",
          u: m.u,
          san: r.san,
          ply: core.ply,
          fen: core.fen,
          clocks: core.clocksAt(now),
          serverNow: now,
          running: core.clockRunning,
          firstMoveDeadline: core.firstMoveDeadline(),
        };
        this.broadcast(msg);
        if (r.ended) return this.finish();
        if (hadOffer && !core.s.drawOffer) this.broadcastOffers();
        await this.schedule();
        return;
      }
      case "resign":
      case "abort": {
        if (!color) return;
        const err = m.t === "resign" ? core.resign(color, now) : core.abort(color, now);
        if (err) return send(ws, { t: "error", message: err });
        return this.finish();
      }
      case "draw-offer":
      case "draw-accept": {
        if (!color) return;
        const err = core.offerDraw(color, now);
        if (err) return send(ws, { t: "error", message: err });
        this.save();
        if (core.finished) return this.finish();
        this.broadcastOffers();
        return;
      }
      case "draw-decline":
        if (!color) return;
        core.declineDraw(color);
        this.save();
        this.broadcastOffers();
        return;
      case "rematch-offer": {
        if (!color || !core.finished || core.s.rematchId) return;
        if (core.s.status === "aborted" && core.ply === 0 && core.s.source === "challenge") return;
        const both = core.offerRematch(color);
        this.save();
        if (!both) return this.broadcastOffers();
        try {
          const id = await this.lobby().createGame({
            whiteId: core.s.black!.id,
            blackId: core.s.white!.id,
            base: core.s.base,
            inc: core.s.inc,
            rated: core.s.rated,
            source: "rematch",
          });
          core.s.rematchId = id;
          core.s.rematchOffer = null;
          this.save();
          this.broadcast({ t: "rematch", id });
        } catch (e) {
          console.error("rematch failed", e);
          core.s.rematchOffer = null;
          this.save();
          this.broadcast({ t: "error", message: "Could not start the rematch." });
          this.broadcastOffers();
        }
        return;
      }
      case "rematch-decline":
        if (!color) return;
        core.declineRematch(color);
        this.save();
        this.broadcastOffers();
        return;
    }
  }

  async webSocketClose(): Promise<void> {
    this.broadcastPresence();
  }

  async webSocketError(): Promise<void> {
    this.broadcastPresence();
  }

  async alarm(): Promise<void> {
    const core = this.load();
    if (!core) return;
    const now = Date.now();
    if (!core.finished) {
      if (core.s.status === "waiting" && now >= core.s.createdAt + 24 * 3600_000) core.abort("white", now);
      else core.checkTime(now);
      if (core.finished) return this.finish();
      return this.schedule();
    }
    if (!this.persisted && this.needsPersist(core)) return this.finish();
    if (now >= (core.s.endedAt ?? now) + KEEP_AFTER_END_MS) {
      for (const ws of this.ctx.getWebSockets()) ws.close(1000, "archived");
      await this.ctx.storage.deleteAll();
      this.core = null;
      return;
    }
    return this.schedule();
  }

  private needsPersist(core: GameCore): boolean {
    return core.s.status !== "aborted" && core.s.status !== "noStart" && !!core.s.white && !!core.s.black;
  }

  private async schedule() {
    const core = this.core;
    if (!core) return;
    let at: number | null;
    if (!core.finished) at = core.nextDeadline();
    else if (!this.persisted && this.needsPersist(core)) at = Date.now() + RETRY_PERSIST_MS;
    else at = (core.s.endedAt ?? Date.now()) + KEEP_AFTER_END_MS;
    if (at !== null) await this.ctx.storage.setAlarm(at);
  }

  /** Called whenever the core reaches a finished state. Idempotent. */
  private async finish(): Promise<void> {
    const core = this.core!;
    this.save();
    if (this.needsPersist(core) && !this.persisted) {
      try {
        const diffs = await this.lobby().recordResult(core.s, core.fen, core.countsForRating);
        if (core.s.white && diffs.white !== undefined) core.s.white.ratingDiff = diffs.white;
        if (core.s.black && diffs.black !== undefined) core.s.black.ratingDiff = diffs.black;
        this.ctx.storage.kv.put("persisted", true);
        this.save();
      } catch (e) {
        console.error("persist failed; will retry", e);
      }
    } else if (!this.needsPersist(core)) {
      await this.lobby().gameEnded(core.s.id);
    }
    const now = Date.now();
    for (const ws of this.ctx.getWebSockets()) {
      const { uid } = ws.deserializeAttachment() as Attachment;
      send(ws, { t: "end", g: core.view(now, uid ? core.colorOf(uid) : null, this.online(), this.spectators()) });
    }
    await this.schedule();
  }

  private lobby() {
    return this.env.LOBBY.get(this.env.LOBBY.idFromName("global"));
  }

  private sockets(): WebSocket[] {
    return this.ctx.getWebSockets().filter((ws) => ws.readyState === WebSocket.OPEN);
  }

  private online(): { white: boolean; black: boolean } {
    const core = this.core;
    const o = { white: false, black: false };
    if (!core) return o;
    for (const ws of this.sockets()) {
      const { uid } = ws.deserializeAttachment() as Attachment;
      const c: Color | null = uid ? core.colorOf(uid) : null;
      if (c) o[c] = true;
    }
    return o;
  }

  private spectators(): number {
    const core = this.core;
    if (!core) return 0;
    const seen = new Set<string>();
    let anon = 0;
    for (const ws of this.sockets()) {
      const { uid } = ws.deserializeAttachment() as Attachment;
      if (!uid) anon++;
      else if (!core.colorOf(uid)) seen.add(uid);
    }
    return seen.size + anon;
  }

  private sendState(ws: WebSocket) {
    const core = this.core;
    if (!core) return;
    const { uid } = ws.deserializeAttachment() as Attachment;
    send(ws, { t: "state", g: core.view(Date.now(), uid ? core.colorOf(uid) : null, this.online(), this.spectators()) });
  }

  private broadcastState() {
    for (const ws of this.ctx.getWebSockets()) this.sendState(ws);
  }

  private broadcastOffers() {
    const core = this.core;
    if (!core) return;
    this.broadcast({ t: "offers", drawOffer: core.s.drawOffer, rematchOffer: core.s.rematchOffer });
  }

  private broadcastPresence() {
    this.broadcast({ t: "presence", online: this.online(), spectators: this.spectators() });
  }

  private broadcast(m: ServerGameMsg) {
    const s = JSON.stringify(m);
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(s);
      } catch {
        /* closed */
      }
    }
  }
}

function send(ws: WebSocket, m: ServerGameMsg) {
  try {
    ws.send(JSON.stringify(m));
  } catch {
    /* closed */
  }
}
