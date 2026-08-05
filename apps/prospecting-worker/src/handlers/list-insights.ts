import type { Env } from "../env.js";
import type { ActorContext } from "../router.js";
import type { Uuid } from "@saas/db/ids";
import type { ProspectingRepository } from "@saas/db/prospecting";
import { createProspectingRepository } from "@saas/db/prospecting";
import { createSqlExecutor } from "@saas/db/hyperdrive";
import { authorizeRequest, requireBindings } from "../authorize.js";
import { errorResponse, successResponse } from "../http.js";
import { toPublicInsight } from "./generate-insight.js";

const INSIGHTS_PAGE_MAX = 50;

export interface HandleListInsightsDeps {
  repo?: ProspectingRepository;
}

export async function handleListInsights(
  request: Request,
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: Uuid,
  prospectId: Uuid,
  deps?: HandleListInsightsDeps,
): Promise<Response> {
  const missing = requireBindings(env, requestId);
  if (missing) return missing;

  const authz = await authorizeRequest(env, requestId, actor, orgId, "organization.insight.read");
  if (!authz.ok) return authz.response;

  const limitParam = new URL(request.url).searchParams.get("limit");
  const limit = Math.min(INSIGHTS_PAGE_MAX, Math.max(1, Number(limitParam ?? 20) || 20));

  const executor = deps?.repo ? null : createSqlExecutor(env.PLATFORM_DB!);
  try {
    const repo = deps?.repo ?? createProspectingRepository(executor!);

    const prospect = await repo.getProspect(orgId, prospectId);
    if (!prospect.ok) {
      if (prospect.error.kind === "not_found") return errorResponse("not_found", "Not found", 404, requestId);
      return errorResponse("internal_error", "Service unavailable", 503, requestId);
    }

    const result = await repo.listInsights(orgId, prospectId, limit);
    if (!result.ok) return errorResponse("internal_error", "Service unavailable", 503, requestId);

    // `cached: true` on a read: these are stored generations being replayed,
    // and none of them cost a credit to look at.
    return successResponse({ insights: result.value.map((i) => toPublicInsight(i, true)) }, requestId);
  } catch {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  } finally {
    if (executor) await executor.dispose();
  }
}
