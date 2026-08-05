/**
 * Prospecting contract types.
 *
 * The public shapes for the `prospecting` product bounded context: prospects,
 * signals, scores, insights, pipeline, activities, and discovery runs.
 *
 * Two invariants are encoded here rather than left to prose:
 *
 *  - **Signals never carry a raw payload.** `SignalFeatures` is a map of
 *    scalars/enums, and `sourceDigest` is a 64-char hex sha256 of the document
 *    the observation was derived from. The document itself is dropped
 *    in-request.
 *  - **Scores are explainable.** A `PublicScore` always carries the ruleset
 *    version, the profile version, and one `ScoreContribution` per counted
 *    signal. There is no shape in which a score arrives without its reasons.
 *
 * No provider credentials, tokens, or personal contact data appear in any
 * shape in this module — v1 handles business records only.
 */

// ---------------------------------------------------------------------------
// Signal catalog (ruleset v1)
// ---------------------------------------------------------------------------

/** The ruleset version implemented by the current `engine/scoring.ts`. */
export const PROSPECTING_RULESET_VERSION = 1;

/**
 * The observable weaknesses ruleset v1 knows how to price. Adding a kind is a
 * ruleset version bump — a code change with a migration-free deploy.
 */
export const SIGNAL_KINDS = [
  "site_missing",
  "tls_missing",
  "perf_poor",
  "mobile_unfriendly",
  "booking_absent",
  "analytics_absent",
  "content_stale",
  "reviews_thin",
] as const;

export type SignalKind = (typeof SIGNAL_KINDS)[number];

/** Default points per signal kind before any per-org weight override. */
export const DEFAULT_SIGNAL_WEIGHTS: Readonly<Record<SignalKind, number>> = {
  site_missing: 30,
  tls_missing: 25,
  perf_poor: 20,
  mobile_unfriendly: 18,
  booking_absent: 20,
  analytics_absent: 8,
  content_stale: 12,
  reviews_thin: 5,
};

/** Adapter-assigned confidence/impact, 1 (weak) … 5 (unambiguous). */
export type SignalSeverity = 1 | 2 | 3 | 4 | 5;

/**
 * Derived observation values. Scalars and enums only — never a fetched
 * document, never a provider response body, never contact data.
 */
export type SignalFeatures = Record<string, string | number | boolean | null>;

export const SIZE_BANDS = ["micro", "small", "medium", "large", "unknown"] as const;
export type SizeBand = (typeof SIZE_BANDS)[number];

export const SCORE_BANDS = ["hot", "warm", "cold"] as const;
export type ScoreBand = (typeof SCORE_BANDS)[number];

/** Score → band thresholds. `hot` at ≥70, `warm` at ≥40, `cold` below. */
export const SCORE_BAND_THRESHOLDS = { hot: 70, warm: 40 } as const;

// ---------------------------------------------------------------------------
// Prospects
// ---------------------------------------------------------------------------

export interface PublicProspect {
  id: string;
  orgId: string;
  name: string;
  domain: string | null;
  industry: string | null;
  locality: string | null;
  region: string | null;
  country: string | null;
  sizeBand: SizeBand;
  source: string;
  status: "active" | "archived";
  firstSeenAt: string;
  lastEnrichedAt: string | null;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
  /** Newest score for this prospect, when one has been computed. */
  currentScore: PublicScore | null;
}

export interface CreateProspectRequest {
  name: string;
  domain?: string | null;
  industry?: string | null;
  locality?: string | null;
  region?: string | null;
  country?: string | null;
  sizeBand?: SizeBand;
}

export interface UpdateProspectRequest {
  name?: string;
  domain?: string | null;
  industry?: string | null;
  locality?: string | null;
  region?: string | null;
  country?: string | null;
  sizeBand?: SizeBand;
}

export interface CreateProspectResponse {
  prospect: PublicProspect;
}

export interface GetProspectResponse {
  prospect: PublicProspect;
}

export interface ListProspectsResponse {
  prospects: PublicProspect[];
}

export interface ArchiveProspectResponse {
  prospect: PublicProspect;
}

/** Query-string filters accepted by `GET /prospects`. */
export interface ListProspectsQuery {
  band?: ScoreBand;
  signalKind?: SignalKind;
  stageKey?: string;
  ownerUserId?: string;
  status?: "active" | "archived";
}

// ---------------------------------------------------------------------------
// Signals
// ---------------------------------------------------------------------------

