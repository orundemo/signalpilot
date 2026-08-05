import type { Env } from "../env.js";
import type { ActorContext } from "../router.js";
import type { Uuid } from "@saas/db/ids";
import type { EventsRepository } from "@saas/db/events";
import type { PipelineStage, ProspectingRepository, UpdatePipelineEntryInput } from "@saas/db/prospecting";
import type {
  CreatePipelineEntryRequest,
  PutPipelineStagesRequest,
  UpdatePipelineEntryRequest,
} from "@saas/contracts/prospecting";
import { isStageKey, isStageOutcome } from "@saas/contracts/prospecting";
import { createProspectingRepository } from "@saas/db/prospecting";
import { createEventsRepository } from "@saas/db/events";
import { createSqlExecutor } from "@saas/db/hyperdrive";
import { asUuid } from "@saas/db/ids";
import { authorizeRequest, requireBindings } from "../authorize.js";
import { errorResponse, successResponse, validationError } from "../http.js";
import { orgPublicId, pipelineEntryPublicId, prospectPublicId, parseProspectPublicId } from "../ids.js";
import { emitProspectingEvent } from "../events.js";
import { ensureStages, toBoardEntry, toPublicEntry, toPublicStage } from "../pipeline.js";

const BOARD_LIMIT = 500;
const VALUE_CENTS_MAX = 1_000_000_000_00;

export interface PipelineDeps {
  repo?: ProspectingRepository;
  eventsRepo?: EventsRepository;
  now?: Date;
}

function stageByKey(stages: PipelineStage[], key: string): PipelineStage | undefined {
  return stages.find((s) => s.key === key);
}

// ── GET /pipeline ──────────────────────────────────────────

export async function handleGetPipeline(
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: Uuid,
  deps?: PipelineDeps,
): Promise<Response> {
  const missing = requireBindings(env, requestId);
  if (missing) return missing;

  const authz = await authorizeRequest(env, requestId, actor, orgId, "organization.pipeline.read");
  if (!authz.ok) return authz.response;

  const executor = deps?.repo ? null : createSqlExecutor(env.PLATFORM_DB!);
  try {
    const repo = deps?.repo ?? createProspectingRepository(executor!);

    const stages = await ensureStages(repo, orgId);
    if (!stages.ok) return errorResponse("internal_error", "Service unavailable", 503, requestId);

    const board = await repo.listBoard(orgId, BOARD_LIMIT);
    if (!board.ok) return errorResponse("internal_error", "Service unavailable", 503, requestId);

    const now = deps?.now ?? new Date();
    return successResponse(
      {
        stages: stages.stages.map(toPublicStage),
        entries: board.value.map((row) => toBoardEntry(row, now)),
      },
      requestId,
    );
  } catch {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  } finally {
    if (executor) await executor.dispose();
  }
}

// ── GET /pipeline/stages ───────────────────────────────────

export async function handleListStages(
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: Uuid,
  deps?: PipelineDeps,
): Promise<Response> {
  const missing = requireBindings(env, requestId);
  if (missing) return missing;

  const authz = await authorizeRequest(env, requestId, actor, orgId, "organization.pipeline.read");
  if (!authz.ok) return authz.response;

  const executor = deps?.repo ? null : createSqlExecutor(env.PLATFORM_DB!);
  try {
    const repo = deps?.repo ?? createProspectingRepository(executor!);
    const stages = await ensureStages(repo, orgId);
    if (!stages.ok) return errorResponse("internal_error", "Service unavailable", 503, requestId);
    return successResponse({ stages: stages.stages.map(toPublicStage) }, requestId);
  } catch {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  } finally {
    if (executor) await executor.dispose();
  }
}

// ── PUT /pipeline/stages ───────────────────────────────────

