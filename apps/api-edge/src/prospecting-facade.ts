import type { Env } from "./env.js";
import { errorResponse, withEdgeTimings } from "./http.js";
import { replayOrExecute } from "./idempotency.js";
import { resolveActor } from "./resolve-actor.js";
import { createTimings } from "@saas/contracts/timing";
import type { RouteFamily } from "./rate-limit.js";

const ORG = "\\/v1\\/organizations\\/[^/]+";

// One regex per resource shape, in the order the worker's own router matches.
const ROUTES: ReadonlyArray<{ re: RegExp; methods: ReadonlySet<string> }> = [
  { re: new RegExp(`^${ORG}\\/discoveries$`), methods: new Set(["POST", "GET"]) },
  { re: new RegExp(`^${ORG}\\/discoveries\\/[^/]+$`), methods: new Set(["GET"]) },
  { re: new RegExp(`^${ORG}\\/prospects$`), methods: new Set(["GET", "POST"]) },
  // `POST /prospects/rescore` is the bulk action, not a prospect id — matched
  // before the id shape here for the same reason the worker's router does.
  { re: new RegExp(`^${ORG}\\/prospects\\/rescore$`), methods: new Set(["POST"]) },
  { re: new RegExp(`^${ORG}\\/prospects\\/[^/]+$`), methods: new Set(["GET", "PATCH"]) },
  { re: new RegExp(`^${ORG}\\/prospects\\/[^/]+\\/archive$`), methods: new Set(["POST"]) },
  { re: new RegExp(`^${ORG}\\/prospects\\/[^/]+\\/signals$`), methods: new Set(["GET"]) },
  { re: new RegExp(`^${ORG}\\/prospects\\/[^/]+\\/rescore$`), methods: new Set(["POST"]) },
  { re: new RegExp(`^${ORG}\\/prospects\\/[^/]+\\/scores$`), methods: new Set(["GET"]) },
  { re: new RegExp(`^${ORG}\\/prospects\\/[^/]+\\/insights$`), methods: new Set(["POST", "GET"]) },
  { re: new RegExp(`^${ORG}\\/scoring-profile$`), methods: new Set(["GET", "PUT"]) },
];

/**
 * The two endpoints with real downstream cost — a batch of fetches and a model
 * call — get the stricter limit class. Everything else in the family shares the
 * standard read/write budget.
 */
const EXPENSIVE_RE = new RegExp(`^${ORG}\\/(discoveries$|prospects\\/[^/]+\\/insights$)`);

const FORWARDED_HEADERS = ["content-type", "x-request-id", "traceparent", "idempotency-key"];

export function isProspectingRoute(pathname: string): boolean {
  return ROUTES.some((route) => route.re.test(pathname));
}

export function prospectingRouteFamily(pathname: string, method: string): RouteFamily {
  return method !== "GET" && EXPENSIVE_RE.test(pathname) ? "prospecting_expensive" : "prospecting";
}

export async function handleProspectingRoute(
  request: Request,
  env: Env,
  requestId: string,
  pathname: string,
): Promise<Response> {
  const matched = ROUTES.find((route) => route.re.test(pathname));
  if (matched && !matched.methods.has(request.method)) {
    return errorResponse("unsupported", "Method not allowed", 405, requestId);
  }

  return replayOrExecute(request, requestId, env, prospectingRouteFamily(pathname, request.method), async () => {
    if (!env.IDENTITY_WORKER) {
      return errorResponse("internal_error", "Authentication service unavailable", 503, requestId);
    }
    if (!env.PROSPECTING_WORKER) {
      return errorResponse("internal_error", "Prospecting service unavailable", 503, requestId);
    }

    const timings = createTimings();
    const endTotal = timings.start("edge_total");
    const sessionResult = await timings.measure("edge_auth", () => resolveActor(request, env, requestId));
    if ("error" in sessionResult) {
      return sessionResult.error;
    }

    const headers = new Headers();
    headers.set("x-request-id", requestId);
    headers.set("x-actor-subject-id", sessionResult.subjectId);
    headers.set("x-actor-subject-type", sessionResult.subjectType);
    headers.set("x-actor-email", sessionResult.email);
    for (const name of FORWARDED_HEADERS) {
      if (name === "x-request-id") continue;
      const value = request.headers.get(name);
      if (value) headers.set(name, value);
    }

    const url = new URL(request.url);
    const target = new URL(pathname + url.search, "https://prospecting.internal");

    const init: RequestInit = { method: request.method, headers };
    if (request.method === "POST" || request.method === "PATCH" || request.method === "PUT") {
      init.body = request.body;
    }

    try {
      const downstream = await timings.measure("edge_downstream", () =>
        env.PROSPECTING_WORKER!.fetch(target.toString(), init),
      );
      const res = new Response(downstream.body, { status: downstream.status, headers: downstream.headers });
      endTotal();
      return withEdgeTimings(res, requestId, "edge.prospecting", timings);
    } catch {
      return errorResponse("internal_error", "Prospecting service unavailable", 503, requestId);
    }
  });
}
