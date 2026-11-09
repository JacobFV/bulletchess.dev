#!/usr/bin/env node
// End-to-end test against a running local stack (`pnpm dev`, ENVIRONMENT=development, EMAIL_PROVIDER=log).
// Exercises: sign-up, email verification, sign-in, matchmaking, a full game over WebSockets,
// ratings, archive + PGN, friend challenge, rematch, server-side flag, abort, bot-game saving,
// password reset, and security checks (cross-origin refusal, spectator cannot move).
// Usage: node scripts/e2e.mjs [baseUrl]
import assert from "node:assert/strict";

const BASE = process.argv[2] ?? "http://localhost:5173";
const ORIGIN = BASE;
const run = Math.random().toString(36).slice(2, 7);
let passed = 0;

function step(name) {
  process.stdout.write(`• ${name} … `);
  return () => {
    passed++;
    console.log("ok");
  };
}

class Client {
  constructor(name) {
    this.name = name;
    this.cookies = new Map();
  }
  cookieHeader() {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
  }
  absorb(res) {
    for (const c of res.headers.getSetCookie?.() ?? []) {
      const [kv] = c.split(";");
      const i = kv.indexOf("=");
      const k = kv.slice(0, i);
      const v = kv.slice(i + 1);
      if (v === "" || /max-age=0/i.test(c)) this.cookies.delete(k);
      else this.cookies.set(k, v);
    }
  }
  async req(path, { method = "GET", json, origin = ORIGIN } = {}) {
    const headers = { Cookie: this.cookieHeader() };
    if (origin) headers.Origin = origin;
    if (json !== undefined) headers["Content-Type"] = "application/json";
    const res = await fetch(BASE + path, { method, headers, body: json !== undefined ? JSON.stringify(json) : undefined, redirect: "manual" });
    this.absorb(res);
    const text = await res.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
    return { status: res.status, body };
  }
  ws(path) {
    const url = BASE.replace(/^http/, "ws") + path;
    const sock = new WebSocket(url, { headers: { Cookie: this.cookieHeader(), Origin: ORIGIN } });
    const queue = [];
    const waiters = [];
    sock.addEventListener("message", (e) => {
      const m = JSON.parse(e.data);
      if (m.t === "ping") sock.send(JSON.stringify({ t: "pong", s: m.s }));
      const w = waiters.findIndex((x) => x.pred(m));
      if (w >= 0) waiters.splice(w, 1)[0].resolve(m);
      else queue.push(m);
    });
    const opened = new Promise((res, rej) => {
      sock.addEventListener("open", res, { once: true });
      sock.addEventListener("error", rej, { once: true });
    });
    return {
      sock,
      opened,
      send: (m) => sock.send(JSON.stringify(m)),
      next(pred, timeout = 8000) {
        const i = queue.findIndex(pred);
        if (i >= 0) return Promise.resolve(queue.splice(i, 1)[0]);
        return new Promise((resolve, reject) => {
          const t = setTimeout(() => reject(new Error(`${this.name ?? "ws"} timed out waiting`)), timeout);
          waiters.push({ pred, resolve: (m) => (clearTimeout(t), resolve(m)) });
        });
      },
      close: () => sock.close(),
    };
  }
}

async function mailbox() {
  const r = await fetch(`${BASE}/api/dev/mailbox`);
  assert.equal(r.status, 200, "dev mailbox must be enabled (ENVIRONMENT=development, EMAIL_PROVIDER=log)");
  return (await r.json()).messages;
}

