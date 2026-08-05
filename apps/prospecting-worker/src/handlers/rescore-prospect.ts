import type { Env } from "../env.js";
import type { ActorContext } from "../router.js";
import type { Uuid } from "@saas/db/ids";
import type { ProspectingRepository } from "@saas/db/prospecting";
import type { EventsRepository } from "@saas/db/events";
import { createProspectingRepository } from "@saas/db/prospecting";
import { createEventsRepository } from "@saas/db/events";
import { createSqlExecutor } from "@saas/db/hyperdrive";
import { asUuid } from "@saas/db/ids";
import { authorizeRequest, requireBindings } from "../authorize.js";
import { errorResponse, successResponse } from "../http.js";
import { toPublicScore } from "../mappers.js";
import { scoreAndStore } from "../scoring.js";

export interface HandleRescoreProspectDeps {
  repo?: ProspectingRepository;
  eventsRepo?: EventsRepository;
  now?: Date;
}

/** `POST /prospects/:id/rescore` — recompute from the current signals. */
export async function handleRescoreProspect(
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: Uuid,
  prospectId: Uuid,
  deps?: HandleRescoreProspectDeps,
): Promise<Response> {
  const missing = requireBindings(env, requestId);
  if (missing) return missing;

  const authz = await authorizeRequest(env, requestId, actor, orgId, "organization.prospect.write");
  if (!authz.ok) return authz.response;

  const now = deps?.now ?? new Date();
  const executor = deps?.repo && deps?.eventsRepo ? null : createSqlExecutor(env.PLATFORM_DB!);
  try {
    const repo = deps?.repo ?? createProspectingRepository(executor!);
    const eventsRepo = deps?.eventsRepo ?? createEventsRepository(executor!);

    const prospect = await repo.getProspect(orgId, prospectId);
    if (!prospect.ok) {
      if (prospect.error.kind === "not_found") return errorResponse("not_found", "Not found", 404, requestId);
      return errorResponse("internal_error", "Service unavailable", 503, requestId);
    }

    const result = await scoreAndStore({
      repo,
      eventsRepo,
      orgId,
      prospectId: asUuid(prospectId),
      prospectName: prospect.value.prospect.name,
      actor,
      requestId,
      now,
      trigger: "rescored",
    });
    if (!result.ok) {
      if (result.reason === "not_found") return errorResponse("not_found", "Not found", 404, requestId);
      return errorResponse("internal_error", "Service unavailable", 503, requestId);
    }

    return successResponse({ score: toPublicScore(result.score) }, requestId, 201);
  } catch {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  } finally {
    if (executor) await executor.dispose();
  }
}
