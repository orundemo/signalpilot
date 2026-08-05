import type { Env } from "../env.js";
import type { ActorContext } from "../router.js";
import type { Uuid } from "@saas/db/ids";
import type { ProspectingRepository } from "@saas/db/prospecting";
import { createProspectingRepository } from "@saas/db/prospecting";
import { createSqlExecutor } from "@saas/db/hyperdrive";
import { authorizeRequest, requireBindings } from "../authorize.js";
import { errorResponse, successResponse } from "../http.js";
import { toPublicSignal } from "../mappers.js";

const SIGNAL_PAGE_MAX = 200;

export interface HandleListSignalsDeps {
  repo?: ProspectingRepository;
}

export async function handleListSignals(
  request: Request,
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: Uuid,
  prospectId: Uuid,
  deps?: HandleListSignalsDeps,
): Promise<Response> {
  const missing = requireBindings(env, requestId);
  if (missing) return missing;

  const authz = await authorizeRequest(env, requestId, actor, orgId, "organization.prospect.read");
  if (!authz.ok) return authz.response;

  const limitParam = new URL(request.url).searchParams.get("limit");
  const limit = Math.min(SIGNAL_PAGE_MAX, Math.max(1, Number(limitParam ?? 100) || 100));

  const executor = deps?.repo ? null : createSqlExecutor(env.PLATFORM_DB!);
  try {
    const repo = deps?.repo ?? createProspectingRepository(executor!);

    // Read the prospect first so an unknown or other-tenant id is a 404 rather
    // than an empty signal list, which would leak "this id exists, it just has
    // no signals".
    const prospect = await repo.getProspect(orgId, prospectId);
    if (!prospect.ok) {
      if (prospect.error.kind === "not_found") return errorResponse("not_found", "Not found", 404, requestId);
      return errorResponse("internal_error", "Service unavailable", 503, requestId);
    }

    const result = await repo.listSignals(orgId, prospectId, limit);
    if (!result.ok) return errorResponse("internal_error", "Service unavailable", 503, requestId);

    return successResponse({ signals: result.value.map(toPublicSignal) }, requestId);
  } catch {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  } finally {
    if (executor) await executor.dispose();
  }
}