export interface PublicSignal {
  id: string;
  orgId: string;
  prospectId: string;
  kind: SignalKind;
  severity: SignalSeverity;
  features: SignalFeatures;
  source: string;
  /** sha256 of the document this was derived from — provenance, not payload. */
  sourceDigest: string;
  observedAt: string;
  expiresAt: string | null;
}

export interface ListSignalsResponse {
  signals: PublicSignal[];
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

export const DISCOVERY_ADAPTERS = ["synthetic", "web-signals"] as const;
export type DiscoveryAdapterId = (typeof DISCOVERY_ADAPTERS)[number];

export const DISCOVERY_RUN_STATUSES = ["running", "completed", "failed", "cancelled"] as const;
export type DiscoveryRunStatus = (typeof DISCOVERY_RUN_STATUSES)[number];

/** The normalised discovery query. No credentials, ever. */
export interface DiscoveryQuery {
  location?: string | null;
  industry?: string | null;
  sizeBand?: SizeBand | null;
  /** Domains to observe directly — the `web-signals` adapter's input. */
  domains?: string[];
  limit: number;
}

export interface PublicDiscoveryRun {
  id: string;
  orgId: string;
  requestedBy: string;
  adapter: DiscoveryAdapterId;
  query: DiscoveryQuery;
  status: DiscoveryRunStatus;
  candidatesFound: number;
  prospectsCreated: number;
  prospectsUpdated: number;
  signalsRecorded: number;
  errorCode: string | null;
  startedAt: string;
  finishedAt: string | null;
}

export interface CreateDiscoveryRequest {
  adapter?: DiscoveryAdapterId;
  location?: string | null;
  industry?: string | null;
  sizeBand?: SizeBand | null;
  domains?: string[];
  limit?: number;
}

export interface CreateDiscoveryResponse {
  discovery: PublicDiscoveryRun;
}

export interface GetDiscoveryResponse {
  discovery: PublicDiscoveryRun;
}

export interface ListDiscoveriesResponse {
  discoveries: PublicDiscoveryRun[];
}

export const DISCOVERY_LIMIT_MIN = 1;
export const DISCOVERY_LIMIT_MAX = 100;
export const DISCOVERY_LIMIT_DEFAULT = 25;

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

/** One counted signal's contribution to a score, with its human reason. */
export interface ScoreContribution {
  kind: SignalKind;
  points: number;
  reason: string;
  severity: SignalSeverity;
  features: SignalFeatures;
  signalId: string;
}

export interface PublicScore {
  id: string;
  orgId: string;
  prospectId: string;
  score: number;
  band: ScoreBand;
  rulesetVersion: number;
  profileVersion: number;
  contributions: ScoreContribution[];
  signalIds: string[];
  computedAt: string;
}

export interface ListScoresResponse {
  scores: PublicScore[];
}

export interface RescoreResponse {
  score: PublicScore;
}

export interface PublicScoringProfile {
  id: string;
  orgId: string;
  version: number;
  rulesetVersion: number;
  /** Sparse overrides on `DEFAULT_SIGNAL_WEIGHTS`. */
  weights: Partial<Record<SignalKind, number>>;
  /** The fully resolved weights the engine will apply. */
  effectiveWeights: Record<SignalKind, number>;
  isActive: boolean;
  createdBy: string | null;
  createdAt: string;
}

export interface GetScoringProfileResponse {
  profile: PublicScoringProfile;
}

export interface PutScoringProfileRequest {
  weights: Partial<Record<SignalKind, number>>;
}

export interface PutScoringProfileResponse {
  profile: PublicScoringProfile;
}

export const SIGNAL_WEIGHT_MIN = 0;
export const SIGNAL_WEIGHT_MAX = 100;

// ---------------------------------------------------------------------------
// Insights
// ---------------------------------------------------------------------------

export const INSIGHT_KINDS = ["prospect_summary", "outreach_email"] as const;
export type InsightKind = (typeof INSIGHT_KINDS)[number];

export const GUARDRAIL_VERDICTS = ["pass", "revised", "blocked"] as const;
export type GuardrailVerdict = (typeof GUARDRAIL_VERDICTS)[number];

/** Which guardrail check fired, and what it did about it. */
export interface GuardrailNote {
  check: "grounding" | "score_talk" | "fabricated_contact" | "bounds";
  action: "stripped" | "blocked" | "flagged";
  detail: string;
}

export interface PublicInsight {
  id: string;
  orgId: string;
  prospectId: string;
  scoreId: string;
  kind: InsightKind;
  content: string;
  model: string | null;
  promptVersion: number | null;
  guardrailVerdict: Exclude<GuardrailVerdict, "blocked">;
  guardrailNotes: GuardrailNote[];
  generatedBy: string | null;
  createdAt: string;
  /** True when this response replayed a stored generation (and was not metered). */
  cached: boolean;
}

export interface GenerateInsightRequest {
  kind: InsightKind;
}

export interface GenerateInsightResponse {
  insight: PublicInsight;
}

export interface ListInsightsResponse {
  insights: PublicInsight[];
}

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

export const STAGE_OUTCOMES = ["open", "won", "lost"] as const;
export type StageOutcome = (typeof STAGE_OUTCOMES)[number];

export interface PublicPipelineStage {
  id: string;
  orgId: string;
  key: string;
  label: string;
  position: number;
  outcome: StageOutcome;
}

/** The stages seeded for an org on first pipeline use. */
export const DEFAULT_PIPELINE_STAGES: ReadonlyArray<{
  key: string;
  label: string;
  position: number;
  outcome: StageOutcome;
}> = [
  { key: "new", label: "New", position: 1, outcome: "open" },
  { key: "contacted", label: "Contacted", position: 2, outcome: "open" },
  { key: "replied", label: "Replied", position: 3, outcome: "open" },
  { key: "meeting", label: "Meeting", position: 4, outcome: "open" },
  { key: "won", label: "Won", position: 5, outcome: "won" },
  { key: "lost", label: "Lost", position: 6, outcome: "lost" },
];

export interface PublicPipelineEntry {
  id: string;
  orgId: string;
  prospectId: string;
  stageId: string;
  stageKey: string;
  ownerUserId: string | null;
  valueCents: number | null;
  enteredStageAt: string;
  closedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** A pipeline entry joined to the prospect card the board renders. */
export interface PipelineBoardEntry extends PublicPipelineEntry {
  prospectName: string;
  prospectDomain: string | null;
  score: number | null;
  band: ScoreBand | null;
  /** Whole days since `enteredStageAt` — the stuck-in-stage signal. */
  daysInStage: number;
}

export interface GetPipelineResponse {
  stages: PublicPipelineStage[];
  entries: PipelineBoardEntry[];
}

export interface ListPipelineStagesResponse {
  stages: PublicPipelineStage[];
}

export interface PutPipelineStagesRequest {
  stages: Array<{
    key: string;
    label: string;
    position: number;
    outcome: StageOutcome;
  }>;
}

export interface PutPipelineStagesResponse {
  stages: PublicPipelineStage[];
}

export interface CreatePipelineEntryRequest {
  prospectId: string;
  stageKey?: string;
  ownerUserId?: string | null;
  valueCents?: number | null;
}

export interface UpdatePipelineEntryRequest {
  stageKey?: string;
  ownerUserId?: string | null;
  valueCents?: number | null;
}

export interface PipelineEntryResponse {
  entry: PublicPipelineEntry;
}

// ---------------------------------------------------------------------------
// Activities
// ---------------------------------------------------------------------------

export const ACTIVITY_KINDS = [
  "note",
  "stage_change",
  "owner_change",
  "insight_generated",
  "rescored",
  "discovered",
] as const;

export type ActivityKind = (typeof ACTIVITY_KINDS)[number];

export interface PublicActivity {
  id: string;
  orgId: string;
  prospectId: string;
  kind: ActivityKind;
  actorUserId: string | null;
  body: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface CreateActivityRequest {
  kind?: Extract<ActivityKind, "note">;
  body: string;
}

export interface CreateActivityResponse {
  activity: PublicActivity;
}

export interface ListActivitiesResponse {
  activities: PublicActivity[];
}

// ---------------------------------------------------------------------------
// Commercial surface
// ---------------------------------------------------------------------------

/** Entitlement keys gating the two expensive operations. */
export const PROSPECTING_ENTITLEMENTS = {
  discovery: "prospecting.discovery",
  insight: "prospecting.insight",
} as const;

/** Meter keys recorded to metering-worker. */
export const PROSPECTING_METERS = {
  prospectsDiscovered: "prospecting.prospects.discovered",
  insightsGenerated: "prospecting.insights.generated",
} as const;

/**
 * The typed body of a `quota_exhausted` error. Carries enough for the console
 * to render an upgrade prompt without a second round trip.
 */
export interface QuotaExhaustedDetails {
  meter: string;
  entitlement: string;
  limit: number | null;
  used: number | null;
  resetAt: string | null;
}

/** Domain events emitted to events-worker and published by webhooks-worker. */
export const PROSPECTING_EVENT_TYPES = [
  "prospecting.prospect.created",
  "prospecting.prospect.enriched",
  "prospecting.prospect.scored",
  "prospecting.prospect.archived",
  "prospecting.discovery.completed",
  "prospecting.insight.generated",
  "prospecting.pipeline.stage_changed",
  "prospecting.quota.exhausted",
] as const;

export type ProspectingEventType = (typeof PROSPECTING_EVENT_TYPES)[number];

/**
 * The published schema for each domain event.
 *
 * A webhook consumer integrates against this, not against whatever a payload
 * happened to contain the day they looked. Every field listed here is a
 * non-secret public id or a scalar the console already renders: no signal
 * features, no generated prose, no contact data crosses a webhook boundary.
 *
 * Adding a field is additive and safe. Removing or retyping one is a breaking
 * change to every registered endpoint, so it needs a new event type rather
 * than an edit here.
 */
export const PROSPECTING_EVENT_SCHEMAS: Readonly<
  Record<ProspectingEventType, { description: string; fields: Readonly<Record<string, string>> }>
> = {
  "prospecting.prospect.created": {
    description: "A business was added to the org, by discovery or by hand.",
    fields: {
      orgId: "string",
      prospectId: "string",
      name: "string",
      domain: "string | null",
      source: "string",
      discoveryId: "string | undefined",
    },
  },
  "prospecting.prospect.enriched": {
    description: "New observations were recorded against an existing prospect.",
    fields: { orgId: "string", prospectId: "string", signalsRecorded: "number" },
  },
  "prospecting.prospect.scored": {
    description:
      "A score was computed. Carries the previous value, so a consumer can act on the change without keeping its own copy of the board.",
    fields: {
      orgId: "string",
      prospectId: "string",
      scoreId: "string",
      score: "number",
      band: "'hot' | 'warm' | 'cold'",
      previousScore: "number | null",
      previousBand: "string | null",
      rulesetVersion: "number",
      profileVersion: "number",
      trigger: "'discovered' | 'rescored'",
    },
  },
  "prospecting.prospect.archived": {
    description: "A prospect was archived. Its signals, scores, and timeline are retained.",
    fields: { orgId: "string", prospectId: "string", name: "string" },
  },
  "prospecting.discovery.completed": {
    description:
      "A discovery run reached a terminal state. A failed run still carries the counters it achieved — the prospects it produced are real.",
    fields: {
      orgId: "string",
      discoveryId: "string",
      adapter: "string",
      status: "'completed' | 'failed'",
      errorCode: "string | null",
      candidatesFound: "number",
      prospectsCreated: "number",
      prospectsUpdated: "number",
      signalsRecorded: "number",
    },
  },
  "prospecting.insight.generated": {
    description:
      "A draft passed the guardrail and was stored. The text itself is NOT in the payload — fetch it through the API if you need it.",
    fields: {
      orgId: "string",
      prospectId: "string",
      insightId: "string",
      kind: "'prospect_summary' | 'outreach_email'",
      model: "string",
      promptVersion: "number",
      guardrailVerdict: "'pass' | 'revised'",
    },
  },
  "prospecting.pipeline.stage_changed": {
    description: "A prospect entered the pipeline or moved between stages.",
    fields: {
      orgId: "string",
      prospectId: "string",
      entryId: "string",
      fromStage: "string | null",
      toStage: "string",
    },
  },
  "prospecting.quota.exhausted": {
    description:
      "A metered operation was refused because the plan allowance is spent. Carries everything an upgrade prompt needs.",
    fields: {
      orgId: "string",
      meter: "string",
      entitlement: "string",
      limit: "number | null",
      used: "number | null",
      resetAt: "string | null",
    },
  },
};

// ---------------------------------------------------------------------------
// Validators
// ---------------------------------------------------------------------------

const SIGNAL_KIND_SET: ReadonlySet<string> = new Set(SIGNAL_KINDS);
const SIZE_BAND_SET: ReadonlySet<string> = new Set(SIZE_BANDS);
const SCORE_BAND_SET: ReadonlySet<string> = new Set(SCORE_BANDS);
const INSIGHT_KIND_SET: ReadonlySet<string> = new Set(INSIGHT_KINDS);
const ADAPTER_SET: ReadonlySet<string> = new Set(DISCOVERY_ADAPTERS);
const STAGE_OUTCOME_SET: ReadonlySet<string> = new Set(STAGE_OUTCOMES);
const SHA256_HEX_RE = /^[0-9a-f]{64}$/;
const STAGE_KEY_RE = /^[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?$/;

export function isSignalKind(value: unknown): value is SignalKind {
  return typeof value === "string" && SIGNAL_KIND_SET.has(value);
}

export function isSizeBand(value: unknown): value is SizeBand {
  return typeof value === "string" && SIZE_BAND_SET.has(value);
}

export function isScoreBand(value: unknown): value is ScoreBand {
  return typeof value === "string" && SCORE_BAND_SET.has(value);
}

export function isInsightKind(value: unknown): value is InsightKind {
  return typeof value === "string" && INSIGHT_KIND_SET.has(value);
}

export function isDiscoveryAdapterId(value: unknown): value is DiscoveryAdapterId {
  return typeof value === "string" && ADAPTER_SET.has(value);
}

export function isStageOutcome(value: unknown): value is StageOutcome {
  return typeof value === "string" && STAGE_OUTCOME_SET.has(value);
}

export function isStageKey(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= 40 && STAGE_KEY_RE.test(value);
}

export function isSignalSeverity(value: unknown): value is SignalSeverity {
  return value === 1 || value === 2 || value === 3 || value === 4 || value === 5;
}

/** A source digest is a 64-char lowercase hex sha256 — never a payload. */
export function isSourceDigest(value: unknown): value is string {
  return typeof value === "string" && SHA256_HEX_RE.test(value);
}

/**
 * True when `value` is a legal `SignalFeatures` map: a flat object of
 * scalars. Rejects nested objects and arrays, which is how a raw payload
 * would try to sneak in.
 */
export function isSignalFeatures(value: unknown): value is SignalFeatures {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  for (const entry of Object.values(value as Record<string, unknown>)) {
    if (entry === null) continue;
    const t = typeof entry;
    if (t !== "string" && t !== "number" && t !== "boolean") return false;
    if (t === "string" && (entry as string).length > 256) return false;
  }
  return true;
}

/** Resolve a sparse per-org override map against the ruleset defaults. */
export function resolveWeights(
  overrides: Partial<Record<SignalKind, number>> | null | undefined,
): Record<SignalKind, number> {
  const resolved = { ...DEFAULT_SIGNAL_WEIGHTS } as Record<SignalKind, number>;
  if (!overrides) return resolved;
  for (const kind of SIGNAL_KINDS) {
    const override = overrides[kind];
    if (typeof override === "number" && Number.isFinite(override)) {
      resolved[kind] = Math.min(SIGNAL_WEIGHT_MAX, Math.max(SIGNAL_WEIGHT_MIN, override));
    }
  }
  return resolved;
}

/** Validate a weight-override map. Returns per-field messages when invalid. */
export function validateWeights(
  value: unknown,
): { valid: true; weights: Partial<Record<SignalKind, number>> } | { valid: false; fields: Record<string, string[]> } {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { valid: false, fields: { weights: ["Must be an object of signal kind to points"] } };
  }
  const fields: Record<string, string[]> = {};
  const weights: Partial<Record<SignalKind, number>> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!isSignalKind(key)) {
      fields[`weights.${key}`] = ["Unknown signal kind"];
      continue;
    }
    if (typeof raw !== "number" || !Number.isFinite(raw) || raw < SIGNAL_WEIGHT_MIN || raw > SIGNAL_WEIGHT_MAX) {
      fields[`weights.${key}`] = [`Must be a number between ${SIGNAL_WEIGHT_MIN} and ${SIGNAL_WEIGHT_MAX}`];
      continue;
    }
    weights[key] = raw;
  }
  if (Object.keys(fields).length > 0) return { valid: false, fields };
  return { valid: true, weights };
}

/** Map a raw 0–100 score onto its band. */
export function bandForScore(score: number): ScoreBand {
  if (score >= SCORE_BAND_THRESHOLDS.hot) return "hot";
  if (score >= SCORE_BAND_THRESHOLDS.warm) return "warm";
  return "cold";
}
