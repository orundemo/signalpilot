export type { SqlExecutor, SqlExecutorResult, SqlRow } from "../hyperdrive/executor.js";
import type { Uuid } from "../ids/index.js";

export type ProspectingRepositoryError =
  | { kind: "not_found" }
  | { kind: "conflict"; entity: string }
  | { kind: "internal"; message: string };

export type ProspectingResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: ProspectingRepositoryError };

// ── Row shapes ─────────────────────────────────────────────

export interface Prospect {
  id: string;
  orgId: string;
  name: string;
  domain: string | null;
  dedupeKey: string;
  industry: string | null;
  locality: string | null;
  region: string | null;
  country: string | null;
  sizeBand: string;
  source: string;
  sourceRef: string | null;
  status: string;
  firstSeenAt: Date;
  lastEnrichedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  archivedAt: Date | null;
}

export interface Signal {
  id: string;
  orgId: string;
  prospectId: string;
  kind: string;
  severity: number;
  features: Record<string, unknown>;
  source: string;
  sourceDigest: string;
  observedAt: Date;
  expiresAt: Date | null;
}

export interface DiscoveryRun {
  id: string;
  orgId: string;
  requestedBy: string;
  adapter: string;
  query: Record<string, unknown>;
  status: string;
  candidatesFound: number;
  prospectsCreated: number;
  prospectsUpdated: number;
  signalsRecorded: number;
  errorCode: string | null;
  startedAt: Date;
  finishedAt: Date | null;
}

export interface ScoringProfile {
  id: string;
  orgId: string;
  version: number;
  rulesetVersion: number;
  weights: Record<string, number>;
  isActive: boolean;
  createdBy: string | null;
  createdAt: Date;
}

export interface Score {
  id: string;
  orgId: string;
  prospectId: string;
  score: number;
  band: string;
  rulesetVersion: number;
  profileVersion: number;
  contributions: unknown[];
  signalIds: string[];
  computedAt: Date;
}

export interface Insight {
  id: string;
  orgId: string;
  prospectId: string;
  scoreId: string;
  kind: string;
  content: string;
  model: string | null;
  promptVersion: number | null;
  inputDigest: string;
  guardrailVerdict: string;
  guardrailNotes: unknown[];
  generatedBy: string | null;
  createdAt: Date;
}

export interface PipelineStage {
  id: string;
  orgId: string;
  key: string;
  label: string;
  position: number;
  outcome: string;
}

