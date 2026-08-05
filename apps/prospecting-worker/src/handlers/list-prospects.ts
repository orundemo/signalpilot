import type { Env } from "../env.js";
import type { ActorContext } from "../router.js";
import type { Uuid } from "@saas/db/ids";
import type { ProspectFilters, ProspectingRepository } from "@saas/db/prospecting";
import { isScoreBand, isSignalKind, isStageKey } from "@saas/contracts/prospecting";
import { createProspectingRepository } from "@saas/db/prospecting";
import { createSqlExecutor } from "@saas/db/hyperdrive";
import { authorizeRequest, requireBindings } from "../authorize.js";
import { errorResponse, validationError } from "../http.js";
import { encodeCursor, parsePageParams } from "../pagination.js";
import { toPublicProspectWithScore } from "../mappers.js";

export interface HandleListProspectsDeps {
  repo?: ProspectingRepository;
}

function parseFilters(
  url: URL,
): { valid: true; filters: ProspectFilters } | { valid: false; fields: Record<string, string[]> } {
  const fields: Record<string, string[]> = {};
  const filters: ProspectFilters = {};

  const band = url.searchParams.get("band");
  if (band !== null) {
    if (!isScoreBand(band)) fields.band = ["Must be one of: hot, warm, cold"];
    else filters.band = band;
  }

  const signalKind = url.searchParams.get("signalKind");
  if (signalKind !== null) {
    if (!isSignalKind(signalKind)) fields.signalKind = ["Unknown signal kind"];
    else filters.signalKind = signalKind;
  }

  const stageKey = url.searchParams.get("stageKey");
  if (stageKey !== null) {
    if (!isStageKey(stageKey)) fields.stageKey = ["Invalid stage key"];
    else filters.stageKey = stageKey;
  }

  const owner = url.searchParams.get("ownerUserId");
  if (owner !== null) {
    const match = owner.match(/^[a-z]+_([0-9a-f]{32})$/i);
    if (!match) fields.ownerUserId = ["Must be a public user id"];
    else {
      const hex = match[1]!.toLowerCase();
      filters.ownerUserId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    }
  }

  const status = url.searchParams.get("status");
  if (status !== null) {
    if (status !== "active" && status !== "archived") fields.status = ["Must be active or archived"];
    else filters.status = status;
  }

  if (Object.keys(fields).length > 0) return { valid: false, fields };
  return { valid: true, filters };
}

export async function handleListProspects(
  request: Request,
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: Uuid,
  deps?: HandleListProspectsDeps,
): Promise<Response> {
  const missing = requireBindings(env, requestId);
  if (missing) return missing;

  const url = new URL(request.url);
  const page = parsePageParams(url);
  if (!page.ok) return validationError(requestId, { [page.field]: [page.reason] });

  const filters = parseFilters(url);
  if (!filters.valid) return validationError(requestId, filters.fields);

  const authz = await authorizeRequest(env, requestId, actor, orgId, "organization.prospect.read");
  if (!authz.ok) return authz.response;

  const executor = deps?.repo ? null : createSqlExecutor(env.PLATFORM_DB!);
  try {
    const repo = deps?.repo ?? createProspectingRepository(executor!);
    const result = await repo.listProspectsPaged(
      orgId,
      { limit: page.value.limit, cursor: page.value.cursor },
      filters.filters,
    );
    if (!result.ok) return errorResponse("internal_error", "Service unavailable", 503, requestId);

    const prospects = result.value.items.map(toPublicProspectWithScore);
    const nextCursor = result.value.nextCursor
      ? encodeCursor(result.value.nextCursor.createdAt, result.value.nextCursor.id)
      : null;

    return Response.json(
      { data: { prospects }, meta: { requestId, cursor: nextCursor } },
      { status: 200, headers: { "content-type": "application/json" } },
    );
  } catch {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  } finally {
    if (executor) await executor.dispose();
  }
}
