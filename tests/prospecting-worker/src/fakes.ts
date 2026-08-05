import type {
  Activity,
  DiscoveryRun,
  Insight,
  PipelineEntry,
  PipelineEntryWithProspect,
  PipelineStage,
  Prospect,
  ProspectingRepository,
  ProspectingResult,
  ProspectWithScore,
  Score,
  ScoringProfile,
  Signal,
} from "@saas/db/prospecting";
import type {
  AppendEventWithAuditInput,
  EventsRepository,
  EventsResult,
  StoredAuditEntry,
  StoredEvent,
} from "@saas/db/events";

/**
 * An in-memory `ProspectingRepository`.
 *
 * The alternative — asserting on SQL strings — proves the query was written,
 * not that the behaviour is right. The invariants worth testing here (dedupe
 * convergence, counter accuracy, one-open-entry-per-prospect) are *behavioural*,
 * so the fake enforces the same constraints the schema does and the tests
 * exercise them.
 */
export interface FakeProspectingRepo extends ProspectingRepository {
  readonly prospects: Map<string, Prospect>;
  readonly signals: Signal[];
  readonly runs: Map<string, DiscoveryRun>;
  readonly scores: Score[];
  readonly insights: Insight[];
  readonly activities: Activity[];
  readonly stages: Map<string, PipelineStage>;
  readonly entries: Map<string, PipelineEntry>;
  /** Throw from `upsertProspect` once the Nth candidate arrives. */
  failUpsertAfter?: number;
}

const ok = <T>(value: T): ProspectingResult<T> => ({ ok: true, value });
const notFound = (): ProspectingResult<never> => ({ ok: false, error: { kind: "not_found" } });

