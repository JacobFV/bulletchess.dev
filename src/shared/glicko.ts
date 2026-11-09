/**
 * Glicko-2 (Glickman 2012), one game per rating period, with RD growth for inactivity.
 * Same parameters lichess uses for its fast pools (tau 0.75, RD floor 45, ceiling 500).
 */
export interface Rating {
  rating: number;
  rd: number;
  vol: number;
}

export const DEFAULT_RATING: Rating = { rating: 1500, rd: 350, vol: 0.06 };
const SCALE = 173.7178;
const TAU = 0.75;
const RD_MIN = 45;
const RD_MAX = 350;
const EPS = 1e-6;
/** One rating period per day of inactivity. */
const PERIOD_MS = 86_400_000;

/** Pre-game RD inflation for time since the last rated game. */
export function inflateRd(r: Rating, lastPlayedAt: number | null, now: number): Rating {
  if (lastPlayedAt === null || lastPlayedAt === undefined) return r;
  const periods = Math.max(0, (now - lastPlayedAt) / PERIOD_MS);
  const phi = r.rd / SCALE;
  const phiStar = Math.sqrt(phi * phi + periods * r.vol * r.vol);
  return { ...r, rd: Math.min(RD_MAX, phiStar * SCALE) };
}

const g = (phi: number) => 1 / Math.sqrt(1 + (3 * phi * phi) / (Math.PI * Math.PI));
const E = (mu: number, muj: number, phij: number) => 1 / (1 + Math.exp(-g(phij) * (mu - muj)));

/** score: 1 win, 0.5 draw, 0 loss (from `player`'s perspective). */
export function updateRating(player: Rating, opponent: Rating, score: number): Rating {
  const mu = (player.rating - 1500) / SCALE;
  const phi = player.rd / SCALE;
  const muj = (opponent.rating - 1500) / SCALE;
  const phij = opponent.rd / SCALE;
  const gj = g(phij);
  const ej = E(mu, muj, phij);
  const v = 1 / (gj * gj * ej * (1 - ej));
  const delta = v * gj * (score - ej);

  // Volatility (Illinois algorithm).
  const a = Math.log(player.vol * player.vol);
  const f = (x: number) => {
    const ex = Math.exp(x);
    return (ex * (delta * delta - phi * phi - v - ex)) / (2 * Math.pow(phi * phi + v + ex, 2)) - (x - a) / (TAU * TAU);
  };
  let A = a;
  let B: number;
  if (delta * delta > phi * phi + v) B = Math.log(delta * delta - phi * phi - v);
  else {
    let k = 1;
    while (f(a - k * TAU) < 0) k++;
    B = a - k * TAU;
  }
  let fA = f(A);
  let fB = f(B);
  for (let i = 0; i < 100 && Math.abs(B - A) > EPS; i++) {
    const C = A + ((A - B) * fA) / (fB - fA);
    const fC = f(C);
    if (fC * fB <= 0) {
      A = B;
      fA = fB;
    } else fA /= 2;
    B = C;
    fB = fC;
  }
  const vol = Math.exp(A / 2);
  const phiStar = Math.sqrt(phi * phi + vol * vol);
  const phiNew = 1 / Math.sqrt(1 / (phiStar * phiStar) + 1 / v);
  const muNew = mu + phiNew * phiNew * gj * (score - ej);
  return {
    rating: Math.max(400, Math.min(4000, muNew * SCALE + 1500)),
    rd: Math.max(RD_MIN, Math.min(RD_MAX, phiNew * SCALE)),
    vol: Math.min(0.1, vol),
  };
}

/** A rating is provisional while RD is high. */
export function isProvisional(r: Pick<Rating, "rd">): boolean {
  return r.rd > 110;
}
