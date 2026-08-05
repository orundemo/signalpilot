import type { CheckBillingEntitlementResponse } from "@saas/contracts/billing";
import type { QuotaExhaustedDetails } from "@saas/contracts/prospecting";

/**
 * Internal caller identity presented to billing-worker on the
 * service-binding-only entitlement-check route. This is a non-secret
 * provenance contract: only Workers explicitly bound to billing-worker over a
 * Cloudflare service binding can present this header, so it cannot be reached
 * from public traffic.
 *
 * Keep this value stable and in sync with billing-worker's allow-list.
 */
export const INTERNAL_CALLER = "prospecting-worker";

const INTERNAL_CALLER_HEADER = "x-internal-caller";

export type BillingEntitlementResult =
  | { kind: "decision"; decision: CheckBillingEntitlementResponse }
  | { kind: "service_error" };

/**
 * Calls billing-worker's private entitlement-check seam over a service
 * binding. Fails closed: any network exception, non-OK HTTP status, or
 * malformed JSON envelope surfaces as `service_error`.
 *
 * Mirrors `projects-worker/src/billing-client.ts` deliberately — this context
 * does not invent a second entitlement protocol.
 */
export async function checkBillingEntitlement(
  billingWorker: Fetcher,
  orgPublicId: string,
  entitlementKey: string,
  requestId: string,
): Promise<BillingEntitlementResult> {
  let response: Response;
  try {
    response = await billingWorker.fetch("http://billing-worker/v1/internal/billing/entitlements/check", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-request-id": requestId,
        [INTERNAL_CALLER_HEADER]: INTERNAL_CALLER,
      },
      body: JSON.stringify({ orgId: orgPublicId, entitlementKey }),
    });
  } catch {
    return { kind: "service_error" };
  }

  if (!response.ok) return { kind: "service_error" };

  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    return { kind: "service_error" };
  }

  if (!parsed || typeof parsed !== "object" || !("data" in parsed)) return { kind: "service_error" };

  const data = (parsed as { data: unknown }).data;
  if (!data || typeof data !== "object") return { kind: "service_error" };

  const obj = data as Record<string, unknown>;
  if (typeof obj.allowed !== "boolean") return { kind: "service_error" };
  if (typeof obj.orgId !== "string" || typeof obj.entitlementKey !== "string") return { kind: "service_error" };

  return { kind: "decision", decision: data as CheckBillingEntitlementResponse };
}

export type QuotaGate =
  | { kind: "allow"; limit: number | null; used: number }
  | { kind: "deny"; message: string; details: QuotaExhaustedDetails }
  | { kind: "service_error" };

/**
 * The metering period this product bills on: the calendar month, UTC.
 *
 * Chosen for one reason — a user can predict it. A rolling 30-day window makes
 * "when do I get more credits" a support question, and the plan allowances in
 * `design.md` §9 are stated per month. `periodStart` is what the usage count is
 * taken from; `resetAt` is what the console renders in the upgrade prompt.
 */
export function billingPeriod(now: Date): { periodStart: Date; resetAt: Date } {
  const periodStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const resetAt = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return { periodStart, resetAt };
}

/**
 * Pure decision logic for a monthly-allowance gate.
 *
 * Semantics, mirroring `projects-worker`'s quantity gate:
 * - `allowed:false` → deny (the plan does not include this capability)
 * - `allowed:true` + `valueType !== "quantity"` → deny (malformed limit)
 * - `allowed:true` + `limitValue === null` → allow (unlimited)
 * - `allowed:true` + numeric limit → allow while `used < limit`
 *
 * Fails closed on any unexpected shape. The deny carries the meter, the limit,
 * the usage, and the reset date so the console can render an upgrade prompt
 * from the error response alone.
 */
export function decideQuota(
  decision: CheckBillingEntitlementResponse,
  used: number,
  meter: string,
  resetAt: Date,
  messages: { unavailable: string; exhausted: string },
): QuotaGate {
  const details = (limit: number | null): QuotaExhaustedDetails => ({
    meter,
    entitlement: decision.entitlementKey,
    limit,
    used,
    resetAt: resetAt.toISOString(),
  });

  if (!decision.allowed) {
    return { kind: "deny", message: messages.unavailable, details: details(0) };
  }
  if (decision.valueType !== "quantity") {
    return { kind: "deny", message: messages.unavailable, details: details(0) };
  }
  if (decision.limitValue === null) {
    return { kind: "allow", limit: null, used };
  }
  if (typeof decision.limitValue !== "number" || !Number.isFinite(decision.limitValue) || decision.limitValue < 0) {
    return { kind: "deny", message: messages.unavailable, details: details(0) };
  }
  if (!Number.isFinite(used) || used < 0) {
    return { kind: "service_error" };
  }
  if (used < decision.limitValue) {
    return { kind: "allow", limit: decision.limitValue, used };
  }
  return { kind: "deny", message: messages.exhausted, details: details(decision.limitValue) };
}
