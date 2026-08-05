import type { Uuid } from "@saas/db/ids";
import type { Env } from "./env.js";
import { handleHealth } from "./handlers/health.js";
import { handleCreateDiscovery } from "./handlers/create-discovery.js";
import { handleGetDiscovery } from "./handlers/get-discovery.js";
import { handleListDiscoveries } from "./handlers/list-discoveries.js";
import { handleListProspects } from "./handlers/list-prospects.js";
import { handleGetProspect } from "./handlers/get-prospect.js";
import { handleCreateProspect } from "./handlers/create-prospect.js";
import { handleUpdateProspect } from "./handlers/update-prospect.js";
import { handleArchiveProspect } from "./handlers/archive-prospect.js";
import { handleListSignals } from "./handlers/list-signals.js";
import { handleRescoreProspect } from "./handlers/rescore-prospect.js";
import { handleListScores } from "./handlers/list-scores.js";
import { handleBulkRescore } from "./handlers/bulk-rescore.js";
import { handleGetScoringProfile, handlePutScoringProfile } from "./handlers/scoring-profile.js";
import { errorResponse, methodNotAllowed, notFound } from "./http.js";
import { generateRequestId, parseDiscoveryPublicId, parseOrgPublicId, parseProspectPublicId } from "./ids.js";

const REQUEST_ID_RE = /^[\w-]{1,128}$/;

export interface ActorContext {
  subjectId: string;
  subjectType: string;
  /**
   * The actor's id as a UUID. Resolved once, here, because every row this
   * worker writes stores it in a UUID column — decoding per handler is how a
   * `usr_…` string ends up in a UUID column and fails at runtime.
   */
  subjectUuid: Uuid;
}

export function resolveRequestId(request: Request): string {
  const header = request.headers.get("x-request-id");
  if (header && REQUEST_ID_RE.test(header)) return header;
  return generateRequestId();
}

const PUBLIC_ID_RE = /^[a-z]+_([0-9a-f]{32})$/i;

export function resolveActor(request: Request): ActorContext | null {
  const subjectId = request.headers.get("x-actor-subject-id");
  const subjectType = request.headers.get("x-actor-subject-type");
  if (!subjectId || !subjectType) return null;

  const match = subjectId.match(PUBLIC_ID_RE);
  if (!match) return null;
  const hex = match[1]!.toLowerCase();
  const subjectUuid =
    `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}` as Uuid;

  return { subjectId, subjectType, subjectUuid };
}

// ── Route patterns ─────────────────────────────────────────
const ORG = "\\/v1\\/organizations\\/([^/]+)";
const DISCOVERIES_RE = new RegExp(`^${ORG}\\/discoveries$`);
const DISCOVERY_ID_RE = new RegExp(`^${ORG}\\/discoveries\\/([^/]+)$`);
const PROSPECTS_RE = new RegExp(`^${ORG}\\/prospects$`);
const PROSPECT_ID_RE = new RegExp(`^${ORG}\\/prospects\\/([^/]+)$`);
const PROSPECT_ARCHIVE_RE = new RegExp(`^${ORG}\\/prospects\\/([^/]+)\\/archive$`);
const PROSPECT_SIGNALS_RE = new RegExp(`^${ORG}\\/prospects\\/([^/]+)\\/signals$`);
const PROSPECT_RESCORE_RE = new RegExp(`^${ORG}\\/prospects\\/([^/]+)\\/rescore$`);
const PROSPECT_SCORES_RE = new RegExp(`^${ORG}\\/prospects\\/([^/]+)\\/scores$`);
const BULK_RESCORE_RE = new RegExp(`^${ORG}\\/prospects\\/rescore$`);
const SCORING_PROFILE_RE = new RegExp(`^${ORG}\\/scoring-profile$`);

export interface RequestContext {
  waitUntil(promise: Promise<unknown>): void;
}

