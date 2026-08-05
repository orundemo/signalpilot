import { uuidFromPublicId, uuidToHex, type Uuid } from "@saas/db/ids";

/**
 * Public-id prefixes for the prospecting aggregate. Every id that crosses the
 * API boundary is `<prefix>_<32 hex>`; the bare UUID never leaves the worker.
 */
export const ID_PREFIXES = {
  org: "org",
  user: "usr",
  prospect: "prs",
  signal: "sig",
  discovery: "dsc",
  score: "scr",
  insight: "ins",
  scoringProfile: "spf",
  stage: "stg",
  pipelineEntry: "pen",
  activity: "act",
} as const;

export function generateRequestId(): string {
  const buf = new Uint8Array(12);
  crypto.getRandomValues(buf);
  let hex = "";
  for (let i = 0; i < buf.length; i++) {
    hex += buf[i]!.toString(16).padStart(2, "0");
  }
  return `req_${hex}`;
}

function publicId(prefix: string, uuid: string): string {
  return `${prefix}_${uuidToHex(uuid)}`;
}

export const orgPublicId = (uuid: string): string => publicId(ID_PREFIXES.org, uuid);
export const userPublicId = (uuid: string): string => publicId(ID_PREFIXES.user, uuid);
export const prospectPublicId = (uuid: string): string => publicId(ID_PREFIXES.prospect, uuid);
export const signalPublicId = (uuid: string): string => publicId(ID_PREFIXES.signal, uuid);
export const discoveryPublicId = (uuid: string): string => publicId(ID_PREFIXES.discovery, uuid);
export const scorePublicId = (uuid: string): string => publicId(ID_PREFIXES.score, uuid);
export const insightPublicId = (uuid: string): string => publicId(ID_PREFIXES.insight, uuid);
export const scoringProfilePublicId = (uuid: string): string => publicId(ID_PREFIXES.scoringProfile, uuid);
export const stagePublicId = (uuid: string): string => publicId(ID_PREFIXES.stage, uuid);
export const pipelineEntryPublicId = (uuid: string): string => publicId(ID_PREFIXES.pipelineEntry, uuid);
export const activityPublicId = (uuid: string): string => publicId(ID_PREFIXES.activity, uuid);

export const parseOrgPublicId = (value: string): Uuid | null => uuidFromPublicId(value, ID_PREFIXES.org);
export const parseUserPublicId = (value: string): Uuid | null => uuidFromPublicId(value, ID_PREFIXES.user);
export const parseProspectPublicId = (value: string): Uuid | null => uuidFromPublicId(value, ID_PREFIXES.prospect);
export const parsePipelineEntryPublicId = (value: string): Uuid | null =>
  uuidFromPublicId(value, ID_PREFIXES.pipelineEntry);
export const parseDiscoveryPublicId = (value: string): Uuid | null =>
  uuidFromPublicId(value, ID_PREFIXES.discovery);
