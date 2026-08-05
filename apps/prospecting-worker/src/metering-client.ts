import { INTERNAL_CALLER } from "./billing-client.js";

const INTERNAL_CALLER_HEADER = "x-internal-caller";

export type MeteringResult = { ok: true } | { ok: false; reason: "duplicate" | "service_error" };

/**
 * Records a product meter through metering-worker's service-binding-only seam.
 *
 * `idempotencyKey` is required and must be derived from the work being
 * metered, not from the clock: a retried discovery run must not double-count.
 *
 * Metering is deliberately best-effort *for the caller*: this returns a result
 * rather than throwing, because a meter write failing must not roll back
 * prospects the user can already see. The caller records the failure on the
 * run instead.
 */
export async function recordUsage(
  meteringWorker: Fetcher,
  input: {
    orgPublicId: string;
    metric: string;
    quantity: number;
    idempotencyKey: string;
    metadata?: Record<string, unknown> | null;
  },
  requestId: string,
): Promise<MeteringResult> {
  let response: Response;
  try {
    response = await meteringWorker.fetch("http://metering-worker/v1/internal/metering/usage", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-request-id": requestId,
        [INTERNAL_CALLER_HEADER]: INTERNAL_CALLER,
      },
      body: JSON.stringify({
        orgId: input.orgPublicId,
        metric: input.metric,
        quantity: input.quantity,
        idempotencyKey: input.idempotencyKey,
        metadata: input.metadata ?? null,
      }),
    });
  } catch {
    return { ok: false, reason: "service_error" };
  }

  if (response.status === 201) return { ok: true };
  // A duplicate key means this work was already metered — the desired state.
  if (response.status === 409) return { ok: false, reason: "duplicate" };
  return { ok: false, reason: "service_error" };
}
