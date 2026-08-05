import type { Env } from "../env.js";
import type { ActorContext } from "../router.js";
import type { Uuid } from "@saas/db/ids";
import type { ProspectingRepository } from "@saas/db/prospecting";
import type { EventsRepository } from "@saas/db/events";
import type { CreateProspectRequest, SizeBand } from "@saas/contracts/prospecting";
import { isSizeBand } from "@saas/contracts/prospecting";
import { createProspectingRepository } from "@saas/db/prospecting";
import { createEventsRepository } from "@saas/db/events";
import { createSqlExecutor } from "@saas/db/hyperdrive";
import { asUuid } from "@saas/db/ids";
import { authorizeRequest, requireBindings } from "../authorize.js";
import { errorResponse, successResponse, validationError } from "../http.js";
import { orgPublicId, prospectPublicId } from "../ids.js";
import { toPublicProspect } from "../mappers.js";
import { dedupeKey, normaliseDomain } from "../engine/dedupe.js";
import { emitProspectingEvent } from "../events.js";

const NAME_MAX = 200;
const FIELD_MAX = 120;

interface ValidBody {
  name: string;
  domain: string | null;
  industry: string | null;
  locality: string | null;
  region: string | null;
  country: string | null;
  sizeBand: SizeBand;
}

function validate(body: unknown): { valid: true; value: ValidBody } | { valid: false; fields: Record<string, string[]> } {
  if (!body || typeof body !== "object") {
    return { valid: false, fields: { body: ["Request body must be an object"] } };
  }
  const req = body as CreateProspectRequest;
  const fields: Record<string, string[]> = {};

  if (typeof req.name !== "string" || req.name.trim().length === 0 || req.name.length > NAME_MAX) {
    fields.name = [`Must be a non-empty string of at most ${NAME_MAX} characters`];
  }

  for (const key of ["industry", "locality", "region", "country"] as const) {
    const value = req[key];
    if (value !== undefined && value !== null && (typeof value !== "string" || value.length > FIELD_MAX)) {
      fields[key] = [`Must be a string of at most ${FIELD_MAX} characters`];
    }
  }

  let domain: string | null = null;
  if (req.domain !== undefined && req.domain !== null) {
    if (typeof req.domain !== "string") {
      fields.domain = ["Must be a string"];
    } else if (req.domain.trim().length > 0) {
      domain = normaliseDomain(req.domain);
      if (!domain) fields.domain = ["Must be a resolvable domain or URL"];
    }
  }

  let sizeBand: SizeBand = "unknown";
  if (req.sizeBand !== undefined) {
    if (!isSizeBand(req.sizeBand)) fields.sizeBand = ["Must be one of: micro, small, medium, large, unknown"];
    else sizeBand = req.sizeBand;
  }

  if (Object.keys(fields).length > 0) return { valid: false, fields };

  const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
  return {
    valid: true,
    value: {
      name: (req.name as string).trim(),
      domain,
      industry: str(req.industry),
      locality: str(req.locality),
      region: str(req.region),
      country: str(req.country),
      sizeBand,
    },
  };
}

export interface HandleCreateProspectDeps {
  repo?: ProspectingRepository;
  eventsRepo?: EventsRepository;
  now?: Date;
}

/**
 * Manual add. Goes through the same dedupe key as discovery, so adding a
 * business you already discovered updates that row rather than creating a
 * second card for the same company.
 */
export async function handleCreateProspect(
  request: Request,
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: Uuid,
  deps?: HandleCreateProspectDeps,
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

  const now = deps?.now ?? new Date();
  const executor = deps?.repo && deps?.eventsRepo ? null : createSqlExecutor(env.PLATFORM_DB!);
  try {
    const repo = deps?.repo ?? createProspectingRepository(executor!);
    const eventsRepo = deps?.eventsRepo ?? createEventsRepository(executor!);

    const result = await repo.upsertProspect({
      id: crypto.randomUUID(),
      orgId,
      name: validation.value.name,
      domain: validation.value.domain,
      dedupeKey: dedupeKey(validation.value),
      industry: validation.value.industry,
      locality: validation.value.locality,
      region: validation.value.region,
      country: validation.value.country,
      sizeBand: validation.value.sizeBand,
      source: "manual",
      sourceRef: null,
      observedAt: now,
    });
    if (!result.ok) return errorResponse("internal_error", "Service unavailable", 503, requestId);

    const { prospect, created } = result.value;

    if (created) {
      await emitProspectingEvent(eventsRepo, {
        type: "prospecting.prospect.created",
        orgId,
        actor,
        subjectKind: "prospect",
        subjectId: prospect.id,
        subjectName: prospect.name,
        requestId,
        occurredAt: now,
        payload: {
          prospectId: prospectPublicId(prospect.id),
          orgId: orgPublicId(orgId),
          name: prospect.name,
          domain: prospect.domain,
          source: "manual",
        },
        description: `Added prospect "${prospect.name}"`,
      });

      await repo.insertActivity({
        id: crypto.randomUUID(),
        orgId,
        prospectId: asUuid(prospect.id),
        kind: "discovered",
        actorUserId: actor.subjectUuid,
        body: null,
        metadata: { source: "manual" },
        createdAt: now,
      });
    }

    // 200 on an upsert of an existing row, 201 on a genuine create — the
    // caller can tell whether they added something or matched something.
    return successResponse({ prospect: toPublicProspect(prospect, null) }, requestId, created ? 201 : 200);
  } catch {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  } finally {
    if (executor) await executor.dispose();
  }
}
