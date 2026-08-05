import type { Uuid } from "@saas/db/ids";
import type { MembershipFact } from "@saas/contracts/policy";
import type { Env } from "./env.js";
import type { ActorContext } from "./router.js";
import { fetchAuthorizationContext } from "./membership-client.js";
import { authorizeViaPolicy } from "./policy-client.js";
import { errorResponse } from "./http.js";

export type AuthorizationOutcome =
  | { ok: true; memberships: MembershipFact[] }
  | { ok: false; response: Response };

/**
 * The platform's three-step gate, in one place.
 *
 * Both failure modes return the same 404: **deny-as-404**. A caller who is not
 * a member of the org and a caller who is a member without the action must not
 * be able to tell each other apart, because the difference leaks whether the
 * org exists and who is in it. Nine handlers repeating this by hand is nine
 * chances to return a 403 by accident.
 */
export async function authorizeRequest(
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: Uuid,
  action: string,
): Promise<AuthorizationOutcome> {
  if (!env.MEMBERSHIP_WORKER || !env.POLICY_WORKER) {
    return { ok: false, response: errorResponse("internal_error", "Service unavailable", 503, requestId) };
  }

  const context = await fetchAuthorizationContext(
    env.MEMBERSHIP_WORKER,
    actor.subjectId,
    actor.subjectType,
    orgId,
    requestId,
  );
  if (!context.ok) {
    return { ok: false, response: errorResponse("not_found", "Not found", 404, requestId) };
  }

  const decision = await authorizeViaPolicy(
    env.POLICY_WORKER,
    actor.subjectId,
    actor.subjectType,
    action,
    { kind: "organization", orgId },
    context.memberships,
    requestId,
  );
  if (!decision.allow) {
    return { ok: false, response: errorResponse("not_found", "Not found", 404, requestId) };
  }

  return { ok: true, memberships: context.memberships };
}

/** Guard for the bindings every persistence handler needs. */
export function requireBindings(env: Env, requestId: string): Response | null {
  if (!env.PLATFORM_DB) return errorResponse("internal_error", "Service unavailable", 503, requestId);
  if (!env.MEMBERSHIP_WORKER) return errorResponse("internal_error", "Service unavailable", 503, requestId);
  if (!env.POLICY_WORKER) return errorResponse("internal_error", "Service unavailable", 503, requestId);
  return null;
}
