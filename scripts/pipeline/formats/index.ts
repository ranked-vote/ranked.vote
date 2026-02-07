/**
 * Format reader dispatch.
 *
 * Ported from report_pipeline/src/formats/mod.rs.
 */

import type { BallotReader } from "../types";
import { jsonReader } from "./simple-json";

const readers: Record<string, BallotReader> = {
  simple_json: jsonReader,
};

export function getReaderForFormat(format: string): BallotReader {
  const reader = readers[format];
  if (!reader) {
    throw new Error(
      `Format "${format}" is not implemented in JS. ` +
        `Available: ${Object.keys(readers).join(", ")}`
    );
  }
  return reader;
}

export function readElection(
  format: string,
  basePath: string,
  params: Record<string, string>
) {
  return getReaderForFormat(format)(basePath, params);
}

export function isFormatSupported(format: string): boolean {
  return format in readers;
}