export interface PipelineEntry {
  id: string;
  orgId: string;
  prospectId: string;
  stageId: string;
  ownerUserId: string | null;
  valueCents: number | null;
  enteredStageAt: Date;
  closedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/** A pipeline entry joined to the prospect card and its newest score. */
export interface PipelineEntryWithProspect extends PipelineEntry {
  stageKey: string;
  prospectName: string;
  prospectDomain: string | null;
  score: number | null;
  band: string | null;
}

export interface Activity {
  id: string;
  orgId: string;
  prospectId: string;
  kind: string;
  actorUserId: string | null;
  body: string | null;
  metadata: Record<string, unknown>;
  createdAt: Date;
}

/** A prospect joined to its newest score — the prospects-board read shape. */
export interface ProspectWithScore {
  prospect: Prospect;
  score: Score | null;
}

// ── Inputs ─────────────────────────────────────────────────

export interface UpsertProspectInput {
  id: string;
  orgId: Uuid;
  name: string;
  domain: string | null;
  dedupeKey: string;
  industry: string | null;
  locality: string | null;
  region: string | null;
  country: string | null;
  sizeBand: string;
  source: string;
  sourceRef: string | null;
  observedAt: Date;
}

/** Whether an upsert inserted a new prospect or refreshed an existing one. */
export interface UpsertProspectResult {
  prospect: Prospect;
  created: boolean;
}

export interface UpdateProspectInput {
  name?: string;
  domain?: string | null;
  industry?: string | null;
  locality?: string | null;
  region?: string | null;
  country?: string | null;
  sizeBand?: string;
}

export interface InsertSignalInput {
  id: string;
  orgId: Uuid;
  prospectId: Uuid;
  kind: string;
  severity: number;
  features: Record<string, unknown>;
  source: string;
  sourceDigest: string;
  observedAt: Date;
  expiresAt: Date | null;
}

export interface CreateDiscoveryRunInput {
  id: string;
  orgId: Uuid;
  requestedBy: Uuid;
  adapter: string;
  query: Record<string, unknown>;
  startedAt: Date;
}

export interface FinishDiscoveryRunInput {
  status: "completed" | "failed" | "cancelled";
  candidatesFound: number;
  prospectsCreated: number;
  prospectsUpdated: number;
  signalsRecorded: number;
  errorCode: string | null;
  finishedAt: Date;
}

export interface InsertScoreInput {
  id: string;
  orgId: Uuid;
  prospectId: Uuid;
  score: number;
  band: string;
  rulesetVersion: number;
  profileVersion: number;
  contributions: unknown[];
  signalIds: string[];
  computedAt: Date;
}

export interface InsertScoringProfileInput {
  id: string;
  orgId: Uuid;
  rulesetVersion: number;
  weights: Record<string, number>;
  createdBy: Uuid | null;
  createdAt: Date;
}

export interface InsertInsightInput {
  id: string;
  orgId: Uuid;
  prospectId: Uuid;
  scoreId: Uuid;
  kind: string;
  content: string;
  model: string | null;
  promptVersion: number | null;
  inputDigest: string;
  guardrailVerdict: string;
  guardrailNotes: unknown[];
  generatedBy: Uuid | null;
  createdAt: Date;
}

export interface SeedStageInput {
  id: string;
  key: string;
  label: string;
  position: number;
  outcome: string;
}

export interface CreatePipelineEntryInput {
  id: string;
  orgId: Uuid;
  prospectId: Uuid;
  stageId: Uuid;
  ownerUserId: Uuid | null;
  valueCents: number | null;
  now: Date;
  /** Set when the target stage is terminal (`won`/`lost`). */
  closedAt: Date | null;
}

export interface UpdatePipelineEntryInput {
  stageId?: Uuid;
  ownerUserId?: Uuid | null;
  valueCents?: number | null;
  /** Provided when the stage changed — resets the stuck-in-stage clock. */
  enteredStageAt?: Date;
  closedAt?: Date | null;
  updatedAt: Date;
}

export interface InsertActivityInput {
  id: string;
  orgId: Uuid;
  prospectId: Uuid;
  kind: string;
  actorUserId: Uuid | null;
  body: string | null;
  metadata: Record<string, unknown>;
  createdAt: Date;
}

// ── Pagination ─────────────────────────────────────────────

export interface CursorPosition {
  createdAt: string;
  id: string;
}

export interface PageQueryParams {
  limit: number;
  cursor: CursorPosition | null;
}

export interface PagedResult<T> {
  items: T[];
  nextCursor: CursorPosition | null;
}

/** Server-side filters for the prospects board. */
export interface ProspectFilters {
  band?: string;
  signalKind?: string;
  stageKey?: string;
  ownerUserId?: string;
  status?: string;
}

// ── Repository ─────────────────────────────────────────────

export interface ProspectingRepository {
  // prospects + signals
  upsertProspect(input: UpsertProspectInput): Promise<ProspectingResult<UpsertProspectResult>>;
  getProspect(orgId: Uuid, prospectId: Uuid): Promise<ProspectingResult<ProspectWithScore>>;
  listProspectsPaged(
    orgId: Uuid,
    params: PageQueryParams,
    filters?: ProspectFilters,
  ): Promise<ProspectingResult<PagedResult<ProspectWithScore>>>;
  updateProspect(orgId: Uuid, prospectId: Uuid, input: UpdateProspectInput, now: Date): Promise<ProspectingResult<Prospect>>;
  archiveProspect(orgId: Uuid, prospectId: Uuid, archivedAt: Date): Promise<ProspectingResult<Prospect>>;
  countProspectsSince(orgId: Uuid, since: Date): Promise<ProspectingResult<number>>;

