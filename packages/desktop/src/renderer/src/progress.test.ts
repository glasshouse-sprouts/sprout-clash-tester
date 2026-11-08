// Tests for the engine-progress parser.

import { describe, it, expect } from "vitest";
import {
  applyProgressLine,
  elapsedSeconds,
  freshProgress,
  shortStatus,
} from "./progress";

describe("applyProgressLine", () => {
  it("bumps currentRule on a Rule header", () => {
    let p = freshProgress(3);
    p = applyProgressLine(p, "── Rule: HVACxSTR ─────────────────────────────");
    expect(p.currentRule).toEqual({ name: "HVACxSTR", index: 1 });
    p = applyProgressLine(p, "── Rule: MEPxSTR ─────────────────────────────");
    expect(p.currentRule).toEqual({ name: "MEPxSTR", index: 2 });
  });

  it("captures pair progress lines", () => {
    let p = freshProgress(1);
    p = applyProgressLine(p, "── Rule: X ──");
    p = applyProgressLine(p, "  progress: 5000/100000 pairs");
    expect(p.pairs).toEqual({ done: 5000, total: 100000 });
  });

  it("resets pairs when a rule finishes", () => {
    let p = freshProgress(1);
    p = applyProgressLine(p, "── Rule: X ──");
    p = applyProgressLine(p, "  progress: 5000/100000 pairs");
    p = applyProgressLine(p, "  → 42 clash(es) found");
    expect(p.pairs).toBeNull();
  });

  it("appends every line to recentLines but caps at 200", () => {
    let p = freshProgress(1);
    for (let i = 0; i < 250; i++) {
      p = applyProgressLine(p, `line ${i}`);
    }
    expect(p.recentLines).toHaveLength(200);
    expect(p.recentLines[0]).toBe("line 50");
    expect(p.recentLines[199]).toBe("line 249");
  });

  it("doesn't crash on garbage lines", () => {
    let p = freshProgress(0);
    p = applyProgressLine(p, "random unrelated output");
    p = applyProgressLine(p, "");
    p = applyProgressLine(p, "─────────");
    expect(p.currentRule).toBeNull();
    expect(p.pairs).toBeNull();
  });
});

describe("shortStatus", () => {
  it("says Loading… before the first rule", () => {
    expect(shortStatus(freshProgress(3))).toBe("Loading…");
  });

  it("shows N/M with rule name once we know it", () => {
    let p = freshProgress(3);
    p = applyProgressLine(p, "── Rule: HVACxSTR ──");
    expect(shortStatus(p)).toBe("Rule 1/3: HVACxSTR");
  });

  it("appends a percentage when pair progress is known", () => {
    let p = freshProgress(3);
    p = applyProgressLine(p, "── Rule: HVACxSTR ──");
    p = applyProgressLine(p, "  progress: 25/100 pairs");
    expect(shortStatus(p)).toBe("Rule 1/3: HVACxSTR (25%)");
  });

  it("works when totalRules is unknown (0)", () => {
    let p = freshProgress(0);
    p = applyProgressLine(p, "── Rule: X ──");
    expect(shortStatus(p)).toBe("Rule: X");
  });
});

describe("elapsedSeconds", () => {
  it("returns 0 when called at startedAt", () => {
    const p = freshProgress(1);
    expect(elapsedSeconds(p, p.startedAt)).toBe(0);
  });

  it("returns the time difference in seconds", () => {
    const p = freshProgress(1);
    expect(elapsedSeconds(p, p.startedAt + 5_000)).toBe(5);
  });
});
