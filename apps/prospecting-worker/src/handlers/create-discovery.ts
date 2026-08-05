import type { Env } from "../env.js";
import type { ActorContext } from "../router.js";
import type { Uuid } from "@saas/db/ids";
import type { ProspectingRepository } from "@saas/db/prospecting";
import type {
  CreateDiscoveryRequest,
  DiscoveryAdapterId,
  DiscoveryQuery,
  SizeBand,
} from "@saas/contracts/prospecting";
import {
  DISCOVERY_LIMIT_DEFAULT,
  DISCOVERY_LIMIT_MAX,
  DISCOVERY_LIMIT_MIN,
  PROSPECTING_ENTITLEMENTS,
  PROSPECTING_METERS,
  isDiscoveryAdapterId,
  isSizeBand,
} from "@saas/contracts/prospecting";
import { createProspectingRepository } from "@saas/db/prospecting";
import type { EventsRepository } from "@saas/db/events";
import { createEventsRepository } from "@saas/db/events";
import { createSqlExecutor } from "@saas/db/hyperdrive";
import { asUuid } from "@saas/db/ids";
import { authorizeRequest, requireBindings } from "../authorize.js";
import { billingPeriod, checkBillingEntitlement, decideQuota } from "../billing-client.js";
import { errorResponse, quotaExhausted, successResponse, validationError } from "../http.js";
import { orgPublicId } from "../ids.js";
import { toPublicDiscoveryRun } from "../mappers.js";
import { runDiscovery } from "../engine/discovery-run.js";

interface ParsedQuery {
  adapter: DiscoveryAdapterId;
  query: DiscoveryQuery;
}

function parseBody(body: unknown): { valid: true; value: ParsedQuery } | { valid: false; fields: Record<string, string[]> } {
  const fields: Record<string, string[]> = {};
  const req = (body ?? {}) as CreateDiscoveryRequest;

  if (body !== undefined && body !== null && typeof body !== "object") {
    return { valid: false, fields: { body: ["Request body must be an object"] } };
  }

  let adapter: DiscoveryAdapterId = "synthetic";
  if (req.adapter !== undefined) {
    if (!isDiscoveryAdapterId(req.adapter)) {
      fields.adapter = ["Must be one of: synthetic, web-signals"];
    } else {
      adapter = req.adapter;
    }
  }

  let limit = DISCOVERY_LIMIT_DEFAULT;
  if (req.limit !== undefined) {
    if (!Number.isInteger(req.limit) || req.limit < DISCOVERY_LIMIT_MIN || req.limit > DISCOVERY_LIMIT_MAX) {
      fields.limit = [`Must be an integer between ${DISCOVERY_LIMIT_MIN} and ${DISCOVERY_LIMIT_MAX}`];
    } else {
      limit = req.limit;
    }
  }

  let sizeBand: SizeBand | null = null;
  if (req.sizeBand !== undefined && req.sizeBand !== null) {
    if (!isSizeBand(req.sizeBand)) {
      fields.sizeBand = ["Must be one of: micro, small, medium, large, unknown"];
    } else {
      sizeBand = req.sizeBand;
    }
  }

  let domains: string[] = [];
  if (req.domains !== undefined) {
    if (!Array.isArray(req.domains) || req.domains.some((d) => typeof d !== "string")) {
      fields.domains = ["Must be an array of strings"];
    } else if (req.domains.length > DISCOVERY_LIMIT_MAX) {
      fields.domains = [`Must contain at most ${DISCOVERY_LIMIT_MAX} entries`];
    } else {
      domains = req.domains;
    }
  }

  for (const key of ["location", "industry"] as const) {
    const value = req[key];
    if (value !== undefined && value !== null && (typeof value !== "string" || value.length > 200)) {
      fields[key] = ["Must be a string of at most 200 characters"];
    }
  }

  // `web-signals` observes domains you name; it does not find businesses. A
  // run with no domains would silently produce nothing, so say so instead.
  if (adapter === "web-signals" && domains.length === 0 && !fields.domains) {
    fields.domains = ["The web-signals adapter requires at least one domain"];
  }

  if (Object.keys(fields).length > 0) return { valid: false, fields };

  return {
    valid: true,
    value: {
      adapter,
      query: {
        location: typeof req.location === "string" ? req.location : null,
        industry: typeof req.industry === "string" ? req.industry : null,
        sizeBand,
        domains,
        limit,
      },
    },
  };
}

export interface HandleCreateDiscoveryDeps {
  repo?: ProspectingRepository;
  eventsRepo?: EventsRepository;
  checkEntitlement?: typeof checkBillingEntitlement;
  /** Injected in tests so the background pass is observable. */
  waitUntil?: (promise: Promise<unknown>) => void;
  now?: Date;
}

