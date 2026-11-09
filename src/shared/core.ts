/**
 * Authoritative game state machine. Pure: time is always passed in, nothing touches I/O.
 * Used by the Game Durable Object (and by tests). Clocks are server-side only; the client
 * merely displays them.
 */
import { Chess } from "chess.js";
import type { Color, GameStatus, GameView, PlayerInfo } from "./protocol";
import { FINISHED } from "./protocol";
import { firstMoveMs, perfOf, type Perf } from "./tc";

export const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

export interface CoreState {
  id: string;
  base: number;
  inc: number;
  rated: boolean;
  perf: Perf;
  source: "pool" | "challenge" | "rematch";
  white: PlayerInfo | null;
  black: PlayerInfo | null;
  creatorId: string | null;
  creatorColor: "white" | "black" | "random";
  moves: string[];
  sans: string[];
  /** Remaining clock in ms after each move (for PGN %clk and replays). */
  moveClocks: number[];
  clock: { white: number; black: number };
  /** When the side to move's turn began (epoch ms). */
  turnStartedAt: number;
  createdAt: number;
  startedAt: number | null;
  endedAt: number | null;
  status: GameStatus;
  winner: Color | null;
  drawOffer: Color | null;
  rematchOffer: Color | null;
  rematchId: string | null;
  lagQuota: { white: number; black: number };
  /** Smoothed one-way latency estimate per player (ms), measured by the server from pings. */
  lag: { white: number; black: number };
}

export type MoveResult =
  | { ok: true; san: string; ended: boolean }
  | { ok: false; error: string; ended?: boolean };

const LAG_QUOTA_START = 1000;
const LAG_QUOTA_MAX = 2000;
const LAG_QUOTA_GAIN = 100;
const LAG_COMP_MAX = 250;

export const opposite = (c: Color): Color => (c === "white" ? "black" : "white");

export function newCore(o: {
  id: string;
  base: number;
  inc: number;
  rated: boolean;
  source: CoreState["source"];
  now: number;
  white?: PlayerInfo | null;
  black?: PlayerInfo | null;
  creatorId?: string | null;
  creatorColor?: CoreState["creatorColor"];
}): CoreState {
  const seated = !!(o.white && o.black);
  return {
    id: o.id,
    base: o.base,
    inc: o.inc,
    rated: o.rated,
    perf: perfOf({ base: o.base, inc: o.inc }),
    source: o.source,
    white: o.white ?? null,
    black: o.black ?? null,
    creatorId: o.creatorId ?? null,
    creatorColor: o.creatorColor ?? "random",
    moves: [],
    sans: [],
    moveClocks: [],
    clock: { white: o.base * 1000, black: o.base * 1000 },
    turnStartedAt: o.now,
    createdAt: o.now,
    startedAt: seated ? o.now : null,
    endedAt: null,
    status: seated ? "started" : "waiting",
    winner: null,
    drawOffer: null,
    rematchOffer: null,
    rematchId: null,
    lagQuota: { white: LAG_QUOTA_START, black: LAG_QUOTA_START },
    lag: { white: 0, black: 0 },
  };
}

export class GameCore {
  readonly s: CoreState;
  private chess: Chess;

  constructor(state: CoreState) {
    this.s = state;
    this.chess = new Chess(START_FEN);
    for (const u of state.moves) this.chess.move(uciToMove(u));
  }

  get finished(): boolean {
    return FINISHED.includes(this.s.status);
  }
  get ply(): number {
    return this.s.moves.length;
  }
  get turn(): Color {
    return this.ply % 2 === 0 ? "white" : "black";
  }
  get fen(): string {
    return this.chess.fen();
  }
  get clockRunning(): boolean {
    return this.s.status === "started" && this.ply >= 2;
  }

  colorOf(userId: string): Color | null {
    if (this.s.white?.id === userId) return "white";
    if (this.s.black?.id === userId) return "black";
    return null;
  }

  firstMoveDeadline(): number | null {
    if (this.s.status !== "started" || this.ply >= 2) return null;
    return this.s.turnStartedAt + firstMoveMs(this.s);
  }

