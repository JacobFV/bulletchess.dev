import { describe, expect, it } from "vitest";
import { Chess } from "chess.js";
import { buildPgn, canMate, GameCore, newCore } from "../src/shared/core";
import type { PlayerInfo } from "../src/shared/protocol";
import { firstMoveMs } from "../src/shared/tc";

const W: PlayerInfo = { id: "w", username: "alice", rating: 1500, provisional: true };
const B: PlayerInfo = { id: "b", username: "bob", rating: 1500, provisional: true };

function game(base = 60, inc = 0, now = 0) {
  return new GameCore(newCore({ id: "g1", base, inc, rated: true, source: "pool", now, white: W, black: B }));
}

describe("GameCore", () => {
  it("starts with full clocks, no clock running until both sides moved", () => {
    const g = game();
    expect(g.s.status).toBe("started");
    expect(g.clockRunning).toBe(false);
    expect(g.move("white", "e2e4", 5000).ok).toBe(true);
    expect(g.clockRunning).toBe(false);
    expect(g.move("black", "e7e5", 9000).ok).toBe(true);
    expect(g.clockRunning).toBe(true);
    expect(g.s.clock).toEqual({ white: 60000, black: 60000 });
  });

  it("deducts elapsed time from the mover and adds increment", () => {
    const g = game(60, 1);
    g.move("white", "e2e4", 0);
    g.move("black", "e7e5", 0);
    expect(g.move("white", "g1f3", 3000).ok).toBe(true);
    expect(g.s.clock.white).toBe(60000 - 3000 + 1000);
    expect(g.clocksAt(5000).black).toBe(60000 - 2000);
  });

  it("rejects illegal, out-of-turn and malformed moves", () => {
    const g = game();
    expect(g.move("black", "e7e5", 0)).toMatchObject({ ok: false });
    expect(g.move("white", "e2e5", 0)).toMatchObject({ ok: false, error: "Illegal move." });
    expect(g.move("white", "zz", 0)).toMatchObject({ ok: false, error: "Malformed move." });
    expect(g.ply).toBe(0);
  });

  it("ends by timeout when the flag falls", () => {
    const g = game(15);
    g.move("white", "e2e4", 0);
    g.move("black", "e7e5", 0);
    expect(g.nextDeadline()).toBe(15000);
    expect(g.checkTime(14999)).toBe(false);
    expect(g.checkTime(15000)).toBe(true);
    expect(g.s.status).toBe("timeout");
    expect(g.s.winner).toBe("black");
    expect(g.s.clock.white).toBe(0);
  });

  it("a move arriving after the flag fell loses on time instead", () => {
    const g = game(15);
    g.move("white", "e2e4", 0);
    g.move("black", "e7e5", 0);
    const r = g.move("white", "g1f3", 16000);
    expect(r.ok).toBe(false);
    expect(g.s.status).toBe("timeout");
  });

  it("canMate: lone king or single minor cannot mate; pawns/rooks can", () => {
    expect(canMate(new Chess("8/8/8/4k3/8/8/8/4K3 w - - 0 1"), "white")).toBe(false);
    expect(canMate(new Chess("8/8/8/4k3/8/8/8/3NK3 w - - 0 1"), "white")).toBe(false);
    expect(canMate(new Chess("8/8/8/4k3/8/8/8/2NNK3 w - - 0 1"), "white")).toBe(true);
    expect(canMate(new Chess("8/8/8/4k3/8/8/4P3/4K3 w - - 0 1"), "white")).toBe(true);
    expect(canMate(new Chess("8/8/8/4k3/8/8/8/R3K3 w - - 0 1"), "black")).toBe(false);
  });

  it("aborts when nobody makes a first move", () => {
    const g = game(60);
    expect(g.checkTime(firstMoveMs(g.s) - 1)).toBe(false);
    expect(g.checkTime(firstMoveMs(g.s))).toBe(true);
    expect(g.s.status).toBe("noStart");
    expect(g.countsForRating).toBe(false);
  });

  it("detects checkmate (fool's mate)", () => {
    const g = game();
    for (const [c, m] of [
      ["white", "f2f3"],
      ["black", "e7e5"],
      ["white", "g2g4"],
    ] as const)
      expect(g.move(c, m, 0).ok).toBe(true);
    const r = g.move("black", "d8h4", 100);
    expect(r).toMatchObject({ ok: true, san: "Qh4#", ended: true });
    expect(g.s.status).toBe("mate");
    expect(g.s.winner).toBe("black");
    expect(g.countsForRating).toBe(true);
  });

  it("detects threefold repetition", () => {
    const g = game();
    const seq = ["g1f3", "g8f6", "f3g1", "f6g8", "g1f3", "g8f6", "f3g1", "f6g8"];
    seq.forEach((m, i) => g.move(i % 2 === 0 ? "white" : "black", m, i));
    expect(g.s.status).toBe("repetition");
    expect(g.s.winner).toBeNull();
  });

  it("abort is allowed only before both sides moved; resign before that aborts", () => {
    const g = game();
    g.move("white", "e2e4", 0);
    expect(g.resign("black", 10)).toBeNull();
    expect(g.s.status).toBe("aborted");
    const h = game();
    h.move("white", "e2e4", 0);
    h.move("black", "e7e5", 0);
    expect(h.abort("white", 0)).toMatch(/Too late/);
    expect(h.resign("white", 0)).toBeNull();
    expect(h.s).toMatchObject({ status: "resign", winner: "black" });
  });

  it("draw offers: mutual offer ends the game, a move by the other side declines", () => {
    const g = game();
    g.move("white", "e2e4", 0);
    g.move("black", "e7e5", 0);
    g.offerDraw("white", 0);
    expect(g.s.drawOffer).toBe("white");
    g.move("white", "g1f3", 0); // offerer moving keeps it
    expect(g.s.drawOffer).toBe("white");
    g.move("black", "b8c6", 0); // opponent moving declines
    expect(g.s.drawOffer).toBeNull();
    g.offerDraw("white", 0);
    g.offerDraw("black", 0);
    expect(g.s.status).toBe("draw");
  });

  it("lag compensation is bounded by the quota", () => {
    const g = game(60);
    g.move("white", "e2e4", 0);
    g.move("black", "e7e5", 0);
    g.recordLag("white", 100);
    g.move("white", "g1f3", 1000);
    expect(g.s.clock.white).toBe(60000 - 900);
    expect(g.s.lagQuota.white).toBe(1000);
  });

  it("challenge seating assigns colors and refuses self-play", () => {
    const g = new GameCore(newCore({ id: "c", base: 60, inc: 0, rated: false, source: "challenge", now: 0, white: W, creatorId: "w", creatorColor: "black" }));
    expect(g.s.status).toBe("waiting");
    expect(g.seat(W, 1)).toMatch(/yourself/);
    expect(g.seat(B, 1)).toBeNull();
    expect(g.s.white?.id).toBe("b");
    expect(g.s.black?.id).toBe("w");
    expect(g.s.status).toBe("started");
  });

  it("rematch needs both offers", () => {
    const g = game();
    g.move("white", "e2e4", 0);
    g.move("black", "e7e5", 0);
    g.resign("white", 0);
    expect(g.offerRematch("white")).toBe(false);
    expect(g.offerRematch("black")).toBe(true);
  });

  it("survives serialisation round-trip (hibernation)", () => {
    const g = game();
    g.move("white", "e2e4", 0);
    g.move("black", "c7c5", 0);
    const h = new GameCore(JSON.parse(JSON.stringify(g.s)));
    expect(h.fen).toBe(g.fen);
    expect(h.move("white", "g1f3", 10).ok).toBe(true);
  });

  it("builds a PGN with clocks", () => {
    const pgn = buildPgn({
      id: "abc",
      site: "https://bulletchess.dev",
      white: "alice",
      black: "bob",
      whiteElo: 1500,
      blackElo: 1490,
      rated: true,
      base: 60,
      inc: 0,
      status: "mate",
      winner: "black",
      sans: ["f3", "e5", "g4", "Qh4#"],
      moveClocks: [60000, 60000, 59000, 58500],
      startedAt: Date.UTC(2026, 10, 9, 12, 0, 0),
    });
    expect(pgn).toContain('[Result "0-1"]');
    expect(pgn).toContain('[TimeControl "60+0"]');
    expect(pgn).toContain("1. f3 { [%clk 0:01:00.0] } e5");
    expect(pgn.trim().endsWith("0-1")).toBe(true);
  });
});
