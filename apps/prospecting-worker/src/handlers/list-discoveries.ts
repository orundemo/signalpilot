import type { Env } from "../env.js";
import type { ActorContext } from "../router.js";
import type { Uuid } from "@saas/db/ids";
import type { ProspectingRepository } from "@saas/db/prospecting";
import { createProspectingRepository } from "@saas/db/prospecting";
import { createSqlExecutor } from "@saas/db/hyperdrive";
import { authorizeRequest, requireBindings } from "../authorize.js";
import { errorResponse, validationError } from "../http.js";
import { encodeCursor, parsePageParams } from "../pagination.js";
import { toPublicDiscoveryRun } from "../mappers.js";

export interface HandleListDiscoveriesDeps {
  repo?: ProspectingRepository;
}

export async function handleListDiscoveries(
  request: Request,
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: Uuid,
  deps?: HandleListDiscoveriesDeps,
): Promise<Response> {
  const missing = requireBindings(env, requestId);
  if (missing) return missing;

  const page = parsePageParams(new URL(request.url));
  if (!page.ok) return validationError(requestId, { [page.field]: [page.reason] });

  const authz = await authorizeRequest(env, requestId, actor, orgId, "organization.discovery.read");
  if (!authz.ok) return authz.response;

  const executor = deps?.repo ? null : createSqlExecutor(env.PLATFORM_DB!);
  try {
    const repo = deps?.repo ?? createProspectingRepository(executor!);
    const result = await repo.listDiscoveryRunsPaged(orgId, {
      limit: page.value.limit,
      cursor: page.value.cursor,
    });
    if (!result.ok) return errorResponse("internal_error", "Service unavailable", 503, requestId);

    const nextCursor = result.value.nextCursor
      ? encodeCursor(result.value.nextCursor.createdAt, result.value.nextCursor.id)
      : null;

    return Response.json(
      {
        data: { discoveries: result.value.items.map(toPublicDiscoveryRun) },
        meta: { requestId, cursor: nextCursor },
      },
      { status: 200, headers: { "content-type": "application/json" } },
    );
  } catch {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  } finally {
    if (executor) await executor.dispose();
  }
}