  /** Clocks as of `now` (side to move's running clock deducted). */
  clocksAt(now: number): { white: number; black: number } {
    const c = { ...this.s.clock };
    if (this.clockRunning) c[this.turn] = Math.max(0, c[this.turn] - (now - this.s.turnStartedAt));
    return c;
  }

  /** The next instant at which something time-based must happen (flag or no-start), or null. */
  nextDeadline(): number | null {
    if (this.s.status === "waiting") return this.s.createdAt + 24 * 3600_000;
    if (this.s.status !== "started") return null;
    const fm = this.firstMoveDeadline();
    if (fm !== null) return fm;
    return this.s.turnStartedAt + this.s.clock[this.turn];
  }

  /** Seat the second player of a challenge. Returns an error string or null. */
  seat(p: PlayerInfo, now: number, random: () => number = Math.random): string | null {
    if (this.s.status !== "waiting") return "This game has already started.";
    if (p.id === this.s.creatorId) return "You cannot play yourself.";
    const creator = this.s.white ?? this.s.black;
    if (!creator) return "Broken challenge.";
    const creatorColor: Color = this.s.creatorColor === "random" ? (random() < 0.5 ? "white" : "black") : this.s.creatorColor;
    this.s.white = creatorColor === "white" ? creator : p;
    this.s.black = creatorColor === "white" ? p : creator;
    this.s.status = "started";
    this.s.startedAt = now;
    this.s.turnStartedAt = now;
    return null;
  }

  move(color: Color, uci: string, now: number): MoveResult {
    if (this.s.status !== "started") return { ok: false, error: "Game is not in progress." };
    if (color !== this.turn) return { ok: false, error: "Not your turn." };
    if (this.checkTime(now)) return { ok: false, error: "Time is up.", ended: true };
    if (!/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(uci)) return { ok: false, error: "Malformed move." };
    let san: string;
    try {
      san = this.chess.move(uciToMove(uci)).san;
    } catch {
      return { ok: false, error: "Illegal move." };
    }
    const ply = this.ply; // before push
    if (ply >= 2) {
      const elapsed = now - this.s.turnStartedAt;
      const comp = Math.max(0, Math.min(this.s.lag[color], this.s.lagQuota[color], LAG_COMP_MAX, elapsed));
      this.s.lagQuota[color] = Math.min(LAG_QUOTA_MAX, this.s.lagQuota[color] - comp + LAG_QUOTA_GAIN);
      this.s.clock[color] = Math.max(1, this.s.clock[color] - (elapsed - comp)) + this.s.inc * 1000;
    }
    this.s.moves.push(uci);
    this.s.sans.push(san);
    this.s.moveClocks.push(this.s.clock[color]);
    this.s.turnStartedAt = now;
    if (this.s.drawOffer && this.s.drawOffer !== color) this.s.drawOffer = null; // moving declines
    const ended = this.checkPositionEnd(now, color);
    return { ok: true, san, ended };
  }

  private checkPositionEnd(now: number, mover: Color): boolean {
    const c = this.chess;
    if (c.isCheckmate()) return this.end("mate", mover, now);
    if (c.isStalemate()) return this.end("stalemate", null, now);
    if (c.isInsufficientMaterial()) return this.end("insufficient", null, now);
    if (c.isThreefoldRepetition()) return this.end("repetition", null, now);
    if (c.isDrawByFiftyMoves()) return this.end("fifty", null, now);
    return false;
  }

  /** Ends the game if a flag fell or the first-move window passed. Returns true if it ended. */
  checkTime(now: number): boolean {
    if (this.s.status !== "started") return false;
    const fm = this.firstMoveDeadline();
    if (fm !== null) {
      if (now >= fm) return this.end("noStart", null, now);
      return false;
    }
    const stm = this.turn;
    if (this.s.clock[stm] - (now - this.s.turnStartedAt) <= 0) {
      this.s.clock[stm] = 0;
      const winner = opposite(stm);
      if (!canMate(this.chess, winner)) return this.end("timeout-draw", null, now);
      return this.end("timeout", winner, now);
    }
    return false;
  }

