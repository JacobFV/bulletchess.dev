import { describe, expect, it } from "vitest";
import { DEFAULT_RATING, inflateRd, updateRating } from "../src/shared/glicko";

describe("Glicko-2", () => {
  it("matches Glickman's worked example direction and magnitude", () => {
    // Glickman (2012) example uses tau 0.5 and three games; with one game we check sanity.
    const p = { rating: 1500, rd: 200, vol: 0.06 };
    const o = { rating: 1400, rd: 30, vol: 0.06 };
    const won = updateRating(p, o, 1);
    const lost = updateRating(p, o, 0);
    expect(won.rating).toBeGreaterThan(1500);
    expect(lost.rating).toBeLessThan(1500);
    expect(won.rd).toBeLessThan(200);
    expect(won.rating - 1500).toBeLessThan(1500 - lost.rating); // beating a weaker player gains less
  });

  it("new players move a lot, established ones little", () => {
    const fresh = updateRating(DEFAULT_RATING, DEFAULT_RATING, 1);
    const est = updateRating({ rating: 1500, rd: 50, vol: 0.06 }, { rating: 1500, rd: 50, vol: 0.06 }, 1);
    expect(fresh.rating - 1500).toBeGreaterThan(150);
    expect(est.rating - 1500).toBeLessThan(10);
  });

  it("is symmetric for a draw between equals", () => {
    const a = updateRating(DEFAULT_RATING, DEFAULT_RATING, 0.5);
    expect(Math.abs(a.rating - 1500)).toBeLessThan(1e-6);
  });

  it("inflates RD with inactivity, capped", () => {
    const r = { rating: 1800, rd: 60, vol: 0.06 };
    expect(inflateRd(r, 0, 0).rd).toBeCloseTo(60);
    expect(inflateRd(r, 0, 30 * 86400_000).rd).toBeGreaterThan(60);
    expect(inflateRd(r, 0, 1e13).rd).toBe(350);
  });
});
