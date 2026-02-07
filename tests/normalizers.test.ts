/**
 * Tests for ballot normalizers.
 * Ported from the Rust unit tests in report_pipeline/src/normalizers/.
 */

import { describe, test, expect } from "bun:test";
import { simpleNormalizer } from "../scripts/pipeline/normalizers/simple";
import { maineNormalizer } from "../scripts/pipeline/normalizers/maine";
import { nycNormalizer } from "../scripts/pipeline/normalizers/nyc";
import type { Ballot, Choice } from "../scripts/pipeline/types";

function vote(c: number): Choice {
  return { type: "vote", candidate: c };
}
const undervote: Choice = { type: "undervote" };
const overvote: Choice = { type: "overvote" };

function ballot(id: string, choices: Choice[]): Ballot {
  return { id, choices };
}

// ---------- Simple normalizer ----------

describe("simple normalizer", () => {
  test("pass through", () => {
    const b = ballot("1", [vote(1), vote(2), vote(3)]);
    const n = simpleNormalizer(b);
    expect(n.choices).toEqual([1, 2, 3]);
    expect(n.overvoted).toBe(false);
    expect(n.id).toBe("1");
  });

  test("remove duplicate", () => {
    const b = ballot("1", [vote(1), vote(2), vote(1)]);
    const n = simpleNormalizer(b);
    expect(n.choices).toEqual([1, 2]);
    expect(n.overvoted).toBe(false);
  });

  test("remove multiple duplicates", () => {
    const b = ballot("1", [vote(1), vote(1), vote(1), vote(1)]);
    const n = simpleNormalizer(b);
    expect(n.choices).toEqual([1]);
    expect(n.overvoted).toBe(false);
  });

  test("undervote ignored", () => {
    const b = ballot("1", [vote(1), undervote, vote(2)]);
    const n = simpleNormalizer(b);
    expect(n.choices).toEqual([1, 2]);
    expect(n.overvoted).toBe(false);
  });

  test("overvote stops processing", () => {
    const b = ballot("1", [vote(1), overvote, vote(2)]);
    const n = simpleNormalizer(b);
    expect(n.choices).toEqual([1]);
    expect(n.overvoted).toBe(true);
  });
});

// ---------- Maine normalizer ----------

describe("maine normalizer", () => {
  test("pass through", () => {
    const b = ballot("1", [vote(1), vote(2), vote(3)]);
    const n = maineNormalizer(b);
    expect(n.choices).toEqual([1, 2, 3]);
    expect(n.overvoted).toBe(false);
  });

  test("remove duplicate", () => {
    const b = ballot("1", [vote(1), vote(2), vote(1)]);
    const n = maineNormalizer(b);
    expect(n.choices).toEqual([1, 2]);
    expect(n.overvoted).toBe(false);
  });

  test("remove multiple duplicates", () => {
    const b = ballot("1", [vote(1), vote(1), vote(1), vote(1)]);
    const n = maineNormalizer(b);
    expect(n.choices).toEqual([1]);
    expect(n.overvoted).toBe(false);
  });

  test("single undervote allowed", () => {
    const b = ballot("1", [vote(1), undervote, vote(2)]);
    const n = maineNormalizer(b);
    expect(n.choices).toEqual([1, 2]);
    expect(n.overvoted).toBe(false);
  });

  test("overvote stops processing", () => {
    const b = ballot("1", [vote(1), overvote, vote(2)]);
    const n = maineNormalizer(b);
    expect(n.choices).toEqual([1]);
    expect(n.overvoted).toBe(true);
  });

  test("two sequential skipped rankings exhaust ballot", () => {
    const b = ballot("1", [vote(1), undervote, undervote, vote(2)]);
    const n = maineNormalizer(b);
    expect(n.choices).toEqual([1]);
    expect(n.overvoted).toBe(false);
  });

  test("two non-sequential skipped rankings allowed", () => {
    const b = ballot("1", [vote(1), undervote, vote(2), undervote, vote(3)]);
    const n = maineNormalizer(b);
    expect(n.choices).toEqual([1, 2, 3]);
    expect(n.overvoted).toBe(false);
  });
});

// ---------- NYC normalizer ----------

describe("nyc normalizer", () => {
  test("pass through", () => {
    const b = ballot("1", [vote(1), vote(2), vote(3)]);
    const n = nycNormalizer(b);
    expect(n).not.toBeNull();
    expect(n!.choices).toEqual([1, 2, 3]);
    expect(n!.overvoted).toBe(false);
  });

  test("undervote only returns null", () => {
    const b = ballot("1", [undervote, undervote]);
    expect(nycNormalizer(b)).toBeNull();
  });

  test("overvote only returns null", () => {
    const b = ballot("1", [overvote]);
    expect(nycNormalizer(b)).toBeNull();
  });

  test("mixed undervote preserved", () => {
    const b = ballot("1", [vote(1), undervote, vote(2)]);
    const n = nycNormalizer(b);
    expect(n).not.toBeNull();
    expect(n!.choices).toEqual([1, 2]);
    expect(n!.overvoted).toBe(false);
  });

  test("overvote with valid votes", () => {
    const b = ballot("1", [vote(1), overvote, vote(2)]);
    const n = nycNormalizer(b);
    expect(n).not.toBeNull();
    expect(n!.choices).toEqual([1]);
    expect(n!.overvoted).toBe(true);
  });
});