function validateStages(
  body: unknown,
): { valid: true; stages: PutPipelineStagesRequest["stages"] } | { valid: false; fields: Record<string, string[]> } {
  if (!body || typeof body !== "object") {
    return { valid: false, fields: { body: ["Request body must be an object"] } };
  }
  const raw = (body as PutPipelineStagesRequest).stages;
  if (!Array.isArray(raw) || raw.length === 0) {
    return { valid: false, fields: { stages: ["Must be a non-empty array"] } };
  }
  if (raw.length > 20) {
    return { valid: false, fields: { stages: ["A pipeline may have at most 20 stages"] } };
  }

  const fields: Record<string, string[]> = {};
  const keys = new Set<string>();
  const positions = new Set<number>();

  raw.forEach((stage, index) => {
    if (!stage || typeof stage !== "object") {
      fields[`stages.${index}`] = ["Must be an object"];
      return;
    }
    if (!isStageKey(stage.key)) fields[`stages.${index}.key`] = ["Must be a lowercase slug"];
    else if (keys.has(stage.key)) fields[`stages.${index}.key`] = ["Duplicate stage key"];
    else keys.add(stage.key);

    if (typeof stage.label !== "string" || stage.label.length === 0 || stage.label.length > 60) {
      fields[`stages.${index}.label`] = ["Must be a string of 1–60 characters"];
    }
    if (!Number.isInteger(stage.position) || stage.position < 1 || stage.position > 100) {
      fields[`stages.${index}.position`] = ["Must be an integer between 1 and 100"];
    } else if (positions.has(stage.position)) {
      fields[`stages.${index}.position`] = ["Duplicate position"];
    } else {
      positions.add(stage.position);
    }
    if (!isStageOutcome(stage.outcome)) fields[`stages.${index}.outcome`] = ["Must be one of: open, won, lost"];
  });

  // A board with no open stage has nowhere to put a new prospect.
  if (Object.keys(fields).length === 0 && !raw.some((s) => s.outcome === "open")) {
    fields.stages = ["At least one stage must have outcome 'open'"];
  }

  if (Object.keys(fields).length > 0) return { valid: false, fields };
  return { valid: true, stages: raw };
}

export async function handlePutStages(
  request: Request,
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: Uuid,
  deps?: PipelineDeps,
): Promise<Response> {
  const missing = requireBindings(env, requestId);
  if (missing) return missing;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return validationError(requestId, { body: ["Invalid JSON"] });
  }

  const validation = validateStages(body);
  if (!validation.valid) return validationError(requestId, validation.fields);

  const authz = await authorizeRequest(env, requestId, actor, orgId, "organization.pipeline.write");
  if (!authz.ok) return authz.response;

  const executor = deps?.repo ? null : createSqlExecutor(env.PLATFORM_DB!);
  try {
    const repo = deps?.repo ?? createProspectingRepository(executor!);
    const result = await repo.replaceStages(
      orgId,
      validation.stages.map((stage) => ({
        id: crypto.randomUUID(),
        key: stage.key,
        label: stage.label,
        position: stage.position,
        outcome: stage.outcome,
      })),
    );
    if (!result.ok) {
      if (result.error.kind === "conflict") {
        return errorResponse("conflict", "Stage keys and positions must be unique", 409, requestId);
      }
      return errorResponse("internal_error", "Service unavailable", 503, requestId);
    }
    return successResponse({ stages: result.value.map(toPublicStage) }, requestId);
  } catch {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  } finally {
    if (executor) await executor.dispose();
  }
}

// ── POST /pipeline/entries ─────────────────────────────────

