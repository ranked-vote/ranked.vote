import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  candidateInfo,
  clearBallotReader,
  parseChoiceHeader,
} from "../scripts/pipeline/formats/clear-ballot";

const col = (id: number, rank: number, name: string) =>
  `"Choice_${id}_1:City of Portland, Mayor:${rank}:Number of Winners 1:${name}:NON"`;

function writeCvr(rows: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "clear-ballot-"));
  const header = [
    '"RowNumber"',
    '"BallotID"',
    col(1, 1, "Ann"),
    col(1, 2, "Ann"),
    col(2, 1, "Bob"),
    col(2, 2, "Bob"),
    col(118, 1, "Write-in-118"),
    col(118, 2, "Write-in-118"),
  ].join(",");
  writeFileSync(join(dir, "cvr.csv"), [header, ...rows].join("\n") + "\n");
  return dir;
}

describe("clear ballot reader", () => {
  test("parses choice headers", () => {
    expect(
      parseChoiceHeader(col(3, 2, "Keith Wilson").slice(1, -1), 7),
    ).toEqual({
      index: 7,
      contest: "City of Portland, Mayor",
      rank: 2,
      candidate: "Keith Wilson",
    });
    expect(parseChoiceHeader("BallotID", 1)).toBeNull();
  });

  test("groups write-in columns", () => {
    expect(candidateInfo("Write-in-118").candidate_type).toBe("WriteIn");
    expect(candidateInfo("Uncertified Write In").name).toBe("Write-in");
    expect(candidateInfo("Keith Wilson").candidate_type).toBe("Regular");
  });

  test("reads ranks and handles overvotes", () => {
    const dir = writeCvr([
      // Ann 1st, Bob 2nd
      '1,"A",1,0,0,1,0,0',
      // Ann and Bob both 1st, write-in 2nd
      '2,"B",1,0,1,0,0,1',
      // blank
      '3,"C",0,0,0,0,0,0',
    ]);
    const exhaust = clearBallotReader(dir, { file: "cvr.csv" });
    const names = exhaust.candidates.map((c) => c.name);
    expect(names).toEqual(["Ann", "Bob", "Write-in"]);
    expect(exhaust.ballots.map((b) => b.id)).toEqual(["A", "B", "C"]);
    expect(exhaust.ballots[0].choices).toEqual([
      { type: "vote", candidate: 0 },
      { type: "vote", candidate: 1 },
    ]);
    expect(exhaust.ballots[1].choices[0]).toEqual({ type: "overvote" });
    expect(exhaust.ballots[2].choices).toEqual([
      { type: "undervote" },
      { type: "undervote" },
    ]);

    const skip = clearBallotReader(dir, { file: "cvr.csv", overvote: "skip" });
    expect(skip.ballots[1].choices).toEqual([
      { type: "undervote" },
      { type: "vote", candidate: 2 },
    ]);
  });
});
