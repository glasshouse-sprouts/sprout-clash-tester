// Tests for the filename-based discipline guesser.
//
// Each test pins a real-world or constructed filename to the discipline
// we want to come out. The goal is twofold:
//   1. Confirm we hit Danish AEC naming conventions (ARK, KON, VVS).
//   2. Confirm we don't hit common false positives (e.g. SELECTION → ELEC,
//      MODEL → ELEC, ADVENT → HVAC).

import { describe, it, expect } from "vitest";
import { inferDisciplineFromFilename } from "./discipline.js";

describe("inferDisciplineFromFilename — Danish AEC short codes", () => {
  it("ARK_… → ARCH", () => {
    expect(inferDisciplineFromFilename("ARK_Example_Housing.ifc")).toBe("ARCH");
    expect(inferDisciplineFromFilename("/abs/ARK-Terrain.ifc")).toBe("ARCH");
  });

  it("…-KON or _KON_ → STR", () => {
    expect(inferDisciplineFromFilename("NSA_K09_F2_N001-KON model.ifc")).toBe("STR");
    expect(inferDisciplineFromFilename("/abs/KON_top-level.ifc")).toBe("STR");
  });

  it("VVS_ → MEP", () => {
    expect(inferDisciplineFromFilename("VVS_main.ifc")).toBe("MEP");
    expect(inferDisciplineFromFilename("Building_VVS_pipes.ifc")).toBe("MEP");
  });

  it("BRAND → FIRE", () => {
    expect(inferDisciplineFromFilename("BRAND_sprinkler.ifc")).toBe("FIRE");
  });

  it("TERR / TERRAIN → GEO", () => {
    expect(inferDisciplineFromFilename("Site_TERRAIN.ifc")).toBe("GEO");
    expect(inferDisciplineFromFilename("TERR_North.ifc")).toBe("GEO");
  });
});

describe("inferDisciplineFromFilename — English long names", () => {
  it("STRUCTURAL → STR", () => {
    expect(inferDisciplineFromFilename("Building-Structural.ifc")).toBe("STR");
  });

  it("HVAC → HVAC", () => {
    expect(inferDisciplineFromFilename("Building-Hvac.ifc")).toBe("HVAC");
    expect(
      inferDisciplineFromFilename("HVAC_Example_Housing_Concrete.ifc"),
    ).toBe("HVAC");
  });

  it("STRUC_… → STR", () => {
    expect(inferDisciplineFromFilename("STRUC_Example_Housing.ifc")).toBe("STR");
  });

  it("ELE_… → ELEC", () => {
    expect(
      inferDisciplineFromFilename("ELE_Example_Housing_Concrete.ifc"),
    ).toBe("ELEC");
  });

  it("PLUMBING → MEP", () => {
    expect(inferDisciplineFromFilename("plumbing-mains.ifc")).toBe("MEP");
  });

  it("FIRE / SPRINKLER → FIRE", () => {
    expect(inferDisciplineFromFilename("FireProtection.ifc")).toBe("FIRE");
    expect(inferDisciplineFromFilename("Sprinkler-Layout.ifc")).toBe("FIRE");
  });
});

describe("inferDisciplineFromFilename — ARCH sub-disciplines", () => {
  it("ArchContext → ARCH_CONTEXT (more specific wins over plain ARCH)", () => {
    expect(inferDisciplineFromFilename("ArchContext.ifc")).toBe("ARCH_CONTEXT");
    expect(inferDisciplineFromFilename("ARCH_CONTEXT_Buildings.ifc")).toBe(
      "ARCH_CONTEXT",
    );
  });

  it("Arch + Furniture → ARCH_FURNITURE", () => {
    expect(inferDisciplineFromFilename("Architecture_Furniture.ifc")).toBe(
      "ARCH_FURNITURE",
    );
    expect(inferDisciplineFromFilename("ARCH-Furn-Set.ifc")).toBe(
      "ARCH_FURNITURE",
    );
  });
});

describe("inferDisciplineFromFilename — false-positive guards", () => {
  it("MODEL_*.ifc → UNKNOWN (no spurious ELEC from 'EL' substring)", () => {
    expect(inferDisciplineFromFilename("MODEL_view.ifc")).toBe("UNKNOWN");
    expect(inferDisciplineFromFilename("Model.ifc")).toBe("UNKNOWN");
  });

  it("SELECTION_*.ifc → UNKNOWN (no spurious ELEC)", () => {
    expect(inferDisciplineFromFilename("SELECTION_check.ifc")).toBe("UNKNOWN");
  });

  it("DISTRIBUTION_*.ifc → UNKNOWN (STR substring is part of bigger word)", () => {
    // DISTRIBUTION contains STR but not as a token-boundary match.
    expect(inferDisciplineFromFilename("DISTRIBUTION.ifc")).toBe("UNKNOWN");
  });
});

describe("inferDisciplineFromFilename — falls back to UNKNOWN", () => {
  it("totally generic name → UNKNOWN", () => {
    expect(inferDisciplineFromFilename("ProjectBaseline.ifc")).toBe("UNKNOWN");
    expect(inferDisciplineFromFilename("test123.ifc")).toBe("UNKNOWN");
  });

  it("absolute paths work the same as basenames", () => {
    expect(
      inferDisciplineFromFilename("/projects/x/Building-Hvac.ifc"),
    ).toBe("HVAC");
    expect(
      inferDisciplineFromFilename(
        "C:\\\\Users\\\\x\\\\Building-Structural.ifc",
      ),
    ).toBe("STR");
  });
});
