import type { Env } from "../env.js";
import type { RecordUsageRequest, RecordUsageResponse } from "@saas/contracts/metering";
import { createSqlExecutor } from "@saas/db/hyperdrive";
import { createMeteringRepository } from "@saas/db/metering";
import { successResponse, errorResponse, validationError } from "../http.js";
import { generateUsageRecordId, parseOrgPublicId } from "../ids.js";
import { validateMetadata } from "../metadata.js";
import { mapToPublic } from "./record-usage.js";

/**
 * Service-binding-only usage recording for sibling bounded contexts.
 *
 * The public `POST /v1/organizations/:orgId/usage` route authorizes an *end
 * user* against `organization.metering.write`. A bounded-context Worker
 * recording its own product meter has no end user to authorize — the write is
 * a consequence of work that was already authorized in that context, on a
 * request path where a second membership round trip buys nothing.
 *
 * So this route trades the actor check for two narrower guarantees:
 *
 *  - the caller is on the service-binding allow-list (enforced in the router,
 *    before this handler runs), and
 *  - the metric is on the internal allow-list below, so a compromised or
 *    misconfigured caller cannot write arbitrary meters.
 *
 * Idempotency is the caller's: `idempotencyKey` is required, and a duplicate
 * is a 409, never a double-count.
 */
const INTERNAL_METRICS: ReadonlySet<string> = new Set([
  "prospecting.prospects.discovered",
  "prospecting.insights.generated",
]);

interface InternalRecordUsageBody extends RecordUsageRequest {
  orgId: string;
}

export async function handleInternalRecordUsage(
  request: Request,
  env: Env,
  requestId: string,
): Promise<Response> {
  if (!env.PLATFORM_DB) {
    return errorResponse("internal_error", "Service misconfigured", 503, requestId);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return validationError(requestId, "Invalid JSON body");
  }
  if (!body || typeof body !== "object") {
    return validationError(requestId, "Request body must be an object");
  }

  const input = body as InternalRecordUsageBody;

  const orgId = typeof input.orgId === "string" ? parseOrgPublicId(input.orgId) : null;
  if (!orgId) {
    return validationError(requestId, "orgId is required and must be a public organization id");
  }
  if (typeof input.metric !== "string" || !INTERNAL_METRICS.has(input.metric)) {
    return validationError(requestId, "metric is not recordable over the internal seam");
  }
  if (typeof input.idempotencyKey !== "string" || input.idempotencyKey.length === 0) {
    return validationError(requestId, "idempotencyKey is required and must be a string");
  }
  if (input.quantity !== undefined && (typeof input.quantity !== "number" || input.quantity < 0)) {
    return validationError(requestId, "quantity must be a non-negative number");
  }

  const metaResult = validateMetadata(input.metadata);
  if (!metaResult.ok) {
    return validationError(requestId, metaResult.message);
  }

  const executor = createSqlExecutor(env.PLATFORM_DB);
  try {
    const repo = createMeteringRepository(executor);
    const result = await repo.recordUsage({
      id: input.id || generateUsageRecordId(),
      orgId,
      projectId: null,
      environmentId: null,
      resourceId: input.resourceId ?? null,
      metric: input.metric,
      quantity: input.quantity ?? 1,
      idempotencyKey: input.idempotencyKey,
      ...(input.recordedAt ? { recordedAt: new Date(input.recordedAt) } : {}),
      metadata: metaResult.value,
    });

    if (!result.ok) {
      if (result.error.kind === "conflict") {
        return errorResponse("conflict", "Duplicate idempotency key", 409, requestId);
      }
      return errorResponse("internal_error", "Failed to record usage", 500, requestId);
    }

    const response: RecordUsageResponse = { usageRecord: mapToPublic(result.value) };
    return successResponse(response, requestId, 201);
  } finally {
    await executor.dispose();
  }
}