  resign(color: Color, now: number): string | null {
    if (this.s.status !== "started") return "Game is not in progress.";
    if (this.checkTime(now)) return null;
    if (this.ply < 2) return this.abort(color, now);
    this.end("resign", opposite(color), now);
    return null;
  }

  abort(color: Color, now: number): string | null {
    if (this.s.status === "waiting") {
      this.end("aborted", null, now);
      return null;
    }
    if (this.s.status !== "started") return "Game is not in progress.";
    if (this.ply >= 2) return "Too late to abort; resign instead.";
    void color;
    this.end("aborted", null, now);
    return null;
  }

  offerDraw(color: Color, now: number): string | null {
    if (this.s.status !== "started") return "Game is not in progress.";
    if (this.checkTime(now)) return null;
    if (this.ply < 2) return "Make a move first.";
    if (this.s.drawOffer === opposite(color)) {
      this.end("draw", null, now);
      return null;
    }
    this.s.drawOffer = color;
    return null;
  }

  declineDraw(color: Color): void {
    if (this.s.drawOffer === opposite(color)) this.s.drawOffer = null;
  }

  /** Records a rematch offer. Returns true when both players have now offered. */
  offerRematch(color: Color): boolean {
    if (!this.finished || this.s.rematchId) return false;
    if (!this.s.white || !this.s.black) return false;
    if (this.s.rematchOffer === opposite(color)) return true;
    this.s.rematchOffer = color;
    return false;
  }

  declineRematch(color: Color): void {
    if (this.s.rematchOffer === opposite(color)) this.s.rematchOffer = null;
  }

  /** Records a latency sample (RTT/2) for a player. */
  recordLag(color: Color, oneWayMs: number): void {
    const v = Math.max(0, Math.min(1000, oneWayMs));
    const prev = this.s.lag[color];
    this.s.lag[color] = prev === 0 ? v : Math.round(prev * 0.7 + v * 0.3);
  }

  private end(status: GameStatus, winner: Color | null, now: number): true {
    if (this.clockRunning && status !== "timeout" && status !== "timeout-draw") {
      // freeze the running clock at the moment of ending
      const stm = this.turn;
      this.s.clock[stm] = Math.max(0, this.s.clock[stm] - (now - this.s.turnStartedAt));
    }
    this.s.status = status;
    this.s.winner = winner;
    this.s.endedAt = now;
    this.s.drawOffer = null;
    this.s.turnStartedAt = now;
    return true;
  }

  /** Whether the result should change ratings. */
  get countsForRating(): boolean {
    return this.s.rated && this.finished && this.s.status !== "aborted" && this.s.status !== "noStart" && this.ply >= 2;
  }

  view(now: number, you: Color | null, online: { white: boolean; black: boolean }, spectators: number): GameView {
    return {
      id: this.s.id,
      status: this.s.status,
      winner: this.s.winner,
      rated: this.s.rated,
      perf: this.s.perf,
      base: this.s.base,
      inc: this.s.inc,
      white: this.s.white,
      black: this.s.black,
      moves: this.s.moves,
      sans: this.s.sans,
      fen: this.fen,
      clocks: this.finished ? { ...this.s.clock } : this.clocksAt(now),
      running: this.clockRunning,
      firstMoveDeadline: this.firstMoveDeadline(),
      serverNow: now,
      drawOffer: this.s.drawOffer,
      rematchOffer: this.s.rematchOffer,
      rematchId: this.s.rematchId,
      you,
      online,
      spectators,
      creatorColor: this.s.status === "waiting" ? this.s.creatorColor : undefined,
    };
  }
}

export function uciToMove(u: string): { from: string; to: string; promotion?: string } {
  return { from: u.slice(0, 2), to: u.slice(2, 4), promotion: u.length > 4 ? u[4] : undefined };
}

/**
 * Can `color` still possibly deliver mate? Conservative (FIDE-style) test used for
 * timeout-vs-insufficient-material: a lone king, or king plus a single minor piece, cannot.
 */
