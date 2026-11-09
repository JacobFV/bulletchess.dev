/** WebSocket protocol between the browser and the Lobby / Game Durable Objects. */
import type { Perf, PoolId } from "./tc";

export type Color = "white" | "black";

export type GameStatus =
  | "waiting" // challenge created, opponent not seated
  | "started"
  | "aborted"
  | "mate"
  | "resign"
  | "timeout"
  | "stalemate"
  | "draw" // agreement
  | "repetition"
  | "fifty"
  | "insufficient"
  | "timeout-draw" // flagged, but the opponent cannot mate
  | "noStart"; // a player never made a first move

export const FINISHED: readonly GameStatus[] = ["aborted", "mate", "resign", "timeout", "stalemate", "draw", "repetition", "fifty", "insufficient", "timeout-draw", "noStart"];

export interface PlayerInfo {
  id: string;
  username: string;
  rating: number;
  provisional: boolean;
  /** Present after the game ends for rated games. */
  ratingDiff?: number;
}

export interface GameView {
  id: string;
  status: GameStatus;
  winner: Color | null;
  rated: boolean;
  perf: Perf;
  base: number;
  inc: number;
  white: PlayerInfo | null;
  black: PlayerInfo | null;
  /** UCI moves. */
  moves: string[];
  /** SAN moves. */
  sans: string[];
  fen: string;
  /** Remaining ms at the moment `serverNow` was taken. */
  clocks: { white: number; black: number };
  /** True if the side to move's clock is running. */
  running: boolean;
  /** Deadline (server epoch ms) for the first move of the side to move, while ply < 2. */
  firstMoveDeadline: number | null;
  serverNow: number;
  drawOffer: Color | null;
  rematchOffer: Color | null;
  rematchId: string | null;
  /** Your color, if you are seated. */
  you: Color | null;
  online: { white: boolean; black: boolean };
  spectators: number;
  source: GameSource;
  /** Challenge: creator's preferred color (for the waiting screen). */
  creatorColor?: "white" | "black" | "random";
}

export type ClientGameMsg =
  | { t: "move"; u: string; ply: number }
  | { t: "resign" }
  | { t: "abort" }
  | { t: "draw-offer" }
  | { t: "draw-accept" }
  | { t: "draw-decline" }
  | { t: "rematch-offer" }
  | { t: "rematch-decline" }
  | { t: "join" }
  | { t: "ping"; c: number }
  | { t: "pong"; s: number };

export type ServerGameMsg =
  | { t: "state"; g: GameView }
  | { t: "move"; u: string; san: string; ply: number; fen: string; clocks: { white: number; black: number }; serverNow: number; running: boolean; firstMoveDeadline: number | null }
  | { t: "end"; g: GameView }
  | { t: "offers"; drawOffer: Color | null; rematchOffer: Color | null }
  | { t: "rematch"; id: string }
  | { t: "presence"; online: { white: boolean; black: boolean }; spectators: number }
  | { t: "pong"; c: number; s: number }
  | { t: "ping"; s: number }
  | { t: "error"; message: string };

export type GameSource = "pool" | "challenge" | "rematch" | "direct" | "open" | "scheduled";

export interface ChallengeUser {
  id: string;
  username: string;
  rating: number;
  provisional: boolean;
}

export interface ChallengeView {
  id: string;
  from: ChallengeUser;
  /** null: open to anyone. */
  to: ChallengeUser | null;
  acceptedBy: ChallengeUser | null;
  base: number;
  inc: number;
  rated: boolean;
  /** The challenger's color. */
  color: "white" | "black" | "random";
  status: "pending" | "accepted" | "started" | "declined" | "cancelled" | "expired";
  /** null: on demand (starts as soon as it is accepted). */
  scheduledAt: number | null;
  expiresAt: number;
  gameId: string | null;
  createdAt: number;
}

export interface OnlinePlayer {
  id: string;
  username: string;
  rating: number;
  provisional: boolean;
  status: "idle" | "seeking" | "playing";
  gameId: string | null;
  acceptsChallenges: boolean;
}

export type ClientLobbyMsg = { t: "seek"; pool: PoolId } | { t: "cancel" } | { t: "ping" };
export type ServerLobbyMsg =
  | { t: "hello"; players: number; games: number; pools: Record<string, number> }
  | { t: "stats"; players: number; games: number; pools: Record<string, number> }
  | { t: "seeking"; pool: PoolId; since: number }
  | { t: "cancelled" }
  | { t: "start"; id: string }
  | { t: "error"; message: string }
  | { t: "pong" }
  /** A new incoming challenge (show a notification). */
  | { t: "challenge"; c: ChallengeView }
  /** Something about your challenges changed; refetch. `note` is a short human message. */
  | { t: "challenges"; note?: string };

export interface LiveGame {
  id: string;
  white: PlayerInfo;
  black: PlayerInfo;
  base: number;
  inc: number;
  rated: boolean;
  startedAt: number;
}
