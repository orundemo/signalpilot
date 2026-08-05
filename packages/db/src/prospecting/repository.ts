import type { SqlExecutor } from "../hyperdrive/executor.js";
import type { Uuid } from "../ids/index.js";
import {
  internalError,
  isUniqueViolation,
  mapActivity,
  mapBoardEntry,
  mapDiscoveryRun,
  mapEntry,
  mapInsight,
  mapProspect,
  mapScore,
  mapScoringProfile,
  mapSignal,
  mapStage,
} from "./mappers.js";
import type {
  Activity,
  CreateDiscoveryRunInput,
  CreatePipelineEntryInput,
  CursorPosition,
  DiscoveryRun,
  FinishDiscoveryRunInput,
  Insight,
  InsertActivityInput,
  InsertInsightInput,
  InsertScoreInput,
  InsertScoringProfileInput,
  InsertSignalInput,
  PagedResult,
  PageQueryParams,
  PipelineEntry,
  PipelineEntryWithProspect,
  PipelineStage,
  Prospect,
  ProspectFilters,
  ProspectingRepository,
  ProspectingResult,
  ProspectWithScore,
  Score,
  ScoringProfile,
  SeedStageInput,
  Signal,
  UpdatePipelineEntryInput,
  UpdateProspectInput,
  UpsertProspectInput,
  UpsertProspectResult,
} from "./types.js";

/**
 * The newest score per prospect, as a lateral join. Kept in one place so the
 * board list and the single read cannot drift on what "current score" means.
 */
const LATEST_SCORE_JOIN = `
  LEFT JOIN LATERAL (
    SELECT s.* FROM prospecting.scores s
    WHERE s.org_id = p.org_id AND s.prospect_id = p.id
    ORDER BY s.computed_at DESC, s.id DESC
    LIMIT 1
  ) sc ON TRUE`;

const PROSPECT_WITH_SCORE_COLUMNS = `
  p.*,
  sc.id AS score_id, sc.score AS score_value, sc.band AS score_band,
  sc.ruleset_version AS score_ruleset_version, sc.profile_version AS score_profile_version,
  sc.contributions AS score_contributions, sc.signal_ids AS score_signal_ids,
  sc.computed_at AS score_computed_at`;

function mapProspectWithScore(row: Record<string, unknown>): ProspectWithScore {
  const prospect = mapProspect(row);
  if (row.score_id === null || row.score_id === undefined) {
    return { prospect, score: null };
  }
  const score = mapScore({
    id: row.score_id,
    org_id: row.org_id,
    prospect_id: row.id,
    score: row.score_value,
    band: row.score_band,
    ruleset_version: row.score_ruleset_version,
    profile_version: row.score_profile_version,
    contributions: row.score_contributions,
    signal_ids: row.score_signal_ids,
    computed_at: row.score_computed_at,
  });
  return { prospect, score };
}

