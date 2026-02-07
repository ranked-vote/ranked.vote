/**
 * Core types for the election data pipeline.
 *
 * Ported from report_pipeline/src/model/election.rs and
 * report_pipeline/src/model/metadata.rs.
 */

// ---------- Candidate types ----------

export type CandidateId = number;

export type CandidateType = "Regular" | "WriteIn" | "QualifiedWriteIn";

export interface Candidate {
  name: string;
  candidate_type: CandidateType;
}

// ---------- Ballot types (pre-normalization) ----------

export type Choice =
  | { type: "vote"; candidate: CandidateId }
  | { type: "undervote" }
  | { type: "overvote" };

export interface Ballot {
  id: string;
  choices: Choice[];
}

// ---------- Normalized ballot (post-normalization) ----------

export interface NormalizedBallot {
  id: string;
  choices: CandidateId[];
  overvoted: boolean;
}

// ---------- Election types ----------

export interface Election {
  candidates: Candidate[];
  ballots: Ballot[];
}

export interface NormalizedElection {
  candidates: Candidate[];
  ballots: NormalizedBallot[];
}

// ---------- Metadata types ----------

export interface Jurisdiction {
  name: string;
  path: string;
  kind: string;
  offices: Record<string, { name: string }>;
  elections: Record<string, ElectionMetadata>;
}

export interface ElectionMetadata {
  name: string;
  date: string;
  dataFormat: string;
  tabulationOptions?: { eager?: boolean; nycStyle?: boolean } | null;
  normalization: string;
  contests: Contest[];
  files: Record<string, string>;
  website?: string | null;
}

export interface Contest {
  office: string;
  loaderParams?: Record<string, string>;
}

// ---------- Preprocessed output ----------

export interface ElectionInfo {
  name: string;
  date: string;
  dataFormat: string;
  tabulationOptions: { eager: boolean; nycStyle: boolean };
  jurisdictionPath: string;
  electionPath: string;
  office: string;
  officeName: string;
  jurisdictionName: string;
  electionName: string;
  loaderParams?: Record<string, string>;
  website?: string;
}

export interface ElectionPreprocessed {
  info: ElectionInfo;
  ballots: NormalizedElection;
}

// ---------- Format reader type ----------

export type BallotReader = (
  basePath: string,
  params: Record<string, string>
) => Election;

export type BatchBallotReader = (
  basePath: string,
  contests: Array<{ office: string; params: Record<string, string> }>
) => Map<string, Election>;
