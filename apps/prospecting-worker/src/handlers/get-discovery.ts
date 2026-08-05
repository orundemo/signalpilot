import type { Env } from "../env.js";
import type { ActorContext } from "../router.js";
import type { Uuid } from "@saas/db/ids";
import type { ProspectingRepository } from "@saas/db/prospecting";
import { createProspectingRepository } from "@saas/db/prospecting";
import { createSqlExecutor } from "@saas/db/hyperdrive";
import { authorizeRequest, requireBindings } from "../authorize.js";
import { errorResponse, successResponse } from "../http.js";
import { toPublicDiscoveryRun } from "../mappers.js";

export interface HandleGetDiscoveryDeps {
  repo?: ProspectingRepository;
}

/** The poll target for the 202 returned by `POST /discoveries`. */
export async function handleGetDiscovery(
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: Uuid,
  runId: Uuid,
  deps?: HandleGetDiscoveryDeps,
): Promise<Response> {
  const missing = requireBindings(env, requestId);
  if (missing) return missing;

  const authz = await authorizeRequest(env, requestId, actor, orgId, "organization.discovery.read");
  if (!authz.ok) return authz.response;

  const executor = deps?.repo ? null : createSqlExecutor(env.PLATFORM_DB!);
  try {
    const repo = deps?.repo ?? createProspectingRepository(executor!);
    const result = await repo.getDiscoveryRun(orgId, runId);
    if (!result.ok) {
      if (result.error.kind === "not_found") return errorResponse("not_found", "Not found", 404, requestId);
      return errorResponse("internal_error", "Service unavailable", 503, requestId);
    }
    return successResponse({ discovery: toPublicDiscoveryRun(result.value) }, requestId);
  } catch {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  } finally {
    if (executor) await executor.dispose();
  }
}
