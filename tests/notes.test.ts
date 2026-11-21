import { describe, expect, test } from "bun:test";
import { reportNotes } from "../scripts/pipeline/notes";

describe("reportNotes", () => {
  test("returns null when there are no notes", () => {
    expect(reportNotes({}, {})).toBeNull();
    expect(reportNotes({ notes: null }, { notes: "  " })).toBeNull();
  });

  test("uses whichever level is set", () => {
    expect(reportNotes({ notes: "Election." }, {})).toBe("Election.");
    expect(reportNotes({}, { notes: "Contest." })).toBe("Contest.");
  });

  test("puts election notes before contest notes", () => {
    expect(reportNotes({ notes: "Election." }, { notes: " Contest. " })).toBe(
      "Election. Contest.",
    );
  });
});