export async function handleCreateEntry(
  request: Request,
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: Uuid,
  deps?: PipelineDeps,
): Promise<Response> {
  const missing = requireBindings(env, requestId);
  if (missing) return missing;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return validationError(requestId, { body: ["Invalid JSON"] });
  }
  if (!body || typeof body !== "object") {
    return validationError(requestId, { body: ["Request body must be an object"] });
  }

  const req = body as CreatePipelineEntryRequest;
  const fields: Record<string, string[]> = {};

  const prospectId = typeof req.prospectId === "string" ? parseProspectPublicId(req.prospectId) : null;
  if (!prospectId) fields.prospectId = ["Must be a public prospect id"];
  if (req.stageKey !== undefined && !isStageKey(req.stageKey)) fields.stageKey = ["Invalid stage key"];
  if (
    req.valueCents !== undefined &&
    req.valueCents !== null &&
    (!Number.isInteger(req.valueCents) || req.valueCents < 0 || req.valueCents > VALUE_CENTS_MAX)
  ) {
    fields.valueCents = ["Must be a non-negative integer"];
  }
  const ownerUserId = resolveOwner(req.ownerUserId, fields);
  if (Object.keys(fields).length > 0) return validationError(requestId, fields);

  const authz = await authorizeRequest(env, requestId, actor, orgId, "organization.pipeline.write");
  if (!authz.ok) return authz.response;

  const now = deps?.now ?? new Date();
  const executor = deps?.repo && deps?.eventsRepo ? null : createSqlExecutor(env.PLATFORM_DB!);
  try {
    const repo = deps?.repo ?? createProspectingRepository(executor!);
    const eventsRepo = deps?.eventsRepo ?? createEventsRepository(executor!);

    const prospect = await repo.getProspect(orgId, prospectId!);
    if (!prospect.ok) {
      if (prospect.error.kind === "not_found") return errorResponse("not_found", "Not found", 404, requestId);
      return errorResponse("internal_error", "Service unavailable", 503, requestId);
    }

    const stagesResult = await ensureStages(repo, orgId);
    if (!stagesResult.ok) return errorResponse("internal_error", "Service unavailable", 503, requestId);

    const targetKey = req.stageKey ?? stagesResult.stages[0]!.key;
    const stage = stageByKey(stagesResult.stages, targetKey);
    if (!stage) return validationError(requestId, { stageKey: ["No such stage in this pipeline"] });

    const created = await repo.createPipelineEntry({
      id: crypto.randomUUID(),
      orgId,
      prospectId: asUuid(prospectId!),
      stageId: asUuid(stage.id),
      ownerUserId,
      valueCents: req.valueCents ?? null,
      now,
      closedAt: stage.outcome === "open" ? null : now,
    });
    if (!created.ok) {
      if (created.error.kind === "conflict") {
        // The partial unique index: one open entry per prospect. A second
        // "add to pipeline" on a card already on the board is a user mistake,
        // not a state to silently duplicate.
        return errorResponse("conflict", "This prospect is already on the pipeline", 409, requestId);
      }
      return errorResponse("internal_error", "Service unavailable", 503, requestId);
    }

    await emitStageChange(eventsRepo, repo, {
      orgId,
      actor,
      requestId,
      now,
      prospectId: asUuid(prospectId!),
      prospectName: prospect.value.prospect.name,
      entryId: created.value.id,
      fromStage: null,
      toStage: stage.key,
    });

    return successResponse({ entry: toPublicEntry(created.value, stage.key) }, requestId, 201);
  } catch {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  } finally {
    if (executor) await executor.dispose();
  }
}

function resolveOwner(raw: string | null | undefined, fields: Record<string, string[]>): Uuid | null {
  if (raw === undefined || raw === null) return null;
  const match = raw.match(/^[a-z]+_([0-9a-f]{32})$/i);
  if (!match) {
    fields.ownerUserId = ["Must be a public user id or null"];
    return null;
  }
  const hex = match[1]!.toLowerCase();
  return asUuid(`${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`);
}

// ── PATCH /pipeline/entries/:id ────────────────────────────

