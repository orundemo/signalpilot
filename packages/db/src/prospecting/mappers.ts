import type {
  Activity,
  DiscoveryRun,
  Insight,
  PipelineEntry,
  PipelineEntryWithProspect,
  PipelineStage,
  Prospect,
  ProspectingResult,
  Score,
  ScoringProfile,
  Signal,
} from "./types.js";

export function parseJsonObject(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      return {};
    }
    return {};
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

export function parseJsonArray(value: unknown): unknown[] {
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return Array.isArray(value) ? value : [];
}

/** `uuid[]` comes back as a JS array from postgres.js and as `{a,b}` from raw text. */
export function parseUuidArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === "string") {
    const trimmed = value.replace(/^\{|\}$/g, "");
    if (trimmed.length === 0) return [];
    return trimmed.split(",").map((s) => s.replace(/^"|"$/g, ""));
  }
  return [];
}

function num(value: unknown): number {
  return typeof value === "number" ? value : Number(value ?? 0);
}

function date(value: unknown): Date {
  return value instanceof Date ? value : new Date(value as string);
}

function maybeDate(value: unknown): Date | null {
  if (value === null || value === undefined) return null;
  return date(value);
}

export function mapProspect(row: Record<string, unknown>): Prospect {
  return {
    id: row.id as string,
    orgId: row.org_id as string,
    name: row.name as string,
    domain: (row.domain as string) ?? null,
    dedupeKey: row.dedupe_key as string,
    industry: (row.industry as string) ?? null,
    locality: (row.locality as string) ?? null,
    region: (row.region as string) ?? null,
    country: (row.country as string) ?? null,
    sizeBand: row.size_band as string,
    source: row.source as string,
    sourceRef: (row.source_ref as string) ?? null,
    status: row.status as string,
    firstSeenAt: date(row.first_seen_at),
    lastEnrichedAt: maybeDate(row.last_enriched_at),
    createdAt: date(row.created_at),
    updatedAt: date(row.updated_at),
    archivedAt: maybeDate(row.archived_at),
  };
}

export function mapSignal(row: Record<string, unknown>): Signal {
  return {
    id: row.id as string,
    orgId: row.org_id as string,
    prospectId: row.prospect_id as string,
    kind: row.kind as string,
    severity: num(row.severity),
    features: parseJsonObject(row.features),
    source: row.source as string,
    sourceDigest: row.source_digest as string,
    observedAt: date(row.observed_at),
    expiresAt: maybeDate(row.expires_at),
  };
}

export function mapDiscoveryRun(row: Record<string, unknown>): DiscoveryRun {
  return {
    id: row.id as string,
    orgId: row.org_id as string,
    requestedBy: row.requested_by as string,
    adapter: row.adapter as string,
    query: parseJsonObject(row.query),
    status: row.status as string,
    candidatesFound: num(row.candidates_found),
    prospectsCreated: num(row.prospects_created),
    prospectsUpdated: num(row.prospects_updated),
    signalsRecorded: num(row.signals_recorded),
    errorCode: (row.error_code as string) ?? null,
    startedAt: date(row.started_at),
    finishedAt: maybeDate(row.finished_at),
  };
}

export function mapScoringProfile(row: Record<string, unknown>): ScoringProfile {
  return {
    id: row.id as string,
    orgId: row.org_id as string,
    version: num(row.version),
    rulesetVersion: num(row.ruleset_version),
    weights: parseJsonObject(row.weights) as Record<string, number>,
    isActive: row.is_active === true || row.is_active === "t",
    createdBy: (row.created_by as string) ?? null,
    createdAt: date(row.created_at),
  };
}

export function mapScore(row: Record<string, unknown>): Score {
  return {
    id: row.id as string,
    orgId: row.org_id as string,
    prospectId: row.prospect_id as string,
    score: num(row.score),
    band: row.band as string,
    rulesetVersion: num(row.ruleset_version),
    profileVersion: num(row.profile_version),
    contributions: parseJsonArray(row.contributions),
    signalIds: parseUuidArray(row.signal_ids),
    computedAt: date(row.computed_at),
  };
}

export function mapInsight(row: Record<string, unknown>): Insight {
  return {
    id: row.id as string,
    orgId: row.org_id as string,
    prospectId: row.prospect_id as string,
    scoreId: row.score_id as string,
    kind: row.kind as string,
    content: row.content as string,
    model: (row.model as string) ?? null,
    promptVersion: row.prompt_version === null || row.prompt_version === undefined ? null : num(row.prompt_version),
    inputDigest: row.input_digest as string,
    guardrailVerdict: row.guardrail_verdict as string,
    guardrailNotes: parseJsonArray(row.guardrail_notes),
    generatedBy: (row.generated_by as string) ?? null,
    createdAt: date(row.created_at),
  };
}

export function mapStage(row: Record<string, unknown>): PipelineStage {
  return {
    id: row.id as string,
    orgId: row.org_id as string,
    key: row.key as string,
    label: row.label as string,
    position: num(row.position),
    outcome: row.outcome as string,
  };
}

export function mapEntry(row: Record<string, unknown>): PipelineEntry {
  return {
    id: row.id as string,
    orgId: row.org_id as string,
    prospectId: row.prospect_id as string,
    stageId: row.stage_id as string,
    ownerUserId: (row.owner_user_id as string) ?? null,
    valueCents: row.value_cents === null || row.value_cents === undefined ? null : num(row.value_cents),
    enteredStageAt: date(row.entered_stage_at),
    closedAt: maybeDate(row.closed_at),
    createdAt: date(row.created_at),
    updatedAt: date(row.updated_at),
  };
}

export function mapBoardEntry(row: Record<string, unknown>): PipelineEntryWithProspect {
  return {
    ...mapEntry(row),
    stageKey: row.stage_key as string,
    prospectName: row.prospect_name as string,
    prospectDomain: (row.prospect_domain as string) ?? null,
    score: row.score === null || row.score === undefined ? null : num(row.score),
    band: (row.band as string) ?? null,
  };
}

export function mapActivity(row: Record<string, unknown>): Activity {
  return {
    id: row.id as string,
    orgId: row.org_id as string,
    prospectId: row.prospect_id as string,
    kind: row.kind as string,
    actorUserId: (row.actor_user_id as string) ?? null,
    body: (row.body as string) ?? null,
    metadata: parseJsonObject(row.metadata),
    createdAt: date(row.created_at),
  };
}

export function internalError(message: string): ProspectingResult<never> {
  return { ok: false, error: { kind: "internal", message } };
}

export function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: string }).code === "23505"
  );
}
