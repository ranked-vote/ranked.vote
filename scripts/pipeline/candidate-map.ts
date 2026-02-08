/**
 * CandidateMap: maps external candidate identifiers to internal CandidateIds.
 *
 * Ported from report_pipeline/src/formats/common/candidate_map.rs.
 * Used by format parsers to build a consistent candidate list.
 */

import type { Candidate, CandidateId, CandidateType, Choice } from "./types";

export class CandidateMap<ExternalId extends string | number> {
  private idToIndex = new Map<ExternalId, CandidateId>();
  private candidates: Candidate[] = [];

  add(externalId: ExternalId, candidate: Candidate): void {
    this.idToIndex.set(externalId, this.candidates.length);
    this.candidates.push(candidate);
  }

  /**
   * Map an external candidate ID to a Choice, creating the candidate if needed.
   * If a candidate with the same name already exists, reuses that index.
   */
  addIdToChoice(externalId: ExternalId, candidate: Candidate): Choice {
    if (!this.idToIndex.has(externalId)) {
      // Check if a candidate with the same name already exists
      const existingIndex = this.candidates.findIndex(
        (c) => c.name === candidate.name,
      );
      if (existingIndex >= 0) {
        this.idToIndex.set(externalId, existingIndex);
      } else {
        this.add(externalId, candidate);
      }
    }
    return this.idToChoice(externalId);
  }

  idToChoice(externalId: ExternalId): Choice {
    const index = this.idToIndex.get(externalId);
    if (index === undefined) {
      throw new Error(
        `Candidate on ballot but not in master lookup: ${externalId}`,
      );
    }
    return { type: "vote", candidate: index };
  }

  intoCandidates(): Candidate[] {
    return this.candidates;
  }
}
