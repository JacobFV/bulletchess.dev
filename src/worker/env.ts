import type { GameRoom } from "./game";
import type { Lobby } from "./lobby";

export interface Env {
  ENVIRONMENT: "development" | "test" | "production";
  APP_ORIGIN: string;
  EMAIL_FROM: string;
  EMAIL_PROVIDER: "log" | "cloudflare" | "disabled";
  BETTER_AUTH_SECRET: string;
  DB: D1Database;
  LOBBY: DurableObjectNamespace<Lobby>;
  GAME: DurableObjectNamespace<GameRoom>;
  ASSETS: Fetcher;
  EMAIL?: SendEmail;
}