export function canMate(chess: Chess, color: Color): boolean {
  const c = color === "white" ? "w" : "b";
  let minors = 0;
  for (const row of chess.board())
    for (const sq of row) {
      if (!sq || sq.color !== c) continue;
      if (sq.type === "p" || sq.type === "r" || sq.type === "q") return true;
      if (sq.type === "n" || sq.type === "b") minors++;
    }
  return minors >= 2;
}

export function resultString(status: GameStatus, winner: Color | null): string {
  if (status === "aborted" || status === "noStart" || status === "waiting" || status === "started") return "*";
  return winner === "white" ? "1-0" : winner === "black" ? "0-1" : "1/2-1/2";
}

export function statusText(status: GameStatus, winner: Color | null): string {
  const w = winner === "white" ? "White" : "Black";
  switch (status) {
    case "mate":
      return `Checkmate · ${w} wins`;
    case "resign":
      return `${winner === "white" ? "Black" : "White"} resigned · ${w} wins`;
    case "timeout":
      return `${winner === "white" ? "Black" : "White"} ran out of time · ${w} wins`;
    case "timeout-draw":
      return "Time out, but the opponent cannot mate · Draw";
    case "stalemate":
      return "Stalemate · Draw";
    case "draw":
      return "Draw by agreement";
    case "repetition":
      return "Threefold repetition · Draw";
    case "fifty":
      return "Fifty-move rule · Draw";
    case "insufficient":
      return "Insufficient material · Draw";
    case "aborted":
      return "Game aborted";
    case "noStart":
      return "Game aborted · no first move";
    case "waiting":
      return "Waiting for an opponent";
    default:
      return "Playing";
  }
}

/** PGN with clock comments, built from stored data. */
export function buildPgn(g: {
  id: string;
  site: string;
  white: string;
  black: string;
  whiteElo?: number | null;
  blackElo?: number | null;
  rated: boolean;
  base: number;
  inc: number;
  status: GameStatus;
  winner: Color | null;
  sans: string[];
  moveClocks: number[];
  startedAt: number;
}): string {
  const d = new Date(g.startedAt);
  const date = `${d.getUTCFullYear()}.${String(d.getUTCMonth() + 1).padStart(2, "0")}.${String(d.getUTCDate()).padStart(2, "0")}`;
  const time = d.toISOString().slice(11, 19);
  const result = resultString(g.status, g.winner);
  const termination = g.status === "timeout" || g.status === "timeout-draw" ? "Time forfeit" : g.status === "aborted" || g.status === "noStart" ? "Abandoned" : "Normal";
  const tags: [string, string][] = [
    ["Event", `${g.rated ? "Rated" : "Casual"} ${perfOf(g) === "ultrabullet" ? "UltraBullet" : "Bullet"} game`],
    ["Site", `${g.site}/game/${g.id}`],
    ["Date", date],
    ["UTCDate", date],
    ["UTCTime", time],
    ["White", g.white],
    ["Black", g.black],
    ["Result", result],
  ];
  if (g.whiteElo) tags.push(["WhiteElo", String(g.whiteElo)]);
  if (g.blackElo) tags.push(["BlackElo", String(g.blackElo)]);
  tags.push(["TimeControl", `${g.base}+${g.inc}`], ["Termination", termination]);
  const head = tags.map(([k, v]) => `[${k} "${v.replace(/["\\]/g, "")}"]`).join("\n");
  const parts: string[] = [];
  g.sans.forEach((san, i) => {
    if (i % 2 === 0) parts.push(`${i / 2 + 1}.`);
    parts.push(san);
    const ms = g.moveClocks[i];
    if (ms !== undefined) parts.push(`{ [%clk ${fmtClk(ms)}] }`);
  });
  parts.push(result);
  return `${head}\n\n${parts.join(" ")}\n`;
}

function fmtClk(ms: number): string {
  const t = Math.max(0, ms) / 1000;
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = (t % 60).toFixed(1);
  return `${h}:${String(m).padStart(2, "0")}:${s.padStart(4, "0")}`;
}
