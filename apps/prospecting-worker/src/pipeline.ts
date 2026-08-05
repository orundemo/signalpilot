import type { ProspectingRepository, PipelineStage } from "@saas/db/prospecting";
import type { Uuid } from "@saas/db/ids";
import type { PipelineBoardEntry, PublicPipelineEntry, PublicPipelineStage, ScoreBand, StageOutcome } from "@saas/contracts/prospecting";
import { DEFAULT_PIPELINE_STAGES } from "@saas/contracts/prospecting";
import { orgPublicId, pipelineEntryPublicId, prospectPublicId, stagePublicId, userPublicId } from "./ids.js";
import type { PipelineEntry, PipelineEntryWithProspect } from "@saas/db/prospecting";

/**
 * Seed the default stage set on first use.
 *
 * Lazily, not at org creation: a tenant that never opens the pipeline should
 * not carry rows for it, and seeding here means the stages exist the first
 * time anything reads or writes them regardless of which route got there
 * first. The insert is `ON CONFLICT DO NOTHING`, so two concurrent first
 * requests converge instead of racing.
 */
export async function ensureStages(
  repo: ProspectingRepository,
  orgId: Uuid,
): Promise<{ ok: true; stages: PipelineStage[] } | { ok: false }> {
  const existing = await repo.listStages(orgId);
  if (!existing.ok) return { ok: false };
  if (existing.value.length > 0) return { ok: true, stages: existing.value };

  const seeded = await repo.seedStages(
    orgId,
    DEFAULT_PIPELINE_STAGES.map((stage) => ({
      id: crypto.randomUUID(),
      key: stage.key,
      label: stage.label,
      position: stage.position,
      outcome: stage.outcome,
    })),
  );
  if (!seeded.ok) return { ok: false };
  return { ok: true, stages: seeded.value };
}

export function toPublicStage(stage: PipelineStage): PublicPipelineStage {
  return {
    id: stagePublicId(stage.id),
    orgId: orgPublicId(stage.orgId),
    key: stage.key,
    label: stage.label,
    position: stage.position,
    outcome: stage.outcome as StageOutcome,
  };
}

export function toPublicEntry(entry: PipelineEntry, stageKey: string): PublicPipelineEntry {
  return {
    id: pipelineEntryPublicId(entry.id),
    orgId: orgPublicId(entry.orgId),
    prospectId: prospectPublicId(entry.prospectId),
    stageId: stagePublicId(entry.stageId),
    stageKey,
    ownerUserId: entry.ownerUserId ? userPublicId(entry.ownerUserId) : null,
    valueCents: entry.valueCents,
    enteredStageAt: entry.enteredStageAt.toISOString(),
    closedAt: entry.closedAt ? entry.closedAt.toISOString() : null,
    createdAt: entry.createdAt.toISOString(),
    updatedAt: entry.updatedAt.toISOString(),
  };
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * `daysInStage` is computed here rather than stored, from `entered_stage_at`
 * — which resets on every move. That single column is what makes "stuck in
 * this stage for eleven days" a fact the board can highlight rather than
 * something a rep has to remember.
 */
export function toBoardEntry(row: PipelineEntryWithProspect, now: Date): PipelineBoardEntry {
  return {
    ...toPublicEntry(row, row.stageKey),
    prospectName: row.prospectName,
    prospectDomain: row.prospectDomain,
    score: row.score,
    band: (row.band as ScoreBand | null) ?? null,
    daysInStage: Math.max(0, Math.floor((now.getTime() - row.enteredStageAt.getTime()) / MS_PER_DAY)),
  };
}
