import type { Env } from "../env.js";
import type { ActorContext } from "../router.js";
import type { Uuid } from "@saas/db/ids";
import type { ProspectingRepository, UpdateProspectInput } from "@saas/db/prospecting";
import type { UpdateProspectRequest } from "@saas/contracts/prospecting";
import { isSizeBand } from "@saas/contracts/prospecting";
import { createProspectingRepository } from "@saas/db/prospecting";
import { createSqlExecutor } from "@saas/db/hyperdrive";
import { authorizeRequest, requireBindings } from "../authorize.js";
import { errorResponse, successResponse, validationError } from "../http.js";
import { toPublicProspect } from "../mappers.js";
import { normaliseDomain } from "../engine/dedupe.js";

const NAME_MAX = 200;
const FIELD_MAX = 120;

function validate(body: unknown): { valid: true; value: UpdateProspectInput } | { valid: false; fields: Record<string, string[]> } {
  if (!body || typeof body !== "object") {
    return { valid: false, fields: { body: ["Request body must be an object"] } };
  }
  const req = body as UpdateProspectRequest;
  const fields: Record<string, string[]> = {};
  const value: UpdateProspectInput = {};

  if (req.name !== undefined) {
    if (typeof req.name !== "string" || req.name.trim().length === 0 || req.name.length > NAME_MAX) {
      fields.name = [`Must be a non-empty string of at most ${NAME_MAX} characters`];
    } else {
      value.name = req.name.trim();
    }
  }

  for (const key of ["industry", "locality", "region", "country"] as const) {
    const raw = req[key];
    if (raw === undefined) continue;
    if (raw === null) {
      value[key] = null;
    } else if (typeof raw !== "string" || raw.length > FIELD_MAX) {
      fields[key] = [`Must be a string of at most ${FIELD_MAX} characters, or null`];
    } else {
      value[key] = raw;
    }
  }

  if (req.domain !== undefined) {
    if (req.domain === null) {
      value.domain = null;
    } else if (typeof req.domain !== "string") {
      fields.domain = ["Must be a string or null"];
    } else {
      const normalised = normaliseDomain(req.domain);
      if (!normalised) fields.domain = ["Must be a resolvable domain or URL"];
      else value.domain = normalised;
    }
  }

  if (req.sizeBand !== undefined) {
    if (!isSizeBand(req.sizeBand)) fields.sizeBand = ["Must be one of: micro, small, medium, large, unknown"];
    else value.sizeBand = req.sizeBand;
  }

  if (Object.keys(fields).length > 0) return { valid: false, fields };
  return { valid: true, value };
}

export interface HandleUpdateProspectDeps {
  repo?: ProspectingRepository;
  now?: Date;
}

/**
 * Edits the business record. Note what it deliberately does **not** touch:
 * `dedupe_key`. Rewriting the identity key on an edit would let a rename
 * silently collide with — or split from — an existing row, which is the false
 * merge `engine/dedupe.ts` exists to prevent.
 */
export async function handleUpdateProspect(
  request: Request,
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: Uuid,
  prospectId: Uuid,
  deps?: HandleUpdateProspectDeps,
): Promise<Response> {
  const missing = requireBindings(env, requestId);
  if (missing) return missing;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return validationError(requestId, { body: ["Invalid JSON"] });
  }

  const validation = validate(body);
  if (!validation.valid) return validationError(requestId, validation.fields);

  const authz = await authorizeRequest(env, requestId, actor, orgId, "organization.prospect.write");
  if (!authz.ok) return authz.response;

  const executor = deps?.repo ? null : createSqlExecutor(env.PLATFORM_DB!);
  try {
    const repo = deps?.repo ?? createProspectingRepository(executor!);
    const result = await repo.updateProspect(orgId, prospectId, validation.value, deps?.now ?? new Date());
    if (!result.ok) {
      if (result.error.kind === "not_found") return errorResponse("not_found", "Not found", 404, requestId);
      if (result.error.kind === "conflict") {
        return errorResponse("conflict", "Another prospect already matches this identity", 409, requestId);
      }
      return errorResponse("internal_error", "Service unavailable", 503, requestId);
    }
    return successResponse({ prospect: toPublicProspect(result.value, null) }, requestId);
  } catch {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  } finally {
    if (executor) await executor.dispose();
  }
}