export function createFakeRepo(): FakeProspectingRepo {
  const prospects = new Map<string, Prospect>();
  const byDedupe = new Map<string, string>();
  const signals: Signal[] = [];
  const runs = new Map<string, DiscoveryRun>();
  const scores: Score[] = [];
  const insights: Insight[] = [];
  const activities: Activity[] = [];
  const stages = new Map<string, PipelineStage>();
  const entries = new Map<string, PipelineEntry>();
  const profiles: ScoringProfile[] = [];

  const repo: FakeProspectingRepo = {
    prospects,
    signals,
    runs,
    scores,
    insights,
    activities,
    stages,
    entries,

    async upsertProspect(input) {
      if (repo.failUpsertAfter !== undefined && prospects.size >= repo.failUpsertAfter) {
        throw new Error("adapter_exploded");
      }
      const key = `${input.orgId}|${input.dedupeKey}`;
      const existingId = byDedupe.get(key);
      if (existingId) {
        const existing = prospects.get(existingId)!;
        const updated: Prospect = {
          ...existing,
          name: input.name || existing.name,
          domain: input.domain ?? existing.domain,
          industry: input.industry ?? existing.industry,
          locality: input.locality ?? existing.locality,
          region: input.region ?? existing.region,
          country: input.country ?? existing.country,
          sizeBand: input.sizeBand === "unknown" ? existing.sizeBand : input.sizeBand,
          lastEnrichedAt: input.observedAt,
          updatedAt: input.observedAt,
        };
        prospects.set(existingId, updated);
        return ok({ prospect: updated, created: false });
      }
      const prospect: Prospect = {
        id: input.id,
        orgId: input.orgId,
        name: input.name,
        domain: input.domain,
        dedupeKey: input.dedupeKey,
        industry: input.industry,
        locality: input.locality,
        region: input.region,
        country: input.country,
        sizeBand: input.sizeBand,
        source: input.source,
        sourceRef: input.sourceRef,
        status: "active",
        firstSeenAt: input.observedAt,
        lastEnrichedAt: input.observedAt,
        createdAt: input.observedAt,
        updatedAt: input.observedAt,
        archivedAt: null,
      };
      prospects.set(prospect.id, prospect);
      byDedupe.set(key, prospect.id);
      return ok({ prospect, created: true });
    },

    async getProspect(orgId, prospectId) {
      const prospect = prospects.get(prospectId);
      if (!prospect || prospect.orgId !== orgId) return notFound();
      const score = [...scores]
        .filter((s) => s.orgId === orgId && s.prospectId === prospectId)
        .sort((a, b) => b.computedAt.getTime() - a.computedAt.getTime())[0] ?? null;
      return ok({ prospect, score } as ProspectWithScore);
    },

    async listProspectsPaged(orgId, params, filters) {
      let items = [...prospects.values()].filter(
        (p) => p.orgId === orgId && p.status === (filters?.status ?? "active"),
      );
      if (filters?.signalKind) {
        items = items.filter((p) => signals.some((s) => s.prospectId === p.id && s.kind === filters.signalKind));
      }
      const withScores: ProspectWithScore[] = items
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
        .map((prospect) => ({
          prospect,
          score:
            [...scores]
              .filter((s) => s.prospectId === prospect.id)
              .sort((a, b) => b.computedAt.getTime() - a.computedAt.getTime())[0] ?? null,
        }))
        .filter((row) => (filters?.band ? row.score?.band === filters.band : true));
      return ok({ items: withScores.slice(0, params.limit), nextCursor: null });
    },

    async updateProspect(orgId, prospectId, input, now) {
      const prospect = prospects.get(prospectId);
      if (!prospect || prospect.orgId !== orgId || prospect.status !== "active") return notFound();
      const updated = { ...prospect, ...input, updatedAt: now } as Prospect;
      prospects.set(prospectId, updated);
      return ok(updated);
    },

    async archiveProspect(orgId, prospectId, archivedAt) {
      const prospect = prospects.get(prospectId);
      if (!prospect || prospect.orgId !== orgId || prospect.status !== "active") return notFound();
      const updated: Prospect = { ...prospect, status: "archived", archivedAt, updatedAt: archivedAt };
      prospects.set(prospectId, updated);
      return ok(updated);
    },

    async countProspectsSince(orgId, since) {
      return ok([...prospects.values()].filter((p) => p.orgId === orgId && p.createdAt >= since).length);
    },

    async insertSignal(input) {
      const duplicate = signals.some(
        (s) =>
          s.orgId === input.orgId &&
          s.prospectId === input.prospectId &&
          s.kind === input.kind &&
          s.observedAt.getTime() === input.observedAt.getTime(),
      );
      if (duplicate) return { ok: false, error: { kind: "conflict", entity: "signal" } };
      const signal: Signal = {
        id: input.id,
        orgId: input.orgId,
        prospectId: input.prospectId,
        kind: input.kind,
        severity: input.severity,
        features: input.features,
        source: input.source,
        sourceDigest: input.sourceDigest,
        observedAt: input.observedAt,
        expiresAt: input.expiresAt,
      };
      signals.push(signal);
      return ok(signal);
    },

    async listSignals(orgId, prospectId, limit) {
      return ok(signals.filter((s) => s.orgId === orgId && s.prospectId === prospectId).slice(0, limit));
    },

    async listScorableSignals(orgId, prospectId, now) {
      const live = signals.filter(
        (s) => s.orgId === orgId && s.prospectId === prospectId && (!s.expiresAt || s.expiresAt > now),
      );
      const newestPerKind = new Map<string, Signal>();
      for (const signal of live) {
        const current = newestPerKind.get(signal.kind);
        if (!current || signal.observedAt > current.observedAt) newestPerKind.set(signal.kind, signal);
      }
      return ok([...newestPerKind.values()]);
    },

    async createDiscoveryRun(input) {
      const run: DiscoveryRun = {
        id: input.id,
        orgId: input.orgId,
        requestedBy: input.requestedBy,
        adapter: input.adapter,
        query: input.query,
        status: "running",
        candidatesFound: 0,
        prospectsCreated: 0,
        prospectsUpdated: 0,
        signalsRecorded: 0,
        errorCode: null,
        startedAt: input.startedAt,
        finishedAt: null,
      };
      runs.set(run.id, run);
      return ok(run);
    },

    async finishDiscoveryRun(orgId, runId, input) {
      const run = runs.get(runId);
      if (!run || run.orgId !== orgId) return notFound();
      const updated: DiscoveryRun = { ...run, ...input };
      runs.set(runId, updated);
      return ok(updated);
    },

    async getDiscoveryRun(orgId, runId) {
      const run = runs.get(runId);
      if (!run || run.orgId !== orgId) return notFound();
      return ok(run);
    },

    async listDiscoveryRunsPaged(orgId, params) {
      const items = [...runs.values()]
        .filter((r) => r.orgId === orgId)
        .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())
        .slice(0, params.limit);
      return ok({ items, nextCursor: null });
    },

    async getActiveScoringProfile(orgId) {
      return ok(profiles.find((p) => p.orgId === orgId && p.isActive) ?? null);
    },

    async insertScoringProfile(input) {
      for (const profile of profiles) {
        if (profile.orgId === input.orgId) profile.isActive = false;
      }
      const version = profiles.filter((p) => p.orgId === input.orgId).length + 1;
      const profile: ScoringProfile = {
        id: input.id,
        orgId: input.orgId,
        version,
        rulesetVersion: input.rulesetVersion,
        weights: input.weights,
        isActive: true,
        createdBy: input.createdBy,
        createdAt: input.createdAt,
      };
      profiles.push(profile);
      return ok(profile);
    },

    async insertScore(input) {
      const score: Score = { ...input, contributions: input.contributions, signalIds: input.signalIds };
      scores.push(score);
      return ok(score);
    },

    async listScores(orgId, prospectId, limit) {
      return ok(
        scores
          .filter((s) => s.orgId === orgId && s.prospectId === prospectId)
          .sort((a, b) => b.computedAt.getTime() - a.computedAt.getTime())
          .slice(0, limit),
      );
    },

    async getLatestScore(orgId, prospectId) {
      return ok(
        scores
          .filter((s) => s.orgId === orgId && s.prospectId === prospectId)
          .sort((a, b) => b.computedAt.getTime() - a.computedAt.getTime())[0] ?? null,
      );
    },

    async listActiveProspectIds(orgId, limit) {
      return ok(
        [...prospects.values()]
          .filter((p) => p.orgId === orgId && p.status === "active")
          .slice(0, limit)
          .map((p) => p.id),
      );
    },

    async findInsightByDigest(orgId, inputDigest) {
      return ok(insights.find((i) => i.orgId === orgId && i.inputDigest === inputDigest) ?? null);
    },

    async insertInsight(input) {
      if (insights.some((i) => i.orgId === input.orgId && i.inputDigest === input.inputDigest)) {
        return { ok: false, error: { kind: "conflict", entity: "insight" } };
      }
      const insight: Insight = { ...input };
      insights.push(insight);
      return ok(insight);
    },

    async listInsights(orgId, prospectId, limit) {
      return ok(
        insights
          .filter((i) => i.orgId === orgId && i.prospectId === prospectId)
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
          .slice(0, limit),
      );
    },

    async countInsightsSince(orgId, since) {
      return ok(insights.filter((i) => i.orgId === orgId && i.createdAt >= since).length);
    },

    async listStages(orgId) {
      return ok([...stages.values()].filter((s) => s.orgId === orgId).sort((a, b) => a.position - b.position));
    },

    async seedStages(orgId, seeds) {
      for (const seed of seeds) {
        const exists = [...stages.values()].some((s) => s.orgId === orgId && s.key === seed.key);
        if (exists) continue;
        stages.set(seed.id, { id: seed.id, orgId, key: seed.key, label: seed.label, position: seed.position, outcome: seed.outcome });
      }
      return repo.listStages(orgId);
    },

    async replaceStages(orgId, seeds) {
      for (const [id, stage] of stages) {
        if (stage.orgId !== orgId) continue;
        const kept = seeds.some((s) => s.key === stage.key);
        const referenced = [...entries.values()].some((e) => e.stageId === id);
        if (!kept && !referenced) stages.delete(id);
      }
      for (const seed of seeds) {
        const existing = [...stages.values()].find((s) => s.orgId === orgId && s.key === seed.key);
        if (existing) {
          stages.set(existing.id, { ...existing, label: seed.label, position: seed.position, outcome: seed.outcome });
        } else {
          stages.set(seed.id, { id: seed.id, orgId, key: seed.key, label: seed.label, position: seed.position, outcome: seed.outcome });
        }
      }
      return repo.listStages(orgId);
    },

    async createPipelineEntry(input) {
      const open = [...entries.values()].some(
        (e) => e.orgId === input.orgId && e.prospectId === input.prospectId && e.closedAt === null,
      );
      if (open) return { ok: false, error: { kind: "conflict", entity: "pipeline_entry" } };
      const entry: PipelineEntry = {
        id: input.id,
        orgId: input.orgId,
        prospectId: input.prospectId,
        stageId: input.stageId,
        ownerUserId: input.ownerUserId,
        valueCents: input.valueCents,
        enteredStageAt: input.now,
        closedAt: input.closedAt,
        createdAt: input.now,
        updatedAt: input.now,
      };
      entries.set(entry.id, entry);
      return ok(entry);
    },

    async getPipelineEntry(orgId, entryId) {
      const entry = entries.get(entryId);
      if (!entry || entry.orgId !== orgId) return notFound();
      return ok(entry);
    },

    async getOpenEntryForProspect(orgId, prospectId) {
      return ok(
        [...entries.values()].find((e) => e.orgId === orgId && e.prospectId === prospectId && e.closedAt === null) ?? null,
      );
    },

    async updatePipelineEntry(orgId, entryId, input) {
      const entry = entries.get(entryId);
      if (!entry || entry.orgId !== orgId) return notFound();
      const updated: PipelineEntry = {
        ...entry,
        stageId: input.stageId ?? entry.stageId,
        ownerUserId: input.ownerUserId !== undefined ? input.ownerUserId : entry.ownerUserId,
        valueCents: input.valueCents !== undefined ? input.valueCents : entry.valueCents,
        enteredStageAt: input.enteredStageAt ?? entry.enteredStageAt,
        closedAt: input.closedAt !== undefined ? input.closedAt : entry.closedAt,
        updatedAt: input.updatedAt,
      };
      entries.set(entryId, updated);
      return ok(updated);
    },

    async listBoard(orgId, limit) {
      const rows: PipelineEntryWithProspect[] = [...entries.values()]
        .filter((e) => e.orgId === orgId && e.closedAt === null)
        .slice(0, limit)
        .map((entry) => {
          const prospect = prospects.get(entry.prospectId)!;
          const score =
            scores
              .filter((s) => s.prospectId === entry.prospectId)
              .sort((a, b) => b.computedAt.getTime() - a.computedAt.getTime())[0] ?? null;
          return {
            ...entry,
            stageKey: stages.get(entry.stageId)?.key ?? "unknown",
            prospectName: prospect?.name ?? "unknown",
            prospectDomain: prospect?.domain ?? null,
            score: score?.score ?? null,
            band: score?.band ?? null,
          };
        });
      return ok(rows);
    },

    async insertActivity(input) {
      const activity: Activity = { ...input };
      activities.push(activity);
      return ok(activity);
    },

    async listActivities(orgId, prospectId, limit) {
      return ok(
        activities
          .filter((a) => a.orgId === orgId && a.prospectId === prospectId)
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
          .slice(0, limit),
      );
    },
  };

  return repo;
}

