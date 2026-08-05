import type { Env } from "./env.js";
import { handleHealth } from "./handlers/health.js";
import { handleRecordUsage } from "./handlers/record-usage.js";
import { handleIngestBatch } from "./handlers/ingest-batch.js";
import { handleGetUsageSummary } from "./handlers/get-usage-summary.js";
import { handleCheckQuota } from "./handlers/check-quota.js";
import { handleListQuotaViolations } from "./handlers/list-quota-violations.js";
import { handleInternalRecordUsage } from "./handlers/internal-record-usage.js";
import { errorResponse, notFound, methodNotAllowed } from "./http.js";
import { generateRequestId, parseOrgPublicId } from "./ids.js";

const REQUEST_ID_RE = /^[\w-]{1,128}$/;

/**
 * Service-binding provenance for the private usage-recording seam. Not an
 * authentication credential: only Workers explicitly bound to metering-worker
 * over a Cloudflare service binding can present this header, so it cannot be
 * forged from outside the trust boundary. api-edge never routes
 * `/v1/internal/*`, so the seam has no public path.
 *
 * Add a caller here when a new bounded context gains a service binding to
 * metering-worker. Avoid wildcards.
 */
const INTERNAL_CALLER_HEADER = "x-internal-caller";
const INTERNAL_CALLER_RE = /^[a-z][a-z0-9-]{0,63}$/;
const ALLOWED_INTERNAL_CALLERS: ReadonlySet<string> = new Set(["prospecting-worker"]);

function isAllowedInternalCaller(value: string | null): value is string {
  if (!value) return false;
  if (!INTERNAL_CALLER_RE.test(value)) return false;
  return ALLOWED_INTERNAL_CALLERS.has(value);
}

export interface ActorContext {
  subjectId: string;
  subjectType: string;
}

function resolveRequestId(request: Request): string {
  const header = request.headers.get("x-request-id");
  if (header && REQUEST_ID_RE.test(header)) return header;
  return generateRequestId();
}

function resolveActor(request: Request): ActorContext | null {
  const subjectId = request.headers.get("x-actor-subject-id");
  const subjectType = request.headers.get("x-actor-subject-type");
  if (!subjectId || !subjectType) return null;
  return { subjectId, subjectType };
}

// ── Route patterns ──────────────────────────────────────────
const USAGE_RE = /^\/v1\/organizations\/([^/]+)\/usage$/;
const USAGE_BATCH_RE = /^\/v1\/organizations\/([^/]+)\/usage\/batch$/;
const USAGE_SUMMARY_RE = /^\/v1\/organizations\/([^/]+)\/usage\/summary$/;
const QUOTA_CHECK_RE = /^\/v1\/organizations\/([^/]+)\/quotas\/check$/;
const QUOTA_VIOLATIONS_RE = /^\/v1\/organizations\/([^/]+)\/quotas\/violations$/;

type RouteKind = "usage" | "usage_batch" | "usage_summary" | "quota_check" | "quota_violations";

interface MatchedRoute {
  kind: RouteKind;
  orgId: string;
}

function matchRoute(pathname: string): MatchedRoute | null {
  let m = pathname.match(USAGE_BATCH_RE);
  if (m) {
    const orgId = parseOrgPublicId(m[1]!);
    if (!orgId) return null;
    return { kind: "usage_batch", orgId };
  }

  m = pathname.match(USAGE_SUMMARY_RE);
  if (m) {
    const orgId = parseOrgPublicId(m[1]!);
    if (!orgId) return null;
    return { kind: "usage_summary", orgId };
  }

  m = pathname.match(USAGE_RE);
  if (m) {
    const orgId = parseOrgPublicId(m[1]!);
    if (!orgId) return null;
    return { kind: "usage", orgId };
  }

  m = pathname.match(QUOTA_CHECK_RE);
  if (m) {
    const orgId = parseOrgPublicId(m[1]!);
    if (!orgId) return null;
    return { kind: "quota_check", orgId };
  }

  m = pathname.match(QUOTA_VIOLATIONS_RE);
  if (m) {
    const orgId = parseOrgPublicId(m[1]!);
    if (!orgId) return null;
    return { kind: "quota_violations", orgId };
  }

  return null;
}

export async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const requestId = resolveRequestId(request);

  try {
    if (url.pathname === "/health" && request.method === "GET") {
      return handleHealth(env, requestId);
    }

    // Private internal route (service-binding only — never edge-routed).
    // Lets a sibling bounded context record its own product meter without an
    // end-user actor. Gated on the caller allow-list and a metric allow-list.
    if (url.pathname === "/v1/internal/metering/usage") {
      if (request.method !== "POST") return methodNotAllowed(requestId);
      if (!isAllowedInternalCaller(request.headers.get(INTERNAL_CALLER_HEADER))) {
        return errorResponse("unauthorized", "Unauthorized", 403, requestId);
      }
      return handleInternalRecordUsage(request, env, requestId);
    }

    const matched = matchRoute(url.pathname);
    if (!matched) {
      return notFound(requestId, url.pathname);
    }

    const actor = resolveActor(request);
    if (!actor) {
      return errorResponse("unauthenticated", "Authentication required", 401, requestId);
    }

    switch (matched.kind) {
      case "usage":
        if (request.method !== "POST") return methodNotAllowed(requestId);
        return handleRecordUsage(request, env, requestId, actor, matched.orgId);

      case "usage_batch":
        if (request.method !== "POST") return methodNotAllowed(requestId);
        return handleIngestBatch(request, env, requestId, actor, matched.orgId);

      case "usage_summary":
        if (request.method !== "GET") return methodNotAllowed(requestId);
        return handleGetUsageSummary(request, env, requestId, actor, matched.orgId);

      case "quota_check":
        if (request.method !== "POST") return methodNotAllowed(requestId);
        return handleCheckQuota(request, env, requestId, actor, matched.orgId);

      case "quota_violations":
        if (request.method !== "GET") return methodNotAllowed(requestId);
        return handleListQuotaViolations(request, env, requestId, actor, matched.orgId);
    }
  } catch {
    return errorResponse("internal_error", "Internal error", 500, requestId);
  }
}
