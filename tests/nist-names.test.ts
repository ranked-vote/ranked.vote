import { describe, expect, test } from "bun:test";
import { candidateName } from "../scripts/pipeline/formats/nist-sp-1500";

describe("nist candidate names", () => {
  test("default style title-cases all-caps names", () => {
    expect(candidateName("LONDON BREED")).toBe("London Breed");
  });

  test("asIs keeps capitalization and flips Last, First", () => {
    expect(candidateName("McDermott, James C. \"Jim\"", "asIs")).toBe(
      "James C. “Jim” McDermott",
    );
    expect(candidateName("Johnson, DeLena M.", "asIs")).toBe(
      "DeLena M. Johnson",
    );
    expect(candidateName("Sullivan, Daniel J. Jr.", "asIs")).toBe(
      "Daniel J. Sullivan Jr.",
    );
    expect(candidateName("Kreiss-Tomkins/Johnson", "asIs")).toBe(
      "Kreiss-Tomkins/Johnson",
    );
    expect(candidateName("Write-in", "asIs")).toBe("Write-in");
  });
});