export async function route(request: Request, env: Env, ctx?: RequestContext): Promise<Response> {
  const url = new URL(request.url);
  const requestId = resolveRequestId(request);

  try {
    if (url.pathname === "/health" && request.method === "GET") {
      return handleHealth(env, requestId);
    }

    const path = url.pathname;

    // Every org-scoped route needs an authenticated actor and a decodable org
    // id. An undecodable org id is a 404, not a 400: it must not confirm that
    // a well-formed id would have existed.
    const orgMatch = path.match(new RegExp(`^${ORG}(\\/|$)`));
    if (!orgMatch) return notFound(requestId, path);

    const orgId = parseOrgPublicId(orgMatch[1]!);
    if (!orgId) return errorResponse("not_found", "Not found", 404, requestId);

    const actor = resolveActor(request);
    if (!actor) return errorResponse("unauthenticated", "Authentication required", 401, requestId);

    if (DISCOVERIES_RE.test(path)) {
      if (request.method === "POST") return handleCreateDiscovery(request, env, requestId, actor, orgId, ctx);
      if (request.method === "GET") return handleListDiscoveries(request, env, requestId, actor, orgId);
      return methodNotAllowed(requestId);
    }

    const discoveryMatch = path.match(DISCOVERY_ID_RE);
    if (discoveryMatch) {
      const runId = parseDiscoveryPublicId(discoveryMatch[2]!);
      if (!runId) return errorResponse("not_found", "Not found", 404, requestId);
      if (request.method !== "GET") return methodNotAllowed(requestId);
      return handleGetDiscovery(env, requestId, actor, orgId, runId);
    }

    if (SCORING_PROFILE_RE.test(path)) {
      if (request.method === "GET") return handleGetScoringProfile(env, requestId, actor, orgId);
      if (request.method === "PUT") return handlePutScoringProfile(request, env, requestId, actor, orgId);
      return methodNotAllowed(requestId);
    }

    // The bulk action must be matched before the `/prospects/:id` shape, or
    // `rescore` reads as a prospect id and answers 405.
    if (BULK_RESCORE_RE.test(path)) {
      if (request.method !== "POST") return methodNotAllowed(requestId);
      return handleBulkRescore(env, requestId, actor, orgId);
    }

    if (PROSPECTS_RE.test(path)) {
      if (request.method === "GET") return handleListProspects(request, env, requestId, actor, orgId);
      if (request.method === "POST") return handleCreateProspect(request, env, requestId, actor, orgId);
      return methodNotAllowed(requestId);
    }

    const archiveMatch = path.match(PROSPECT_ARCHIVE_RE);
    if (archiveMatch) {
      const prospectId = parseProspectPublicId(archiveMatch[2]!);
      if (!prospectId) return errorResponse("not_found", "Not found", 404, requestId);
      if (request.method !== "POST") return methodNotAllowed(requestId);
      return handleArchiveProspect(env, requestId, actor, orgId, prospectId);
    }

    const signalsMatch = path.match(PROSPECT_SIGNALS_RE);
    if (signalsMatch) {
      const prospectId = parseProspectPublicId(signalsMatch[2]!);
      if (!prospectId) return errorResponse("not_found", "Not found", 404, requestId);
      if (request.method !== "GET") return methodNotAllowed(requestId);
      return handleListSignals(request, env, requestId, actor, orgId, prospectId);
    }

    const rescoreMatch = path.match(PROSPECT_RESCORE_RE);
    if (rescoreMatch) {
      const prospectId = parseProspectPublicId(rescoreMatch[2]!);
      if (!prospectId) return errorResponse("not_found", "Not found", 404, requestId);
      if (request.method !== "POST") return methodNotAllowed(requestId);
      return handleRescoreProspect(env, requestId, actor, orgId, prospectId);
    }

    const scoresMatch = path.match(PROSPECT_SCORES_RE);
    if (scoresMatch) {
      const prospectId = parseProspectPublicId(scoresMatch[2]!);
      if (!prospectId) return errorResponse("not_found", "Not found", 404, requestId);
      if (request.method !== "GET") return methodNotAllowed(requestId);
      return handleListScores(request, env, requestId, actor, orgId, prospectId);
    }

    const prospectMatch = path.match(PROSPECT_ID_RE);
    if (prospectMatch) {
      const prospectId = parseProspectPublicId(prospectMatch[2]!);
      if (!prospectId) return errorResponse("not_found", "Not found", 404, requestId);
      if (request.method === "GET") return handleGetProspect(env, requestId, actor, orgId, prospectId);
      if (request.method === "PATCH") return handleUpdateProspect(request, env, requestId, actor, orgId, prospectId);
      return methodNotAllowed(requestId);
    }

    return notFound(requestId, path);
  } catch {
    return errorResponse("internal_error", "An unexpected error occurred", 500, requestId);
  }
}
