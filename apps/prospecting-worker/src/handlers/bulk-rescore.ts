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
import { scoreAndStore } from "../scoring.js";

/**
 * How many prospects one bulk rescore touches.
 *
 * Bounded deliberately: this is a foreground request, and an unbounded loop
 * over a large corpus would either time out mid-way (leaving a half-rescored
 * board with no record of where it stopped) or hold a connection long enough
 * to matter. The response reports what it did, so the caller can repeat.
 */
const BULK_RESCORE_MAX = 200;

export interface HandleBulkRescoreDeps {
  repo?: ProspectingRepository;
  eventsRepo?: EventsRepository;
  now?: Date;
}

/**
 * `POST /prospects/rescore` — the explicit action offered after a weight change.
 *
 * Editing weights does **not** rescore automatically (design.md §5.2): a
 * manager must not be able to rewrite every number on the board by accident
 * mid-quarter. This is the deliberate, separately-authorized alternative.
 */
export async function handleBulkRescore(
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: Uuid,
  deps?: HandleBulkRescoreDeps,
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

    const ids = await repo.listActiveProspectIds(orgId, BULK_RESCORE_MAX);
    if (!ids.ok) return errorResponse("internal_error", "Service unavailable", 503, requestId);

    let rescored = 0;
    let failed = 0;
    for (const prospectId of ids.value) {
      const prospect = await repo.getProspect(orgId, asUuid(prospectId));
      if (!prospect.ok) {
        failed += 1;
        continue;
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
      if (result.ok) rescored += 1;
      else failed += 1;
    }

    return successResponse(
      {
        rescored,
        failed,
        // True when the corpus is larger than one pass: the caller repeats.
        truncated: ids.value.length === BULK_RESCORE_MAX,
        limit: BULK_RESCORE_MAX,
      },
      requestId,
    );
  } catch {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  } finally {
    if (executor) await executor.dispose();
  }
}