export function createProspectingRepository(executor: SqlExecutor): ProspectingRepository {
  return {
    // ── prospects ──────────────────────────────────────────
    /**
     * Dedupe by construction: the `(org_id, dedupe_key)` unique index turns an
     * overlapping re-discovery into an update. `created` tells the caller which
     * run counter to advance — `prospects_created` or `prospects_updated`.
     */
    async upsertProspect(input: UpsertProspectInput): Promise<ProspectingResult<UpsertProspectResult>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `INSERT INTO prospecting.prospects
             (id, org_id, name, domain, dedupe_key, industry, locality, region, country,
              size_band, source, source_ref, first_seen_at, last_enriched_at, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $13, $13, $13)
           ON CONFLICT (org_id, dedupe_key) DO UPDATE SET
             name = COALESCE(NULLIF(EXCLUDED.name, ''), prospecting.prospects.name),
             domain = COALESCE(EXCLUDED.domain, prospecting.prospects.domain),
             industry = COALESCE(EXCLUDED.industry, prospecting.prospects.industry),
             locality = COALESCE(EXCLUDED.locality, prospecting.prospects.locality),
             region = COALESCE(EXCLUDED.region, prospecting.prospects.region),
             country = COALESCE(EXCLUDED.country, prospecting.prospects.country),
             size_band = CASE WHEN EXCLUDED.size_band = 'unknown'
                              THEN prospecting.prospects.size_band ELSE EXCLUDED.size_band END,
             source_ref = COALESCE(EXCLUDED.source_ref, prospecting.prospects.source_ref),
             last_enriched_at = EXCLUDED.last_enriched_at,
             updated_at = EXCLUDED.updated_at
           RETURNING *, (xmax = 0) AS inserted`,
          [
            input.id,
            input.orgId,
            input.name,
            input.domain,
            input.dedupeKey,
            input.industry,
            input.locality,
            input.region,
            input.country,
            input.sizeBand,
            input.source,
            input.sourceRef,
            input.observedAt.toISOString(),
          ],
        );
        if (result.rowCount === 0) return internalError("Failed to upsert prospect");
        const row = result.rows[0]!;
        return {
          ok: true,
          value: { prospect: mapProspect(row), created: row.inserted === true || row.inserted === "t" },
        };
      } catch {
        return internalError("Failed to upsert prospect");
      }
    },

    async getProspect(orgId: Uuid, prospectId: Uuid): Promise<ProspectingResult<ProspectWithScore>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `SELECT ${PROSPECT_WITH_SCORE_COLUMNS}
           FROM prospecting.prospects p ${LATEST_SCORE_JOIN}
           WHERE p.org_id = $1 AND p.id = $2`,
          [orgId, prospectId],
        );
        if (result.rowCount === 0) return { ok: false, error: { kind: "not_found" } };
        return { ok: true, value: mapProspectWithScore(result.rows[0]!) };
      } catch {
        return internalError("Failed to get prospect");
      }
    },

    async listProspectsPaged(
      orgId: Uuid,
      params: PageQueryParams,
      filters?: ProspectFilters,
    ): Promise<ProspectingResult<PagedResult<ProspectWithScore>>> {
      try {
        const values: unknown[] = [orgId, params.limit + 1];
        const where: string[] = ["p.org_id = $1"];

        where.push(`p.status = $${values.push(filters?.status ?? "active")}`);

        if (params.cursor) {
          const t = values.push(params.cursor.createdAt);
          const i = values.push(params.cursor.id);
          where.push(`(p.created_at, p.id) < ($${t}, $${i})`);
        }
        if (filters?.band) {
          where.push(`sc.band = $${values.push(filters.band)}`);
        }
        if (filters?.signalKind) {
          where.push(
            `EXISTS (SELECT 1 FROM prospecting.signals sg
                     WHERE sg.org_id = p.org_id AND sg.prospect_id = p.id
                       AND sg.kind = $${values.push(filters.signalKind)})`,
          );
        }
        if (filters?.stageKey) {
          where.push(
            `EXISTS (SELECT 1 FROM prospecting.pipeline_entries pe
                     JOIN prospecting.pipeline_stages ps
                       ON ps.org_id = pe.org_id AND ps.id = pe.stage_id
                     WHERE pe.org_id = p.org_id AND pe.prospect_id = p.id
                       AND pe.closed_at IS NULL AND ps.key = $${values.push(filters.stageKey)})`,
          );
        }
        if (filters?.ownerUserId) {
          where.push(
            `EXISTS (SELECT 1 FROM prospecting.pipeline_entries pe2
                     WHERE pe2.org_id = p.org_id AND pe2.prospect_id = p.id
                       AND pe2.closed_at IS NULL
                       AND pe2.owner_user_id = $${values.push(filters.ownerUserId)})`,
          );
        }

        const result = await executor.execute<Record<string, unknown>>(
          `SELECT ${PROSPECT_WITH_SCORE_COLUMNS}
           FROM prospecting.prospects p ${LATEST_SCORE_JOIN}
           WHERE ${where.join(" AND ")}
           ORDER BY p.created_at DESC, p.id DESC
           LIMIT $2`,
          values,
        );

        const items = result.rows.map(mapProspectWithScore);
        let nextCursor: CursorPosition | null = null;
        if (items.length > params.limit) {
          items.pop();
          const last = items[items.length - 1]!;
          nextCursor = { createdAt: last.prospect.createdAt.toISOString(), id: last.prospect.id };
        }
        return { ok: true, value: { items, nextCursor } };
      } catch {
        return internalError("Failed to list prospects");
      }
    },

    async updateProspect(
      orgId: Uuid,
      prospectId: Uuid,
      input: UpdateProspectInput,
      now: Date,
    ): Promise<ProspectingResult<Prospect>> {
      const sets: string[] = [];
      const values: unknown[] = [orgId, prospectId];
      for (const [column, value] of [
        ["name", input.name],
        ["domain", input.domain],
        ["industry", input.industry],
        ["locality", input.locality],
        ["region", input.region],
        ["country", input.country],
        ["size_band", input.sizeBand],
      ] as Array<[string, unknown]>) {
        if (value !== undefined) sets.push(`${column} = $${values.push(value)}`);
      }
      if (sets.length === 0) {
        const current = await this.getProspect(orgId, prospectId);
        if (!current.ok) return current;
        return { ok: true, value: current.value.prospect };
      }
      sets.push(`updated_at = $${values.push(now.toISOString())}`);
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `UPDATE prospecting.prospects SET ${sets.join(", ")}
           WHERE org_id = $1 AND id = $2 AND status = 'active'
           RETURNING *`,
          values,
        );
        if (result.rowCount === 0) return { ok: false, error: { kind: "not_found" } };
        return { ok: true, value: mapProspect(result.rows[0]!) };
      } catch (err: unknown) {
        if (isUniqueViolation(err)) return { ok: false, error: { kind: "conflict", entity: "prospect" } };
        return internalError("Failed to update prospect");
      }
    },

    async archiveProspect(orgId: Uuid, prospectId: Uuid, archivedAt: Date): Promise<ProspectingResult<Prospect>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `UPDATE prospecting.prospects
           SET status = 'archived', archived_at = $3, updated_at = $3
           WHERE org_id = $1 AND id = $2 AND status = 'active'
           RETURNING *`,
          [orgId, prospectId, archivedAt.toISOString()],
        );
        if (result.rowCount === 0) return { ok: false, error: { kind: "not_found" } };
        return { ok: true, value: mapProspect(result.rows[0]!) };
      } catch {
        return internalError("Failed to archive prospect");
      }
    },

    async countProspectsSince(orgId: Uuid, since: Date): Promise<ProspectingResult<number>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `SELECT COUNT(*)::int AS count FROM prospecting.prospects
           WHERE org_id = $1 AND created_at >= $2`,
          [orgId, since.toISOString()],
        );
        return { ok: true, value: Number(result.rows[0]?.count ?? 0) };
      } catch {
        return internalError("Failed to count prospects");
      }
    },

    // ── signals ────────────────────────────────────────────
    async insertSignal(input: InsertSignalInput): Promise<ProspectingResult<Signal>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `INSERT INTO prospecting.signals
             (id, org_id, prospect_id, kind, severity, features, source, source_digest, observed_at, expires_at)
           VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10)
           ON CONFLICT (org_id, prospect_id, kind, observed_at) DO NOTHING
           RETURNING *`,
          [
            input.id,
            input.orgId,
            input.prospectId,
            input.kind,
            input.severity,
            JSON.stringify(input.features),
            input.source,
            input.sourceDigest,
            input.observedAt.toISOString(),
            input.expiresAt ? input.expiresAt.toISOString() : null,
          ],
        );
        if (result.rowCount === 0) return { ok: false, error: { kind: "conflict", entity: "signal" } };
        return { ok: true, value: mapSignal(result.rows[0]!) };
      } catch (err: unknown) {
        if (isUniqueViolation(err)) return { ok: false, error: { kind: "conflict", entity: "signal" } };
        return internalError("Failed to insert signal");
      }
    },

    async listSignals(orgId: Uuid, prospectId: Uuid, limit: number): Promise<ProspectingResult<Signal[]>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `SELECT * FROM prospecting.signals
           WHERE org_id = $1 AND prospect_id = $2
           ORDER BY observed_at DESC, id DESC
           LIMIT $3`,
          [orgId, prospectId, limit],
        );
        return { ok: true, value: result.rows.map(mapSignal) };
      } catch {
        return internalError("Failed to list signals");
      }
    },

    /**
     * Exactly what the scoring engine is allowed to see: expiry-filtered, one
     * row per kind (the most recent). Doing this in SQL keeps the engine pure
     * and makes the "most recent signal per kind" rule a single, testable place.
     */
    async listScorableSignals(orgId: Uuid, prospectId: Uuid, now: Date): Promise<ProspectingResult<Signal[]>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `SELECT DISTINCT ON (kind) * FROM prospecting.signals
           WHERE org_id = $1 AND prospect_id = $2
             AND (expires_at IS NULL OR expires_at > $3)
           ORDER BY kind, observed_at DESC, id DESC`,
          [orgId, prospectId, now.toISOString()],
        );
        return { ok: true, value: result.rows.map(mapSignal) };
      } catch {
        return internalError("Failed to list scorable signals");
      }
    },

    // ── discovery ──────────────────────────────────────────
    async createDiscoveryRun(input: CreateDiscoveryRunInput): Promise<ProspectingResult<DiscoveryRun>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `INSERT INTO prospecting.discovery_runs
             (id, org_id, requested_by, adapter, query, status, started_at)
           VALUES ($1, $2, $3, $4, $5::jsonb, 'running', $6)
           RETURNING *`,
          [
            input.id,
            input.orgId,
            input.requestedBy,
            input.adapter,
            JSON.stringify(input.query),
            input.startedAt.toISOString(),
          ],
        );
        if (result.rowCount === 0) return internalError("Failed to create discovery run");
        return { ok: true, value: mapDiscoveryRun(result.rows[0]!) };
      } catch {
        return internalError("Failed to create discovery run");
      }
    },

    async finishDiscoveryRun(
      orgId: Uuid,
      runId: Uuid,
      input: FinishDiscoveryRunInput,
    ): Promise<ProspectingResult<DiscoveryRun>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `UPDATE prospecting.discovery_runs
           SET status = $3, candidates_found = $4, prospects_created = $5,
               prospects_updated = $6, signals_recorded = $7, error_code = $8, finished_at = $9
           WHERE org_id = $1 AND id = $2
           RETURNING *`,
          [
            orgId,
            runId,
            input.status,
            input.candidatesFound,
            input.prospectsCreated,
            input.prospectsUpdated,
            input.signalsRecorded,
            input.errorCode,
            input.finishedAt.toISOString(),
          ],
        );
        if (result.rowCount === 0) return { ok: false, error: { kind: "not_found" } };
        return { ok: true, value: mapDiscoveryRun(result.rows[0]!) };
      } catch {
        return internalError("Failed to finish discovery run");
      }
    },

    async getDiscoveryRun(orgId: Uuid, runId: Uuid): Promise<ProspectingResult<DiscoveryRun>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `SELECT * FROM prospecting.discovery_runs WHERE org_id = $1 AND id = $2`,
          [orgId, runId],
        );
        if (result.rowCount === 0) return { ok: false, error: { kind: "not_found" } };
        return { ok: true, value: mapDiscoveryRun(result.rows[0]!) };
      } catch {
        return internalError("Failed to get discovery run");
      }
    },

    async listDiscoveryRunsPaged(
      orgId: Uuid,
      params: PageQueryParams,
    ): Promise<ProspectingResult<PagedResult<DiscoveryRun>>> {
      try {
        const values: unknown[] = [orgId, params.limit + 1];
        let cursorClause = "";
        if (params.cursor) {
          const t = values.push(params.cursor.createdAt);
          const i = values.push(params.cursor.id);
          cursorClause = ` AND (started_at, id) < ($${t}, $${i})`;
        }
        const result = await executor.execute<Record<string, unknown>>(
          `SELECT * FROM prospecting.discovery_runs
           WHERE org_id = $1${cursorClause}
           ORDER BY started_at DESC, id DESC
           LIMIT $2`,
          values,
        );
        const items = result.rows.map(mapDiscoveryRun);
        let nextCursor: CursorPosition | null = null;
        if (items.length > params.limit) {
          items.pop();
          const last = items[items.length - 1]!;
          nextCursor = { createdAt: last.startedAt.toISOString(), id: last.id };
        }
        return { ok: true, value: { items, nextCursor } };
      } catch {
        return internalError("Failed to list discovery runs");
      }
    },

    // ── scoring ────────────────────────────────────────────
    async getActiveScoringProfile(orgId: Uuid): Promise<ProspectingResult<ScoringProfile | null>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `SELECT * FROM prospecting.scoring_profiles WHERE org_id = $1 AND is_active`,
          [orgId],
        );
        if (result.rowCount === 0) return { ok: true, value: null };
        return { ok: true, value: mapScoringProfile(result.rows[0]!) };
      } catch {
        return internalError("Failed to get scoring profile");
      }
    },

    /**
     * Append-only: deactivate the current profile, then insert the next
     * version. Existing scores are untouched — they keep pointing at the
     * profile version that produced them, which is what keeps an old score
     * explainable after a weight change.
     */
    async insertScoringProfile(input: InsertScoringProfileInput): Promise<ProspectingResult<ScoringProfile>> {
      try {
        await executor.execute(
          `UPDATE prospecting.scoring_profiles SET is_active = false WHERE org_id = $1 AND is_active`,
          [input.orgId],
        );
        const result = await executor.execute<Record<string, unknown>>(
          `INSERT INTO prospecting.scoring_profiles
             (id, org_id, version, ruleset_version, weights, is_active, created_by, created_at)
           VALUES (
             $1, $2,
             (SELECT COALESCE(MAX(version), 0) + 1 FROM prospecting.scoring_profiles WHERE org_id = $2),
             $3, $4::jsonb, true, $5, $6)
           RETURNING *`,
          [
            input.id,
            input.orgId,
            input.rulesetVersion,
            JSON.stringify(input.weights),
            input.createdBy,
            input.createdAt.toISOString(),
          ],
        );
        if (result.rowCount === 0) return internalError("Failed to insert scoring profile");
        return { ok: true, value: mapScoringProfile(result.rows[0]!) };
      } catch (err: unknown) {
        if (isUniqueViolation(err)) return { ok: false, error: { kind: "conflict", entity: "scoring_profile" } };
        return internalError("Failed to insert scoring profile");
      }
    },

    async insertScore(input: InsertScoreInput): Promise<ProspectingResult<Score>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `INSERT INTO prospecting.scores
             (id, org_id, prospect_id, score, band, ruleset_version, profile_version,
              contributions, signal_ids, computed_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::uuid[], $10)
           RETURNING *`,
          [
            input.id,
            input.orgId,
            input.prospectId,
            input.score,
            input.band,
            input.rulesetVersion,
            input.profileVersion,
            JSON.stringify(input.contributions),
            `{${input.signalIds.join(",")}}`,
            input.computedAt.toISOString(),
          ],
        );
        if (result.rowCount === 0) return internalError("Failed to insert score");
        return { ok: true, value: mapScore(result.rows[0]!) };
      } catch {
        return internalError("Failed to insert score");
      }
    },

    async listScores(orgId: Uuid, prospectId: Uuid, limit: number): Promise<ProspectingResult<Score[]>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `SELECT * FROM prospecting.scores
           WHERE org_id = $1 AND prospect_id = $2
           ORDER BY computed_at DESC, id DESC
           LIMIT $3`,
          [orgId, prospectId, limit],
        );
        return { ok: true, value: result.rows.map(mapScore) };
      } catch {
        return internalError("Failed to list scores");
      }
    },

    async getLatestScore(orgId: Uuid, prospectId: Uuid): Promise<ProspectingResult<Score | null>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `SELECT * FROM prospecting.scores
           WHERE org_id = $1 AND prospect_id = $2
           ORDER BY computed_at DESC, id DESC
           LIMIT 1`,
          [orgId, prospectId],
        );
        if (result.rowCount === 0) return { ok: true, value: null };
        return { ok: true, value: mapScore(result.rows[0]!) };
      } catch {
        return internalError("Failed to get latest score");
      }
    },

    async listActiveProspectIds(orgId: Uuid, limit: number): Promise<ProspectingResult<string[]>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `SELECT id FROM prospecting.prospects
           WHERE org_id = $1 AND status = 'active'
           ORDER BY created_at ASC, id ASC
           LIMIT $2`,
          [orgId, limit],
        );
        return { ok: true, value: result.rows.map((r) => r.id as string) };
      } catch {
        return internalError("Failed to list prospect ids");
      }
    },

    // ── insights ───────────────────────────────────────────
    async findInsightByDigest(orgId: Uuid, inputDigest: string): Promise<ProspectingResult<Insight | null>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `SELECT * FROM prospecting.insights WHERE org_id = $1 AND input_digest = $2`,
          [orgId, inputDigest],
        );
        if (result.rowCount === 0) return { ok: true, value: null };
        return { ok: true, value: mapInsight(result.rows[0]!) };
      } catch {
        return internalError("Failed to look up insight");
      }
    },

    async insertInsight(input: InsertInsightInput): Promise<ProspectingResult<Insight>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `INSERT INTO prospecting.insights
             (id, org_id, prospect_id, score_id, kind, content, model, prompt_version,
              input_digest, guardrail_verdict, guardrail_notes, generated_by, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, $13)
           ON CONFLICT (org_id, input_digest) DO NOTHING
           RETURNING *`,
          [
            input.id,
            input.orgId,
            input.prospectId,
            input.scoreId,
            input.kind,
            input.content,
            input.model,
            input.promptVersion,
            input.inputDigest,
            input.guardrailVerdict,
            JSON.stringify(input.guardrailNotes),
            input.generatedBy,
            input.createdAt.toISOString(),
          ],
        );
        if (result.rowCount === 0) return { ok: false, error: { kind: "conflict", entity: "insight" } };
        return { ok: true, value: mapInsight(result.rows[0]!) };
      } catch (err: unknown) {
        if (isUniqueViolation(err)) return { ok: false, error: { kind: "conflict", entity: "insight" } };
        return internalError("Failed to insert insight");
      }
    },

    async listInsights(orgId: Uuid, prospectId: Uuid, limit: number): Promise<ProspectingResult<Insight[]>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `SELECT * FROM prospecting.insights
           WHERE org_id = $1 AND prospect_id = $2
           ORDER BY created_at DESC, id DESC
           LIMIT $3`,
          [orgId, prospectId, limit],
        );
        return { ok: true, value: result.rows.map(mapInsight) };
      } catch {
        return internalError("Failed to list insights");
      }
    },

    async countInsightsSince(orgId: Uuid, since: Date): Promise<ProspectingResult<number>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `SELECT COUNT(*)::int AS count FROM prospecting.insights
           WHERE org_id = $1 AND created_at >= $2`,
          [orgId, since.toISOString()],
        );
        return { ok: true, value: Number(result.rows[0]?.count ?? 0) };
      } catch {
        return internalError("Failed to count insights");
      }
    },

    // ── pipeline ───────────────────────────────────────────
    async listStages(orgId: Uuid): Promise<ProspectingResult<PipelineStage[]>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `SELECT * FROM prospecting.pipeline_stages WHERE org_id = $1 ORDER BY position ASC`,
          [orgId],
        );
        return { ok: true, value: result.rows.map(mapStage) };
      } catch {
        return internalError("Failed to list pipeline stages");
      }
    },

    async seedStages(orgId: Uuid, stages: SeedStageInput[]): Promise<ProspectingResult<PipelineStage[]>> {
      try {
        for (const stage of stages) {
          await executor.execute(
            `INSERT INTO prospecting.pipeline_stages (id, org_id, key, label, position, outcome)
             VALUES ($1, $2, $3, $4, $5, $6)
             ON CONFLICT (org_id, key) DO NOTHING`,
            [stage.id, orgId, stage.key, stage.label, stage.position, stage.outcome],
          );
        }
        return this.listStages(orgId);
      } catch {
        return internalError("Failed to seed pipeline stages");
      }
    },

    /**
     * Rewrite the stage set. Stages still referenced by an entry are updated
     * rather than deleted, so a rename can never orphan a card.
     */
    async replaceStages(orgId: Uuid, stages: SeedStageInput[]): Promise<ProspectingResult<PipelineStage[]>> {
      try {
        // Park positions out of the unique range first: a reorder would
        // otherwise collide with the (org_id, position) index mid-update.
        await executor.execute(
          `UPDATE prospecting.pipeline_stages SET position = position + 1000 WHERE org_id = $1`,
          [orgId],
        );
        const keptKeys: string[] = [];
        for (const stage of stages) {
          keptKeys.push(stage.key);
          await executor.execute(
            `INSERT INTO prospecting.pipeline_stages (id, org_id, key, label, position, outcome)
             VALUES ($1, $2, $3, $4, $5, $6)
             ON CONFLICT (org_id, key) DO UPDATE SET
               label = EXCLUDED.label,
               position = EXCLUDED.position,
               outcome = EXCLUDED.outcome,
               updated_at = now()`,
            [stage.id, orgId, stage.key, stage.label, stage.position, stage.outcome],
          );
        }
        await executor.execute(
          `DELETE FROM prospecting.pipeline_stages s
           WHERE s.org_id = $1
             AND NOT (s.key = ANY($2::text[]))
             AND NOT EXISTS (
               SELECT 1 FROM prospecting.pipeline_entries e
               WHERE e.org_id = s.org_id AND e.stage_id = s.id)`,
          [orgId, `{${keptKeys.map((k) => `"${k}"`).join(",")}}`],
        );
        return this.listStages(orgId);
      } catch (err: unknown) {
        if (isUniqueViolation(err)) return { ok: false, error: { kind: "conflict", entity: "pipeline_stage" } };
        return internalError("Failed to replace pipeline stages");
      }
    },

    async createPipelineEntry(input: CreatePipelineEntryInput): Promise<ProspectingResult<PipelineEntry>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `INSERT INTO prospecting.pipeline_entries
             (id, org_id, prospect_id, stage_id, owner_user_id, value_cents,
              entered_stage_at, closed_at, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $7, $7)
           RETURNING *`,
          [
            input.id,
            input.orgId,
            input.prospectId,
            input.stageId,
            input.ownerUserId,
            input.valueCents,
            input.now.toISOString(),
            input.closedAt ? input.closedAt.toISOString() : null,
          ],
        );
        if (result.rowCount === 0) return internalError("Failed to create pipeline entry");
        return { ok: true, value: mapEntry(result.rows[0]!) };
      } catch (err: unknown) {
        if (isUniqueViolation(err)) return { ok: false, error: { kind: "conflict", entity: "pipeline_entry" } };
        return internalError("Failed to create pipeline entry");
      }
    },

    async getPipelineEntry(orgId: Uuid, entryId: Uuid): Promise<ProspectingResult<PipelineEntry>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `SELECT * FROM prospecting.pipeline_entries WHERE org_id = $1 AND id = $2`,
          [orgId, entryId],
        );
        if (result.rowCount === 0) return { ok: false, error: { kind: "not_found" } };
        return { ok: true, value: mapEntry(result.rows[0]!) };
      } catch {
        return internalError("Failed to get pipeline entry");
      }
    },

    async getOpenEntryForProspect(orgId: Uuid, prospectId: Uuid): Promise<ProspectingResult<PipelineEntry | null>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `SELECT * FROM prospecting.pipeline_entries
           WHERE org_id = $1 AND prospect_id = $2 AND closed_at IS NULL`,
          [orgId, prospectId],
        );
        if (result.rowCount === 0) return { ok: true, value: null };
        return { ok: true, value: mapEntry(result.rows[0]!) };
      } catch {
        return internalError("Failed to get pipeline entry");
      }
    },

    async updatePipelineEntry(
      orgId: Uuid,
      entryId: Uuid,
      input: UpdatePipelineEntryInput,
    ): Promise<ProspectingResult<PipelineEntry>> {
      const sets: string[] = [];
      const values: unknown[] = [orgId, entryId];
      if (input.stageId !== undefined) sets.push(`stage_id = $${values.push(input.stageId)}`);
      if (input.ownerUserId !== undefined) sets.push(`owner_user_id = $${values.push(input.ownerUserId)}`);
      if (input.valueCents !== undefined) sets.push(`value_cents = $${values.push(input.valueCents)}`);
      if (input.enteredStageAt !== undefined) {
        sets.push(`entered_stage_at = $${values.push(input.enteredStageAt.toISOString())}`);
      }
      if (input.closedAt !== undefined) {
        sets.push(`closed_at = $${values.push(input.closedAt ? input.closedAt.toISOString() : null)}`);
      }
      sets.push(`updated_at = $${values.push(input.updatedAt.toISOString())}`);
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `UPDATE prospecting.pipeline_entries SET ${sets.join(", ")}
           WHERE org_id = $1 AND id = $2
           RETURNING *`,
          values,
        );
        if (result.rowCount === 0) return { ok: false, error: { kind: "not_found" } };
        return { ok: true, value: mapEntry(result.rows[0]!) };
      } catch (err: unknown) {
        if (isUniqueViolation(err)) return { ok: false, error: { kind: "conflict", entity: "pipeline_entry" } };
        return internalError("Failed to update pipeline entry");
      }
    },

    async listBoard(orgId: Uuid, limit: number): Promise<ProspectingResult<PipelineEntryWithProspect[]>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `SELECT e.*, s.key AS stage_key,
                  p.name AS prospect_name, p.domain AS prospect_domain,
                  sc.score AS score, sc.band AS band
           FROM prospecting.pipeline_entries e
           JOIN prospecting.pipeline_stages s ON s.org_id = e.org_id AND s.id = e.stage_id
           JOIN prospecting.prospects p ON p.org_id = e.org_id AND p.id = e.prospect_id
           LEFT JOIN LATERAL (
             SELECT sc2.score, sc2.band FROM prospecting.scores sc2
             WHERE sc2.org_id = e.org_id AND sc2.prospect_id = e.prospect_id
             ORDER BY sc2.computed_at DESC, sc2.id DESC
             LIMIT 1
           ) sc ON TRUE
           WHERE e.org_id = $1 AND e.closed_at IS NULL
           ORDER BY s.position ASC, e.entered_stage_at ASC
           LIMIT $2`,
          [orgId, limit],
        );
        return { ok: true, value: result.rows.map(mapBoardEntry) };
      } catch {
        return internalError("Failed to read pipeline board");
      }
    },

    // ── activities ─────────────────────────────────────────
    async insertActivity(input: InsertActivityInput): Promise<ProspectingResult<Activity>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `INSERT INTO prospecting.activities
             (id, org_id, prospect_id, kind, actor_user_id, body, metadata, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)
           RETURNING *`,
          [
            input.id,
            input.orgId,
            input.prospectId,
            input.kind,
            input.actorUserId,
            input.body,
            JSON.stringify(input.metadata),
            input.createdAt.toISOString(),
          ],
        );
        if (result.rowCount === 0) return internalError("Failed to insert activity");
        return { ok: true, value: mapActivity(result.rows[0]!) };
      } catch {
        return internalError("Failed to insert activity");
      }
    },

    async listActivities(orgId: Uuid, prospectId: Uuid, limit: number): Promise<ProspectingResult<Activity[]>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `SELECT * FROM prospecting.activities
           WHERE org_id = $1 AND prospect_id = $2
           ORDER BY created_at DESC, id DESC
           LIMIT $3`,
          [orgId, prospectId, limit],
        );
        return { ok: true, value: result.rows.map(mapActivity) };
      } catch {
        return internalError("Failed to list activities");
      }
    },
  };
}
