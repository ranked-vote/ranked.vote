import { describe, expect, test } from "bun:test";
import { CandidateMap } from "../scripts/pipeline/candidate-map";
import {
  isInvalidContest,
  marksToChoices,
} from "../scripts/pipeline/formats/nist-sp-1500";
import { maineNormalizer } from "../scripts/pipeline/normalizers/maine";

function candidates() {
  const map = new CandidateMap<number>();
  map.add(10, { name: "A", candidate_type: "Regular" });
  map.add(20, { name: "B", candidate_type: "Regular" });
  map.add(30, { name: "C", candidate_type: "Regular" });
  return map;
}

const mark = (CandidateId: number, Rank: number, IsAmbiguous = false) => ({
  CandidateId,
  Rank,
  MarkDensity: 100,
  IsAmbiguous,
  IsVote: Rank === 1,
});

describe("nist ballot marks", () => {
  test("skipped ranks become undervotes", () => {
    const choices = marksToChoices([mark(20, 2), mark(30, 4)], candidates(), null);
    expect(choices.map((c) => c.type)).toEqual([
      "undervote",
      "vote",
      "undervote",
      "vote",
    ]);
  });

  test("two skipped ranks in a row end the ballot under the maine rules", () => {
    const choices = marksToChoices([mark(10, 1), mark(20, 4)], candidates(), null);
    const normalized = maineNormalizer({ id: "x", choices });
    expect(normalized.choices).toHaveLength(1);
  });

  test("ambiguous marks are ignored and two marks at a rank are an overvote", () => {
    const choices = marksToChoices(
      [mark(10, 1, true), mark(20, 2), mark(30, 2)],
      candidates(),
      null,
    );
    expect(choices.map((c) => c.type)).toEqual(["undervote", "overvote"]);
  });

  test("contests flagged InvalidContest are detected", () => {
    const invalid = new Set([7]);
    expect(
      isInvalidContest({ Id: 1, Marks: [], OutstackConditionIds: [7] }, invalid),
    ).toBe(true);
    expect(
      isInvalidContest({ Id: 1, Marks: [], OutstackConditionIds: [14] }, invalid),
    ).toBe(false);
    expect(isInvalidContest({ Id: 1, Marks: [] }, invalid)).toBe(false);
  });

  test("redacted contests are not treated as invalid", () => {
    expect(
      isInvalidContest(
        {
          Id: 1,
          Marks: "*** REDACTED ***",
          OutstackConditionIds: "*** REDACTED ***",
        },
        new Set([7]),
      ),
    ).toBe(false);
  });
});