/**
 * `POST /discoveries` — the only expensive endpoint in the product.
 *
 * Returns 202 with the run id and completes in the background. The console
 * polls the run; the counters advance as work lands, so a partial failure is
 * still legible rather than an empty result with an error.
 *
 * Order matters: authorize → entitlement → create run → 202. The entitlement
 * gate is deliberately *before* the run row exists, so a tenant at their limit
 * never accumulates phantom runs.
 */
export async function handleCreateDiscovery(
  request: Request,
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: Uuid,
  ctx: { waitUntil(promise: Promise<unknown>): void } | undefined,
  deps?: HandleCreateDiscoveryDeps,
): Promise<Response> {
  const missing = requireBindings(env, requestId);
  if (missing) return missing;
  if (!env.BILLING_WORKER) {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  }

  let body: unknown;
  try {
    body = request.body ? await request.json() : {};
  } catch {
    return validationError(requestId, { body: ["Invalid JSON"] });
  }

  const parsed = parseBody(body);
  if (!parsed.valid) return validationError(requestId, parsed.fields);

  const authz = await authorizeRequest(env, requestId, actor, orgId, "organization.discovery.run");
  if (!authz.ok) return authz.response;

  const now = deps?.now ?? new Date();
  const { periodStart, resetAt } = billingPeriod(now);

  const executor = deps?.repo ? null : createSqlExecutor(env.PLATFORM_DB!);
  const repo = deps?.repo ?? createProspectingRepository(executor!);

  try {
    // ── Entitlement gate ────────────────────────────────────
    const decision = await (deps?.checkEntitlement ?? checkBillingEntitlement)(
      env.BILLING_WORKER,
      orgPublicId(orgId),
      PROSPECTING_ENTITLEMENTS.discovery,
      requestId,
    );
    if (decision.kind === "service_error") {
      return errorResponse("internal_error", "Service unavailable", 503, requestId);
    }

    const usedResult = await repo.countProspectsSince(orgId, periodStart);
    if (!usedResult.ok) {
      return errorResponse("internal_error", "Service unavailable", 503, requestId);
    }

    const gate = decideQuota(
      decision.decision,
      usedResult.value,
      PROSPECTING_METERS.prospectsDiscovered,
      resetAt,
      {
        unavailable: "Discovery is not available on your current plan",
        exhausted: "Your plan's monthly discovery allowance is spent",
      },
    );
    if (gate.kind === "service_error") {
      return errorResponse("internal_error", "Service unavailable", 503, requestId);
    }
    if (gate.kind === "deny") {
      return quotaExhausted(requestId, gate.message, gate.details);
    }

    // ── Start the run ───────────────────────────────────────
    const runId = crypto.randomUUID();
    const created = await repo.createDiscoveryRun({
      id: runId,
      orgId,
      requestedBy: actor.subjectUuid,
      adapter: parsed.value.adapter,
      query: parsed.value.query as unknown as Record<string, unknown>,
      startedAt: now,
    });
    if (!created.ok) {
      return errorResponse("internal_error", "Service unavailable", 503, requestId);
    }

    // Steps 5–7 of design.md §4.2 run past the 202. The console polls.
    //
    // The background pass opens its OWN executor: the request-scoped one is
    // disposed when this handler returns, and the Workers runtime rejects I/O
    // on a client opened for a different request.
    const background = (async () => {
      const bgExecutor = deps?.repo && deps?.eventsRepo ? null : createSqlExecutor(env.PLATFORM_DB!);
      try {
        await runDiscovery({
          env,
          repo: deps?.repo ?? createProspectingRepository(bgExecutor!),
          eventsRepo: deps?.eventsRepo ?? createEventsRepository(bgExecutor!),
          orgId,
          runId: asUuid(runId),
          adapterId: parsed.value.adapter,
          query: parsed.value.query,
          actor,
          requestId,
          now,
        });
      } finally {
        if (bgExecutor) await bgExecutor.dispose();
      }
    })().catch((err: unknown) => {
      // The 202 is already sent, so there is no response to fail. Log and let
      // the run stay non-terminal rather than crashing the isolate; discovery
      // is idempotent by dedupe key, so a re-run converges.
      console.error(
        JSON.stringify({
          level: "error",
          msg: "discovery_background_failed",
          requestId,
          runId,
          error: err instanceof Error ? err.message : "unknown",
        }),
      );
    });

    const scheduleBackground = deps?.waitUntil ?? ctx?.waitUntil.bind(ctx);
    if (scheduleBackground) {
      scheduleBackground(background);
    } else {
      // No `waitUntil` (local dev / direct invocation): finish inline rather
      // than leaving the run stuck in `running` forever.
      await background;
    }

    return successResponse({ discovery: toPublicDiscoveryRun(created.value) }, requestId, 202);
  } catch {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  } finally {
    if (executor) await executor.dispose();
  }
}