export interface FakeEventsRepo extends EventsRepository {
  readonly appended: AppendEventWithAuditInput[];
}

export function createFakeEventsRepo(): FakeEventsRepo {
  const appended: AppendEventWithAuditInput[] = [];
  return {
    appended,
    async appendEvent() {
      return { ok: true, value: {} as StoredEvent } as EventsResult<StoredEvent>;
    },
    async appendEventWithAudit(input) {
      appended.push(input);
      return { ok: true, value: { event: {} as StoredEvent, audit: {} as StoredAuditEntry } };
    },
    async queryAuditByOrg() {
      return { ok: true, value: { items: [], nextCursor: null } };
    },
    async queryAuditByTarget() {
      return { ok: true, value: { items: [], nextCursor: null } };
    },
    async queryEventsByOrg() {
      return { ok: true, value: [] };
    },
    async getEventById() {
      return { ok: true, value: null };
    },
  };
}

/** A `Fetcher` that answers every service-binding call with one canned body. */
export function fetcherReturning(body: unknown, status = 200): Fetcher & { calls: string[] } {
  const calls: string[] = [];
  return {
    fetch(input: string | Request | URL): Promise<Response> {
      calls.push(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
      return Promise.resolve(
        new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }),
      );
    },
    connect() {
      throw new Error("not implemented");
    },
    calls,
  } as unknown as Fetcher & { calls: string[] };
}
