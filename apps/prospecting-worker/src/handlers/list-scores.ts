import type { Env } from "../env.js";
import type { ActorContext } from "../router.js";
import type { Uuid } from "@saas/db/ids";
import type { ProspectingRepository } from "@saas/db/prospecting";
import { createProspectingRepository } from "@saas/db/prospecting";
import { createSqlExecutor } from "@saas/db/hyperdrive";
import { authorizeRequest, requireBindings } from "../authorize.js";
import { errorResponse, successResponse } from "../http.js";
import { toPublicScore } from "../mappers.js";

const SCORES_PAGE_MAX = 100;

export interface HandleListScoresDeps {
  repo?: ProspectingRepository;
}

/**
 * `GET /prospects/:id/scores` — the score history, newest first.
 *
 * Scores are append-only, so this is a genuine timeline: "why did this drop
 * from 82 to 61" is answered by diffing two rows' `contributions`.
 */
export async function handleListScores(
  request: Request,
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: Uuid,
  prospectId: Uuid,
  deps?: HandleListScoresDeps,
): Promise<Response> {
  const missing = requireBindings(env, requestId);
  if (missing) return missing;

  const authz = await authorizeRequest(env, requestId, actor, orgId, "organization.prospect.read");
  if (!authz.ok) return authz.response;

  const limitParam = new URL(request.url).searchParams.get("limit");
  const limit = Math.min(SCORES_PAGE_MAX, Math.max(1, Number(limitParam ?? 20) || 20));

  const executor = deps?.repo ? null : createSqlExecutor(env.PLATFORM_DB!);
  try {
    const repo = deps?.repo ?? createProspectingRepository(executor!);

    const prospect = await repo.getProspect(orgId, prospectId);
    if (!prospect.ok) {
      if (prospect.error.kind === "not_found") return errorResponse("not_found", "Not found", 404, requestId);
      return errorResponse("internal_error", "Service unavailable", 503, requestId);
    }

    const result = await repo.listScores(orgId, prospectId, limit);
    if (!result.ok) return errorResponse("internal_error", "Service unavailable", 503, requestId);

    return successResponse({ scores: result.value.map(toPublicScore) }, requestId);
  } catch {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  } finally {
    if (executor) await executor.dispose();
  }
}