export async function handleUpdateEntry(
  request: Request,
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: Uuid,
  entryId: Uuid,
  deps?: PipelineDeps,
): Promise<Response> {
  const missing = requireBindings(env, requestId);
  if (missing) return missing;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return validationError(requestId, { body: ["Invalid JSON"] });
  }
  if (!body || typeof body !== "object") {
    return validationError(requestId, { body: ["Request body must be an object"] });
  }

  const req = body as UpdatePipelineEntryRequest;
  const fields: Record<string, string[]> = {};
  if (req.stageKey !== undefined && !isStageKey(req.stageKey)) fields.stageKey = ["Invalid stage key"];
  if (
    req.valueCents !== undefined &&
    req.valueCents !== null &&
    (!Number.isInteger(req.valueCents) || req.valueCents < 0 || req.valueCents > VALUE_CENTS_MAX)
  ) {
    fields.valueCents = ["Must be a non-negative integer or null"];
  }
  const ownerProvided = req.ownerUserId !== undefined;
  const ownerUserId = ownerProvided ? resolveOwner(req.ownerUserId, fields) : null;
  if (Object.keys(fields).length > 0) return validationError(requestId, fields);

  const authz = await authorizeRequest(env, requestId, actor, orgId, "organization.pipeline.write");
  if (!authz.ok) return authz.response;

  const now = deps?.now ?? new Date();
  const executor = deps?.repo && deps?.eventsRepo ? null : createSqlExecutor(env.PLATFORM_DB!);
  try {
    const repo = deps?.repo ?? createProspectingRepository(executor!);
    const eventsRepo = deps?.eventsRepo ?? createEventsRepository(executor!);

    const existing = await repo.getPipelineEntry(orgId, entryId);
    if (!existing.ok) {
      if (existing.error.kind === "not_found") return errorResponse("not_found", "Not found", 404, requestId);
      return errorResponse("internal_error", "Service unavailable", 503, requestId);
    }

    const stagesResult = await ensureStages(repo, orgId);
    if (!stagesResult.ok) return errorResponse("internal_error", "Service unavailable", 503, requestId);

    const fromStage = stagesResult.stages.find((s) => s.id === existing.value.stageId);
    const update: UpdatePipelineEntryInput = { updatedAt: now };
    let toStage = fromStage;

    if (req.stageKey !== undefined) {
      const stage = stageByKey(stagesResult.stages, req.stageKey);
      if (!stage) return validationError(requestId, { stageKey: ["No such stage in this pipeline"] });
      if (stage.id !== existing.value.stageId) {
        update.stageId = asUuid(stage.id);
        // The clock resets on every move — that is what makes "stuck in this
        // stage" a query rather than an impression.
        update.enteredStageAt = now;
        // A terminal stage closes the entry, which frees the prospect to be
        // re-entered later without violating the one-open-entry constraint.
        update.closedAt = stage.outcome === "open" ? null : now;
      }
      toStage = stage;
    }

    if (ownerProvided) update.ownerUserId = ownerUserId;
    if (req.valueCents !== undefined) update.valueCents = req.valueCents ?? null;

    const updated = await repo.updatePipelineEntry(orgId, entryId, update);
    if (!updated.ok) {
      if (updated.error.kind === "not_found") return errorResponse("not_found", "Not found", 404, requestId);
      if (updated.error.kind === "conflict") {
        return errorResponse("conflict", "This prospect already has an open pipeline entry", 409, requestId);
      }
      return errorResponse("internal_error", "Service unavailable", 503, requestId);
    }

    const prospect = await repo.getProspect(orgId, asUuid(updated.value.prospectId));
    const prospectName = prospect.ok ? prospect.value.prospect.name : "prospect";

    if (update.stageId !== undefined) {
      await emitStageChange(eventsRepo, repo, {
        orgId,
        actor,
        requestId,
        now,
        prospectId: asUuid(updated.value.prospectId),
        prospectName,
        entryId: updated.value.id,
        fromStage: fromStage?.key ?? null,
        toStage: toStage!.key,
      });
    }

    if (ownerProvided && existing.value.ownerUserId !== updated.value.ownerUserId) {
      await repo.insertActivity({
        id: crypto.randomUUID(),
        orgId,
        prospectId: asUuid(updated.value.prospectId),
        kind: "owner_change",
        actorUserId: actor.subjectUuid,
        body: null,
        metadata: {
          from: existing.value.ownerUserId,
          to: updated.value.ownerUserId,
          entryId: pipelineEntryPublicId(updated.value.id),
        },
        createdAt: now,
      });
    }

    return successResponse({ entry: toPublicEntry(updated.value, toStage!.key) }, requestId);
  } catch {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  } finally {
    if (executor) await executor.dispose();
  }
}

interface StageChangeInput {
  orgId: Uuid;
  actor: ActorContext;
  requestId: string;
  now: Date;
  prospectId: Uuid;
  prospectName: string;
  entryId: string;
  fromStage: string | null;
  toStage: string;
}

/** One place so the event and the timeline entry can never disagree. */
async function emitStageChange(
  eventsRepo: EventsRepository,
  repo: ProspectingRepository,
  input: StageChangeInput,
): Promise<void> {
  await emitProspectingEvent(eventsRepo, {
    type: "prospecting.pipeline.stage_changed",
    orgId: input.orgId,
    actor: input.actor,
    subjectKind: "prospect",
    subjectId: input.prospectId,
    subjectName: input.prospectName,
    requestId: input.requestId,
    occurredAt: input.now,
    payload: {
      prospectId: prospectPublicId(input.prospectId),
      orgId: orgPublicId(input.orgId),
      entryId: pipelineEntryPublicId(input.entryId),
      fromStage: input.fromStage,
      toStage: input.toStage,
    },
    description:
      input.fromStage === null
        ? `Added "${input.prospectName}" to the pipeline at ${input.toStage}`
        : `Moved "${input.prospectName}" from ${input.fromStage} to ${input.toStage}`,
  });

  await repo.insertActivity({
    id: crypto.randomUUID(),
    orgId: input.orgId,
    prospectId: input.prospectId,
    kind: "stage_change",
    actorUserId: input.actor.subjectUuid,
    body: null,
    metadata: {
      from: input.fromStage,
      to: input.toStage,
      entryId: pipelineEntryPublicId(input.entryId),
    },
    createdAt: input.now,
  });
}
