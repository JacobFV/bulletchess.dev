/** Time controls. Everything on this site is bullet or faster (estimated duration ≤ 180 s). */

export type Perf = "ultrabullet" | "bullet";
export const PERFS: readonly Perf[] = ["bullet", "ultrabullet"] as const;
export const PERF_LABEL: Record<Perf, string> = { bullet: "Bullet", ultrabullet: "UltraBullet" };

export interface TimeControl {
  /** Initial time in seconds. */
  base: number;
  /** Increment in seconds. */
  inc: number;
}

/** Matchmaking pools. Ids are stable and used in URLs, storage and the queue. */
export const POOLS = [
  { id: "15+0", base: 15, inc: 0 },
  { id: "30+0", base: 30, inc: 0 },
  { id: "1+0", base: 60, inc: 0 },
  { id: "1+1", base: 60, inc: 1 },
  { id: "2+0", base: 120, inc: 0 },
  { id: "2+1", base: 120, inc: 1 },
] as const satisfies readonly ({ id: string } & TimeControl)[];

export type PoolId = (typeof POOLS)[number]["id"];

export const ALLOWED_BASES = [15, 30, 45, 60, 90, 120, 150, 180] as const;
export const ALLOWED_INCS = [0, 1, 2] as const;

/** Lichess-style estimate: base + 40 × increment. */
export function estimatedSeconds(tc: TimeControl): number {
  return tc.base + 40 * tc.inc;
}

export function isValidTimeControl(tc: TimeControl): boolean {
  return (
    (ALLOWED_BASES as readonly number[]).includes(tc.base) &&
    (ALLOWED_INCS as readonly number[]).includes(tc.inc) &&
    estimatedSeconds(tc) <= 180
  );
}

export function perfOf(tc: TimeControl): Perf {
  return estimatedSeconds(tc) < 30 ? "ultrabullet" : "bullet";
}

export function poolById(id: string) {
  return POOLS.find((p) => p.id === id);
}

export function tcLabel(tc: TimeControl): string {
  const base = tc.base % 60 === 0 ? String(tc.base / 60) : tc.base === 15 ? "¼" : tc.base === 30 ? "½" : tc.base === 45 ? "¾" : tc.base === 90 ? "1½" : tc.base === 150 ? "2½" : `${tc.base}s`;
  return `${base}+${tc.inc}`;
}

/** Time allowed for each side to make its first move before the game is aborted. */
export function firstMoveMs(tc: TimeControl): number {
  return Math.max(10_000, Math.min(20_000, tc.base * 1000));
}