  insertSignal(input: InsertSignalInput): Promise<ProspectingResult<Signal>>;
  listSignals(orgId: Uuid, prospectId: Uuid, limit: number): Promise<ProspectingResult<Signal[]>>;
  /** Most recent signal per kind, expiry-filtered — exactly what scoring reads. */
  listScorableSignals(orgId: Uuid, prospectId: Uuid, now: Date): Promise<ProspectingResult<Signal[]>>;

  // discovery
  createDiscoveryRun(input: CreateDiscoveryRunInput): Promise<ProspectingResult<DiscoveryRun>>;
  finishDiscoveryRun(orgId: Uuid, runId: Uuid, input: FinishDiscoveryRunInput): Promise<ProspectingResult<DiscoveryRun>>;
  getDiscoveryRun(orgId: Uuid, runId: Uuid): Promise<ProspectingResult<DiscoveryRun>>;
  listDiscoveryRunsPaged(orgId: Uuid, params: PageQueryParams): Promise<ProspectingResult<PagedResult<DiscoveryRun>>>;

  // scoring
  getActiveScoringProfile(orgId: Uuid): Promise<ProspectingResult<ScoringProfile | null>>;
  insertScoringProfile(input: InsertScoringProfileInput): Promise<ProspectingResult<ScoringProfile>>;
  insertScore(input: InsertScoreInput): Promise<ProspectingResult<Score>>;
  listScores(orgId: Uuid, prospectId: Uuid, limit: number): Promise<ProspectingResult<Score[]>>;
  getLatestScore(orgId: Uuid, prospectId: Uuid): Promise<ProspectingResult<Score | null>>;
  /** Active prospect ids for a bulk rescore, oldest-scored first. */
  listActiveProspectIds(orgId: Uuid, limit: number): Promise<ProspectingResult<string[]>>;

  // insights
  findInsightByDigest(orgId: Uuid, inputDigest: string): Promise<ProspectingResult<Insight | null>>;
  insertInsight(input: InsertInsightInput): Promise<ProspectingResult<Insight>>;
  listInsights(orgId: Uuid, prospectId: Uuid, limit: number): Promise<ProspectingResult<Insight[]>>;
  countInsightsSince(orgId: Uuid, since: Date): Promise<ProspectingResult<number>>;

  // pipeline
  listStages(orgId: Uuid): Promise<ProspectingResult<PipelineStage[]>>;
  /** Idempotent: inserts only the stages an org does not already have. */
  seedStages(orgId: Uuid, stages: SeedStageInput[]): Promise<ProspectingResult<PipelineStage[]>>;
  replaceStages(orgId: Uuid, stages: SeedStageInput[]): Promise<ProspectingResult<PipelineStage[]>>;
  createPipelineEntry(input: CreatePipelineEntryInput): Promise<ProspectingResult<PipelineEntry>>;
  getPipelineEntry(orgId: Uuid, entryId: Uuid): Promise<ProspectingResult<PipelineEntry>>;
  getOpenEntryForProspect(orgId: Uuid, prospectId: Uuid): Promise<ProspectingResult<PipelineEntry | null>>;
  updatePipelineEntry(orgId: Uuid, entryId: Uuid, input: UpdatePipelineEntryInput): Promise<ProspectingResult<PipelineEntry>>;
  listBoard(orgId: Uuid, limit: number): Promise<ProspectingResult<PipelineEntryWithProspect[]>>;

  // activities
  insertActivity(input: InsertActivityInput): Promise<ProspectingResult<Activity>>;
  listActivities(orgId: Uuid, prospectId: Uuid, limit: number): Promise<ProspectingResult<Activity[]>>;
}
