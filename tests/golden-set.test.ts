import { describe, expect, it } from "vitest";
import { goldenSet } from "./fixtures/golden-set";

describe("evaluation dataset", () => {
  it("contains exactly 45 version-controlled cases across required risk classes", () => {
    expect(goldenSet).toHaveLength(45);
    expect(
      goldenSet.filter((item) => item.category === "retrieval"),
    ).toHaveLength(18);
    expect(
      goldenSet.filter((item) => item.category === "abstention"),
    ).toHaveLength(6);
    expect(
      goldenSet.filter((item) => item.category === "security"),
    ).toHaveLength(21);
    expect(new Set(goldenSet.map((item) => item.id)).size).toBe(45);
  });
});
