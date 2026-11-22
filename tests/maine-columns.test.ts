import { describe, expect, test } from "bun:test";
import { columnLayout } from "../scripts/pipeline/formats/us-me";

describe("maine column layout", () => {
  test("finds ID and choice columns in a full Dominion export", () => {
    const header = [
      "Election ID",
      "Audit Number",
      "Tabulator CVR",
      "Cast Vote Record",
      "Batch",
      "Ballot Status",
      "Precinct",
      "Ballot Style",
      "Rep. to Congress 1st Choice District 2",
      "Rep. to Congress 2nd Choice District 2",
      "Rep. to Congress 3rd Choice District 2",
    ];
    expect(columnLayout(header)).toEqual({ idCol: 3, choiceCols: [8, 9, 10] });
  });

  test("handles the short export used in earlier elections", () => {
    const header = [
      "Cast Vote Record",
      "Precinct",
      "Ballot Style",
      "DEM Rep. to Congress 1st Choice District 2",
      "DEM Rep. to Congress 2nd Choice District 2",
    ];
    expect(columnLayout(header)).toEqual({ idCol: 0, choiceCols: [3, 4] });
  });

  test("falls back to fixed columns without choice headers", () => {
    expect(columnLayout(["a", "b", "c"])).toEqual({
      idCol: 0,
      choiceCols: [3, 4, 5, 6, 7, 8, 9],
    });
  });
});
