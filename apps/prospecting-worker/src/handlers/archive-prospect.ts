import type { Env } from "../env.js";
import type { ActorContext } from "../router.js";
import type { Uuid } from "@saas/db/ids";
import type { ProspectingRepository } from "@saas/db/prospecting";
import type { EventsRepository } from "@saas/db/events";
import { createProspectingRepository } from "@saas/db/prospecting";
import { createEventsRepository } from "@saas/db/events";
import { createSqlExecutor } from "@saas/db/hyperdrive";
import { authorizeRequest, requireBindings } from "../authorize.js";
import { errorResponse, successResponse } from "../http.js";
import { orgPublicId, prospectPublicId } from "../ids.js";
import { toPublicProspect } from "../mappers.js";
import { emitProspectingEvent } from "../events.js";

export interface HandleArchiveProspectDeps {
  repo?: ProspectingRepository;
  eventsRepo?: EventsRepository;
  now?: Date;
}

/**
 * Soft delete. The row, its signals, its scores, and its timeline stay —
 * archiving is how a user says "not this one", and a hard delete would destroy
 * the evidence that the score was ever computed.
 */
export async function handleArchiveProspect(
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: Uuid,
  prospectId: Uuid,
  deps?: HandleArchiveProspectDeps,
): Promise<Response> {
  const missing = requireBindings(env, requestId);
  if (missing) return missing;

  const authz = await authorizeRequest(env, requestId, actor, orgId, "organization.prospect.archive");
  if (!authz.ok) return authz.response;

  const now = deps?.now ?? new Date();
  const executor = deps?.repo && deps?.eventsRepo ? null : createSqlExecutor(env.PLATFORM_DB!);
  try {
    const repo = deps?.repo ?? createProspectingRepository(executor!);
    const eventsRepo = deps?.eventsRepo ?? createEventsRepository(executor!);

    const result = await repo.archiveProspect(orgId, prospectId, now);
    if (!result.ok) {
      if (result.error.kind === "not_found") return errorResponse("not_found", "Not found", 404, requestId);
      return errorResponse("internal_error", "Service unavailable", 503, requestId);
    }

    await emitProspectingEvent(eventsRepo, {
      type: "prospecting.prospect.archived",
      orgId,
      actor,
      subjectKind: "prospect",
      subjectId: result.value.id,
      subjectName: result.value.name,
      requestId,
      occurredAt: now,
      payload: {
        prospectId: prospectPublicId(result.value.id),
        orgId: orgPublicId(orgId),
        name: result.value.name,
      },
      description: `Archived prospect "${result.value.name}"`,
    });

    return successResponse({ prospect: toPublicProspect(result.value, null) }, requestId);
  } catch {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  } finally {
    if (executor) await executor.dispose();
  }
}
