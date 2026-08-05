import type { Env } from "../env.js";
import type { ActorContext } from "../router.js";
import type { Uuid } from "@saas/db/ids";
import type { Activity, ProspectingRepository } from "@saas/db/prospecting";
import type { ActivityKind, CreateActivityRequest, PublicActivity } from "@saas/contracts/prospecting";
import { createProspectingRepository } from "@saas/db/prospecting";
import { createSqlExecutor } from "@saas/db/hyperdrive";
import { asUuid } from "@saas/db/ids";
import { authorizeRequest, requireBindings } from "../authorize.js";
import { errorResponse, successResponse, validationError } from "../http.js";
import { activityPublicId, orgPublicId, prospectPublicId, userPublicId } from "../ids.js";

const ACTIVITIES_PAGE_MAX = 200;
const NOTE_MAX = 4000;

export function toPublicActivity(activity: Activity): PublicActivity {
  return {
    id: activityPublicId(activity.id),
    orgId: orgPublicId(activity.orgId),
    prospectId: prospectPublicId(activity.prospectId),
    kind: activity.kind as ActivityKind,
    actorUserId: activity.actorUserId ? userPublicId(activity.actorUserId) : null,
    body: activity.body,
    metadata: activity.metadata,
    createdAt: activity.createdAt.toISOString(),
  };
}

export interface ActivitiesDeps {
  repo?: ProspectingRepository;
  now?: Date;
}

export async function handleListActivities(
  request: Request,
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: Uuid,
  prospectId: Uuid,
  deps?: ActivitiesDeps,
): Promise<Response> {
  const missing = requireBindings(env, requestId);
  if (missing) return missing;

  const authz = await authorizeRequest(env, requestId, actor, orgId, "organization.prospect.read");
  if (!authz.ok) return authz.response;

  const limitParam = new URL(request.url).searchParams.get("limit");
  const limit = Math.min(ACTIVITIES_PAGE_MAX, Math.max(1, Number(limitParam ?? 50) || 50));

  const executor = deps?.repo ? null : createSqlExecutor(env.PLATFORM_DB!);
  try {
    const repo = deps?.repo ?? createProspectingRepository(executor!);

    const prospect = await repo.getProspect(orgId, prospectId);
    if (!prospect.ok) {
      if (prospect.error.kind === "not_found") return errorResponse("not_found", "Not found", 404, requestId);
      return errorResponse("internal_error", "Service unavailable", 503, requestId);
    }

    const result = await repo.listActivities(orgId, prospectId, limit);
    if (!result.ok) return errorResponse("internal_error", "Service unavailable", 503, requestId);

    return successResponse({ activities: result.value.map(toPublicActivity) }, requestId);
  } catch {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  } finally {
    if (executor) await executor.dispose();
  }
}

/**
 * `POST /prospects/:id/activities` — a manual note.
 *
 * Only `note` is writable. The other kinds (`stage_change`, `owner_change`,
 * `rescored`, `insight_generated`, `discovered`) are written by the system as
 * a consequence of the thing happening; letting a client post one would let
 * the timeline claim an event that never occurred.
 */
export async function handleCreateActivity(
  request: Request,
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: Uuid,
  prospectId: Uuid,
  deps?: ActivitiesDeps,
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

  const req = body as CreateActivityRequest;
  const fields: Record<string, string[]> = {};
  if (req.kind !== undefined && req.kind !== "note") {
    fields.kind = ["Only 'note' activities can be created directly"];
  }
  if (typeof req.body !== "string" || req.body.trim().length === 0 || req.body.length > NOTE_MAX) {
    fields.body = [`Must be a non-empty string of at most ${NOTE_MAX} characters`];
  }
  if (Object.keys(fields).length > 0) return validationError(requestId, fields);

  const authz = await authorizeRequest(env, requestId, actor, orgId, "organization.prospect.write");
  if (!authz.ok) return authz.response;

  const executor = deps?.repo ? null : createSqlExecutor(env.PLATFORM_DB!);
  try {
    const repo = deps?.repo ?? createProspectingRepository(executor!);

    const prospect = await repo.getProspect(orgId, prospectId);
    if (!prospect.ok) {
      if (prospect.error.kind === "not_found") return errorResponse("not_found", "Not found", 404, requestId);
      return errorResponse("internal_error", "Service unavailable", 503, requestId);
    }

    const result = await repo.insertActivity({
      id: crypto.randomUUID(),
      orgId,
      prospectId: asUuid(prospectId),
      kind: "note",
      actorUserId: actor.subjectUuid,
      body: req.body.trim(),
      metadata: {},
      createdAt: deps?.now ?? new Date(),
    });
    if (!result.ok) return errorResponse("internal_error", "Service unavailable", 503, requestId);

    return successResponse({ activity: toPublicActivity(result.value) }, requestId, 201);
  } catch {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  } finally {
    if (executor) await executor.dispose();
  }
}