async function tokenFor(email, kind) {
  for (let i = 0; i < 20; i++) {
    const msgs = (await mailbox()).filter((m) => m.to === email && m.text.includes(kind));
    const m = msgs.at(-1);
    if (m) return decodeURIComponent(/#token=([^\s]+)/.exec(m.text)[1]);
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`no ${kind} email for ${email}`);
}

async function signUpAndVerify(username) {
  const c = new Client(username);
  const email = `${username}@example.invalid`;
  const password = `pw-${run}-correct-horse`;
  let r = await c.req("/api/auth/sign-up/email", { method: "POST", json: { email, password, name: username, username } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  r = await c.req("/api/auth/sign-in/email", { method: "POST", json: { email, password } });
  assert.equal(r.status, 403, "unverified sign-in must be refused");
  const token = await tokenFor(email, "verify-email");
  r = await c.req(`/api/auth/verify-email?token=${encodeURIComponent(token)}`);
  assert.ok(r.status === 200 || r.status === 302, `verify: ${r.status} ${JSON.stringify(r.body)}`);
  r = await c.req("/api/me");
  if (!r.body.user) {
    r = await c.req("/api/auth/sign-in/email", { method: "POST", json: { email, password } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    r = await c.req("/api/me");
  }
  assert.equal(r.body.user.username, username);
  c.email = email;
  c.password = password;
  c.id = r.body.user.id;
  return c;
}

async function play(game, moves) {
  // game: { w, b } sockets. Plays alternating moves and waits for each echo on both sides.
  for (let i = 0; i < moves.length; i++) {
    const mover = i % 2 === 0 ? game.w : game.b;
    mover.send({ t: "move", u: moves[i], ply: i });
    await game.w.next((m) => m.t === "move" && m.ply === i + 1);
    await game.b.next((m) => m.t === "move" && m.ply === i + 1);
  }
}

async function main() {
  console.log(`e2e against ${BASE} (run ${run})`);
  let done = step("sign up + verify two players");
  const A = await signUpAndVerify(`a${run}`);
  const B = await signUpAndVerify(`b${run}`);
  done();

  done = step("username uniqueness is case-insensitive");
  {
    const c = new Client("dup");
    const r = await c.req("/api/auth/sign-up/email", { method: "POST", json: { email: `dup${run}@example.invalid`, password: "pw-long-enough-123", name: "x", username: A.name.toUpperCase() } });
    assert.notEqual(r.status, 200);
  }
  done();

  done = step("cross-origin POST is refused");
  {
    const r = await A.req("/api/challenges", { method: "POST", json: { base: 60, inc: 0, rated: false, color: "white" }, origin: "https://evil.example" });
    assert.equal(r.status, 403);
  }
  done();

  done = step("matchmaking pairs both players in the 1+0 pool");
  const la = A.ws("/api/lobby/ws");
  const lb = B.ws("/api/lobby/ws");
  await Promise.all([la.opened, lb.opened]);
  await la.next((m) => m.t === "hello");
  await lb.next((m) => m.t === "hello");
  la.send({ t: "seek", pool: "1+0" });
  await la.next((m) => m.t === "seeking");
  lb.send({ t: "seek", pool: "1+0" });
  const [sa, sb] = await Promise.all([la.next((m) => m.t === "start"), lb.next((m) => m.t === "start")]);
  assert.equal(sa.id, sb.id);
  const gid = sa.id;
  done();

  done = step("game state: seated, clocks, colors");
  const ga = A.ws(`/api/games/${gid}/ws`);
  const gb = B.ws(`/api/games/${gid}/ws`);
  await Promise.all([ga.opened, gb.opened]);
  const [stA, stB] = await Promise.all([ga.next((m) => m.t === "state"), gb.next((m) => m.t === "state")]);
  assert.equal(stA.g.status, "started");
  assert.equal(stA.g.clocks.white, 60000);
  assert.notEqual(stA.g.you, stB.g.you);
  const game = stA.g.you === "white" ? { w: ga, b: gb, W: A, B: B } : { w: gb, b: ga, W: B, B: A };
  done();

  done = step("seeking again while in a game returns to that game");
  la.send({ t: "seek", pool: "2+1" });
  assert.equal((await la.next((m) => m.t === "start")).id, gid);
  done();

  done = step("spectator cannot move; illegal and out-of-turn moves rejected");
  {
    const spec = new Client("spec").ws(`/api/games/${gid}/ws`);
    await spec.opened;
    const s = await spec.next((m) => m.t === "state");
    assert.equal(s.g.you, null);
    spec.send({ t: "move", u: "e2e4", ply: 0 });
    assert.match((await spec.next((m) => m.t === "error")).message, /not playing/);
    game.b.send({ t: "move", u: "e7e5", ply: 0 });
    await game.b.next((m) => m.t === "error");
    game.w.send({ t: "move", u: "e2e5", ply: 0 });
    assert.equal((await game.w.next((m) => m.t === "error")).message, "Illegal move.");
    spec.close();
  }
  done();

  done = step("fool's mate ends the game; ratings update");
  await play(game, ["f2f3", "e7e5", "g2g4"]);
  game.b.send({ t: "move", u: "d8h4", ply: 3 });
  const endW = await game.w.next((m) => m.t === "end");
  await game.b.next((m) => m.t === "end");
  assert.equal(endW.g.status, "mate");
  assert.equal(endW.g.winner, "black");
  assert.ok(endW.g.black.ratingDiff > 0, `black gains: ${endW.g.black.ratingDiff}`);
  assert.ok(endW.g.white.ratingDiff < 0);
  done();

  done = step("archived game with PGN; profile + leaderboard reflect it");
  {
    const r = await A.req(`/api/games/${gid}`);
    assert.ok(r.body.archived, JSON.stringify(r.body));
    assert.equal(r.body.archived.sans.join(" "), "f3 e5 g4 Qh4#");
    assert.match(r.body.archived.pgn, /\[Result "0-1"\]/);
    const pgn = await fetch(`${BASE}/api/games/${gid}/pgn`);
    assert.equal(pgn.headers.get("content-type"), "application/x-chess-pgn; charset=utf-8");
    const p = await A.req(`/api/users/${game.B.name}`);
    assert.equal(p.body.ratings.bullet.games, 1);
    assert.equal(p.body.ratings.bullet.wins, 1);
    const games = await A.req(`/api/users/${game.B.name}/games`);
    assert.equal(games.body.games[0].id, gid);
    const hist = await A.req(`/api/users/${game.B.name}/history?perf=bullet`);
    assert.equal(hist.body.points.length, 1);
    const lb = await A.req(`/api/leaderboard?perf=bullet`);
    assert.ok(lb.body.players.some((x) => x.username === game.B.name));
  }
  done();

  done = step("rematch: both offer → new game with colors swapped");
  game.w.send({ t: "rematch-offer" });
  await game.b.next((m) => m.t === "offers" && m.rematchOffer);
  game.b.send({ t: "rematch-offer" });
  const rm = await game.w.next((m) => m.t === "rematch");
  await game.b.next((m) => m.t === "rematch");
  ga.close();
  gb.close();
  {
    const rw = game.B.ws(`/api/games/${rm.id}/ws`);
    await rw.opened;
    const s = await rw.next((m) => m.t === "state");
    assert.equal(s.g.you, "white", "previous black is now white");
    assert.equal(s.g.source ?? "rematch", "rematch");
    rw.send({ t: "abort" });
    await rw.next((m) => m.t === "end");
    rw.close();
  }
  done();

  done = step("friend challenge: create, join, play, resign");
  {
    let r = await A.req("/api/challenges", { method: "POST", json: { base: 30, inc: 0, rated: false, color: "black" } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const cid = r.body.id;
    r = await B.req(`/api/games/${cid}`);
    assert.equal(r.body.live.status, "waiting");
    const ca = A.ws(`/api/games/${cid}/ws`);
    const cb = B.ws(`/api/games/${cid}/ws`);
    await Promise.all([ca.opened, cb.opened]);
    await ca.next((m) => m.t === "state");
    await cb.next((m) => m.t === "state");
    ca.send({ t: "join" });
    assert.match((await ca.next((m) => m.t === "error")).message, /yourself/);
    cb.send({ t: "join" });
    const s = await cb.next((m) => m.t === "state" && m.g.status === "started");
    assert.equal(s.g.you, "white");
    await play({ w: cb, b: ca }, ["e2e4", "e7e5"]);
    ca.send({ t: "resign" });
    const e = await cb.next((m) => m.t === "end");
    assert.equal(e.g.status, "resign");
    assert.equal(e.g.winner, "white");
    assert.equal(e.g.white.ratingDiff, undefined, "casual: no rating change");
    ca.close();
    cb.close();
  }
  done();

  done = step("server flags a player who runs out of time (15+0, alarm-driven)");
  {
    let r = await A.req("/api/challenges", { method: "POST", json: { base: 15, inc: 0, rated: true, color: "white" } });
    const cid = r.body.id;
    const ca = A.ws(`/api/games/${cid}/ws`);
    const cb = B.ws(`/api/games/${cid}/ws`);
    await Promise.all([ca.opened, cb.opened]);
    cb.send({ t: "join" });
    await ca.next((m) => m.t === "state" && m.g.status === "started");
    await cb.next((m) => m.t === "state" && m.g.status === "started");
    await play({ w: ca, b: cb }, ["d2d4", "d7d5"]);
    const t0 = Date.now();
    const e = await ca.next((m) => m.t === "end", 25_000);
    const elapsed = Date.now() - t0;
    assert.equal(e.g.status, "timeout");
    assert.equal(e.g.winner, "black");
    assert.ok(elapsed > 14_000 && elapsed < 17_500, `flag after ${elapsed} ms`);
    assert.equal(e.g.perf, "ultrabullet");
    assert.ok(typeof e.g.black.ratingDiff === "number");
    ca.close();
    cb.close();
  }
  done();

  done = step("bot game saves after server-side validation; false claims rejected");
  {
    const fool = ["f2f3", "e7e5", "g2g4", "d8h4"];
    let r = await A.req("/api/games/bot", { method: "POST", json: { level: 3, color: "black", base: 60, inc: 0, moves: fool, clocks: [60000, 60000, 59000, 58000], status: "mate", winner: "white", startedAt: Date.now() - 10_000 } });
    assert.equal(r.status, 400, "wrong winner must be refused");
    r = await A.req("/api/games/bot", { method: "POST", json: { level: 3, color: "black", base: 60, inc: 0, moves: fool, clocks: [60000, 60000, 59000, 58000], status: "mate", winner: "black", startedAt: Date.now() - 10_000 } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const g = await A.req(`/api/games/${r.body.id}`);
    assert.equal(g.body.archived.white.username, "Stockfish level 3");
    assert.equal(g.body.archived.botLevel, 3);
    r = await new Client("anon").req("/api/games/bot", { method: "POST", json: {} });
    assert.equal(r.status, 401);
  }
  done();

  done = step("password reset by email; old sessions revoked");
  {
    const anon = new Client("reset");
    let r = await anon.req("/api/auth/request-password-reset", { method: "POST", json: { email: A.email, redirectTo: `${BASE}/reset-password` } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const token = await tokenFor(A.email, "reset-password");
    const np = `new-pw-${run}-battery-staple`;
    r = await anon.req("/api/auth/reset-password", { method: "POST", json: { newPassword: np, token } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    // cookie cache allows up to 60 s of staleness; check the session row is gone instead of /api/me.
    r = await anon.req("/api/auth/sign-in/username", { method: "POST", json: { username: A.name, password: A.password } });
    assert.equal(r.status, 401);
    r = await anon.req("/api/auth/sign-in/username", { method: "POST", json: { username: A.name, password: np } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
  }
  done();

  la.close();
  lb.close();
  console.log(`\n${passed} checks passed.`);
  process.exit(0);
}

main().catch((e) => {
  console.error("\nFAILED:", e);
  process.exit(1);
});
