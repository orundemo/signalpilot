import type { Env } from "../env.js";
import type { ActorContext } from "../router.js";
import type { Uuid } from "@saas/db/ids";
import type { ProspectingRepository, ScoringProfile } from "@saas/db/prospecting";
import type { PublicScoringProfile, SignalKind } from "@saas/contracts/prospecting";
import {
  PROSPECTING_RULESET_VERSION,
  resolveWeights,
  validateWeights,
} from "@saas/contracts/prospecting";
import { createProspectingRepository } from "@saas/db/prospecting";
import { createSqlExecutor } from "@saas/db/hyperdrive";
import { authorizeRequest, requireBindings } from "../authorize.js";
import { errorResponse, successResponse, validationError } from "../http.js";
import { orgPublicId, scoringProfilePublicId, userPublicId } from "../ids.js";

export interface HandleScoringProfileDeps {
  repo?: ProspectingRepository;
  now?: Date;
}

function toPublic(profile: ScoringProfile | null, orgId: Uuid): PublicScoringProfile {
  const weights = (profile?.weights ?? {}) as Partial<Record<SignalKind, number>>;
  if (!profile) {
    // An org that has never tuned weights is on version 0: the code ruleset
    // defaults. Returning a synthetic row rather than 404 means the console
    // renders the same editor either way.
    return {
      id: "",
      orgId: orgPublicId(orgId),
      version: 0,
      rulesetVersion: PROSPECTING_RULESET_VERSION,
      weights: {},
      effectiveWeights: resolveWeights(null),
      isActive: true,
      createdBy: null,
      createdAt: new Date(0).toISOString(),
    };
  }
  return {
    id: scoringProfilePublicId(profile.id),
    orgId: orgPublicId(profile.orgId),
    version: profile.version,
    rulesetVersion: profile.rulesetVersion,
    weights,
    effectiveWeights: resolveWeights(weights),
    isActive: profile.isActive,
    createdBy: profile.createdBy ? userPublicId(profile.createdBy) : null,
    createdAt: profile.createdAt.toISOString(),
  };
}

export async function handleGetScoringProfile(
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: Uuid,
  deps?: HandleScoringProfileDeps,
): Promise<Response> {
  const missing = requireBindings(env, requestId);
  if (missing) return missing;

  const authz = await authorizeRequest(env, requestId, actor, orgId, "organization.scoring_profile.read");
  if (!authz.ok) return authz.response;

  const executor = deps?.repo ? null : createSqlExecutor(env.PLATFORM_DB!);
  try {
    const repo = deps?.repo ?? createProspectingRepository(executor!);
    const result = await repo.getActiveScoringProfile(orgId);
    if (!result.ok) return errorResponse("internal_error", "Service unavailable", 503, requestId);
    return successResponse({ profile: toPublic(result.value, orgId) }, requestId);
  } catch {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  } finally {
    if (executor) await executor.dispose();
  }
}

/**
 * `PUT /scoring-profile` — insert a new weight version.
 *
 * Two things this deliberately does **not** do:
 *
 * - It does not update the existing profile row. Profiles are append-only, so
 *   a score computed last quarter stays explainable against the weights that
 *   produced it.
 * - It does not rescore the corpus. A manager editing weights mid-quarter must
 *   not silently rewrite every number on the board; the bulk rescore is an
 *   explicit, separately-authorized action.
 */
export async function handlePutScoringProfile(
  request: Request,
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: Uuid,
  deps?: HandleScoringProfileDeps,
): Promise<Response> {
  const missing = requireBindings(env, requestId);
  if (missing) return missing;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return validationError(requestId, { body: ["Invalid JSON"] });
  }
  if (!body || typeof body !== "object") {
    return validationError(requestId, { body: ["Request body must be an object"] });
  }

  const validation = validateWeights((body as { weights?: unknown }).weights);
  if (!validation.valid) return validationError(requestId, validation.fields);

  const authz = await authorizeRequest(env, requestId, actor, orgId, "organization.scoring_profile.write");
  if (!authz.ok) return authz.response;

  const executor = deps?.repo ? null : createSqlExecutor(env.PLATFORM_DB!);
  try {
    const repo = deps?.repo ?? createProspectingRepository(executor!);
    const result = await repo.insertScoringProfile({
      id: crypto.randomUUID(),
      orgId,
      rulesetVersion: PROSPECTING_RULESET_VERSION,
      weights: validation.weights as Record<string, number>,
      createdBy: actor.subjectUuid,
      createdAt: deps?.now ?? new Date(),
    });
    if (!result.ok) {
      if (result.error.kind === "conflict") {
        return errorResponse("conflict", "A newer profile version already exists", 409, requestId);
      }
      return errorResponse("internal_error", "Service unavailable", 503, requestId);
    }
    return successResponse({ profile: toPublic(result.value, orgId) }, requestId, 201);
  } catch {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  } finally {
    if (executor) await executor.dispose();
  }
}

export { toPublic as toPublicScoringProfile };
