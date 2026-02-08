/**
 * Format reader dispatch.
 *
 * Ported from report_pipeline/src/formats/mod.rs.
 */

import type { BallotReader, Election } from "../types";
import { jsonReader } from "./simple-json";
import { preflibReader } from "./preflib";
import { btvReader } from "./us-vt-btv";
import { sfoReader } from "./us-ca-sfo";
import { dominionRcrReader } from "./dominion-rcr";
import { maineReader } from "./us-me";
import { mplsReader } from "./us-mn-mpls";
import { nistReader } from "./nist-sp-1500";

// Batch readers are exported separately since they have different signatures
export { nistBatchReader } from "./nist-sp-1500";
export { nycBatchReader } from "./us-ny-nyc";

const readers: Record<string, BallotReader> = {
  simple_json: jsonReader,
  preflib: preflibReader,
  us_vt_btv: btvReader,
  us_ca_sfo: sfoReader,
  dominion_rcr: dominionRcrReader,
  us_me: maineReader,
  us_mn_mpls: mplsReader,
  nist_sp_1500: nistReader,
  // us_ny_nyc uses batch reader exclusively
};

export function getReaderForFormat(format: string): BallotReader {
  const reader = readers[format];
  if (!reader) {
    if (format === "us_ny_nyc") {
      throw new Error(
        "NYC format must use batch reader (nycBatchReader), not single-contest reader",
      );
    }
    throw new Error(
      `Format "${format}" is not implemented in JS. ` +
        `Available: ${Object.keys(readers).join(", ")}`,
    );
  }
  return reader;
}

export function readElection(
  format: string,
  basePath: string,
  params: Record<string, string>,
): Election | Promise<Election> {
  return getReaderForFormat(format)(basePath, params);
}

export function isFormatSupported(format: string): boolean {
  return format in readers || format === "us_ny_nyc";
}
