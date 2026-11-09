import { describe, expect, it } from "vitest";
import { randomId } from "../src/worker/ids";

describe("randomId", () => {
  it("always has the requested length and only unambiguous characters", () => {
    for (let i = 0; i < 20_000; i++) {
      const id = randomId(8);
      expect(id).toMatch(/^[A-Za-z0-9]{8}$/);
      expect(id).not.toMatch(/[0O1lI]/);
    }
  });
});
