import type { Env } from "../env.js";
import type { ActorContext } from "../router.js";
import type { Uuid } from "@saas/db/ids";
import type { EventsRepository } from "@saas/db/events";
import type { Insight, ProspectingRepository } from "@saas/db/prospecting";
import type {
  GenerateInsightRequest,
  GuardrailNote,
  InsightKind,
  PublicInsight,
  ScoreBand,
  ScoreContribution,
  SignalKind,
} from "@saas/contracts/prospecting";
import { PROSPECTING_ENTITLEMENTS, PROSPECTING_METERS, isInsightKind } from "@saas/contracts/prospecting";
import { createProspectingRepository } from "@saas/db/prospecting";
import { createEventsRepository } from "@saas/db/events";
import { createSqlExecutor } from "@saas/db/hyperdrive";
import { asUuid } from "@saas/db/ids";
import { authorizeRequest, requireBindings } from "../authorize.js";
import { billingPeriod, checkBillingEntitlement, decideQuota } from "../billing-client.js";
import { errorResponse, quotaExhausted, successResponse, validationError } from "../http.js";
import { insightPublicId, orgPublicId, prospectPublicId, scorePublicId, userPublicId } from "../ids.js";
import { emitProspectingEvent } from "../events.js";
import { recordUsage } from "../metering-client.js";
import { runGuardrail } from "../engine/guardrail.js";
import type { ModelAdapter } from "../model/index.js";
import { PROMPT_VERSION, inputDigest, resolveModelAdapter } from "../model/index.js";

export function toPublicInsight(insight: Insight, cached: boolean): PublicInsight {
  return {
    id: insightPublicId(insight.id),
    orgId: orgPublicId(insight.orgId),
    prospectId: prospectPublicId(insight.prospectId),
    scoreId: scorePublicId(insight.scoreId),
    kind: insight.kind as InsightKind,
    content: insight.content,
    model: insight.model,
    promptVersion: insight.promptVersion,
    guardrailVerdict: insight.guardrailVerdict as "pass" | "revised",
    guardrailNotes: insight.guardrailNotes as GuardrailNote[],
    generatedBy: insight.generatedBy ? userPublicId(insight.generatedBy) : null,
    createdAt: insight.createdAt.toISOString(),
    cached,
  };
}

export interface HandleGenerateInsightDeps {
  repo?: ProspectingRepository;
  eventsRepo?: EventsRepository;
  checkEntitlement?: typeof checkBillingEntitlement;
  adapter?: ModelAdapter;
  now?: Date;
}

/**
 * `POST /prospects/:id/insights`.
 *
 * The order of operations is the milestone:
 *
 *   read score → compute digest → **cache lookup** → **entitlement gate** →
 *   model call → guardrail → store → meter
 *
 * The cache lookup precedes the gate on purpose: replaying a generation the
 * tenant already paid for must not consume a second credit, and must not fail
 * when they are at their limit. The gate precedes the *model call*, so a
 * tenant at their limit never triggers a provider request — asserted by a test
 * that counts adapter invocations.
 *
 * A `blocked` guardrail verdict stores nothing, returns a typed error, and is
 * not metered: the tenant does not pay for output they never receive.
 */
export async function handleGenerateInsight(
  request: Request,
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: Uuid,
  prospectId: Uuid,
  deps?: HandleGenerateInsightDeps,
): Promise<Response> {
  const missing = requireBindings(env, requestId);
  if (missing) return missing;
  if (!env.BILLING_WORKER) return errorResponse("internal_error", "Service unavailable", 503, requestId);

  let body: unknown = {};
  try {
    if (request.body) body = await request.json();
  } catch {
    return validationError(requestId, { body: ["Invalid JSON"] });
  }

  const requested = (body as GenerateInsightRequest | null)?.kind;
  const kind: InsightKind = requested === undefined ? "prospect_summary" : (requested as InsightKind);
  if (!isInsightKind(kind)) {
    return validationError(requestId, { kind: ["Must be one of: prospect_summary, outreach_email"] });
  }

  const authz = await authorizeRequest(env, requestId, actor, orgId, "organization.insight.generate");
  if (!authz.ok) return authz.response;

  const now = deps?.now ?? new Date();
  const executor = deps?.repo && deps?.eventsRepo ? null : createSqlExecutor(env.PLATFORM_DB!);

  try {
    const repo = deps?.repo ?? createProspectingRepository(executor!);
    const eventsRepo = deps?.eventsRepo ?? createEventsRepository(executor!);

    const prospectResult = await repo.getProspect(orgId, prospectId);
    if (!prospectResult.ok) {
      if (prospectResult.error.kind === "not_found") return errorResponse("not_found", "Not found", 404, requestId);
      return errorResponse("internal_error", "Service unavailable", 503, requestId);
    }
    const { prospect, score } = prospectResult.value;

    // An insight explains a score. Without one there is nothing to explain,
    // and generating prose about an unscored prospect would be the model
    // inventing the judgement the engine is supposed to own.
    if (!score) {
      return errorResponse(
        "precondition_failed",
        "This prospect has no score yet — run a rescore first",
        412,
        requestId,
        { reason: "no_score" },
      );
    }

    const contributions = score.contributions as ScoreContribution[];
    const digest = await inputDigest(kind, PROMPT_VERSION, score.id, contributions);

    // ── Cache ───────────────────────────────────────────────
    const cached = await repo.findInsightByDigest(orgId, digest);
    if (!cached.ok) return errorResponse("internal_error", "Service unavailable", 503, requestId);
    if (cached.value) {
      return successResponse({ insight: toPublicInsight(cached.value, true) }, requestId);
    }

    // ── Entitlement gate — before the model call, never after ─
    const { periodStart, resetAt } = billingPeriod(now);
    const decision = await (deps?.checkEntitlement ?? checkBillingEntitlement)(
      env.BILLING_WORKER,
      orgPublicId(orgId),
      PROSPECTING_ENTITLEMENTS.insight,
      requestId,
    );
    if (decision.kind === "service_error") {
      return errorResponse("internal_error", "Service unavailable", 503, requestId);
    }

    const usedResult = await repo.countInsightsSince(orgId, periodStart);
    if (!usedResult.ok) return errorResponse("internal_error", "Service unavailable", 503, requestId);

    const gate = decideQuota(
      decision.decision,
      usedResult.value,
      PROSPECTING_METERS.insightsGenerated,
      resetAt,
      {
        unavailable: "AI insights are not available on your current plan",
        exhausted: "Your plan's monthly insight allowance is spent",
      },
    );
    if (gate.kind === "service_error") return errorResponse("internal_error", "Service unavailable", 503, requestId);
    if (gate.kind === "deny") {
      await emitProspectingEvent(eventsRepo, {
        type: "prospecting.quota.exhausted",
        orgId,
        actor,
        subjectKind: "organization",
        subjectId: orgId,
        subjectName: null,
        requestId,
        occurredAt: now,
        payload: { ...gate.details, orgId: orgPublicId(orgId) },
        description: "Insight generation blocked — monthly allowance spent",
      });
      return quotaExhausted(requestId, gate.message, gate.details);
    }

    // ── Generate ────────────────────────────────────────────
    const adapter = deps?.adapter ?? resolveModelAdapter(env);
    const generation = await adapter.generate({
      kind,
      prospectName: prospect.name,
      prospectDomain: prospect.domain,
      industry: prospect.industry,
      locality: prospect.locality,
      score: score.score,
      band: score.band as ScoreBand,
      contributions,
    });

    if (!generation.ok) {
      if (generation.reason === "declined") {
        return errorResponse("precondition_failed", "The model declined to write this draft", 412, requestId, {
          reason: "model_declined",
        });
      }
      return errorResponse("internal_error", "The writing service is unavailable", 503, requestId);
    }

    // ── Guardrail ───────────────────────────────────────────
    const verdict = runGuardrail({
      content: generation.result.content,
      allowedKinds: contributions.map((c) => c.kind as SignalKind),
      score: score.score,
      contributions,
      prospectName: prospect.name,
      prospectDomain: prospect.domain,
      kind,
    });

    if (verdict.verdict === "blocked") {
      // Nothing stored, nothing metered. The notes are returned so the
      // console can say *why* rather than showing a bare failure.
      return errorResponse(
        "precondition_failed",
        "The generated draft did not pass the content guardrail",
        412,
        requestId,
        { reason: "guardrail_blocked", notes: verdict.notes },
      );
    }

    const inserted = await repo.insertInsight({
      id: crypto.randomUUID(),
      orgId,
      prospectId: asUuid(prospectId),
      scoreId: asUuid(score.id),
      kind,
      content: verdict.content,
      model: generation.result.model,
      promptVersion: PROMPT_VERSION,
      inputDigest: digest,
      guardrailVerdict: verdict.verdict,
      guardrailNotes: verdict.notes,
      generatedBy: actor.subjectUuid,
      createdAt: now,
    });

    if (!inserted.ok) {
      if (inserted.error.kind === "conflict") {
        // A concurrent request stored the same digest first. Return theirs —
        // the content is identical by construction, and this request is not
        // metered for work it did not persist.
        const raced = await repo.findInsightByDigest(orgId, digest);
        if (raced.ok && raced.value) {
          return successResponse({ insight: toPublicInsight(raced.value, true) }, requestId);
        }
      }
      return errorResponse("internal_error", "Service unavailable", 503, requestId);
    }

    await emitProspectingEvent(eventsRepo, {
      type: "prospecting.insight.generated",
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
        insightId: insightPublicId(inserted.value.id),
        kind,
        model: generation.result.model,
        promptVersion: PROMPT_VERSION,
        guardrailVerdict: verdict.verdict,
      },
      description: `Generated ${kind === "outreach_email" ? "outreach draft" : "summary"} for "${prospect.name}"`,
    });

    await repo.insertActivity({
      id: crypto.randomUUID(),
      orgId,
      prospectId: asUuid(prospectId),
      kind: "insight_generated",
      actorUserId: actor.subjectUuid,
      body: null,
      metadata: { kind, guardrailVerdict: verdict.verdict, model: generation.result.model },
      createdAt: now,
    });

    // Metered last: only a generation that survived the guardrail and reached
    // the database is billable.
    if (env.METERING_WORKER) {
      await recordUsage(
        env.METERING_WORKER,
        {
          orgPublicId: orgPublicId(orgId),
          metric: PROSPECTING_METERS.insightsGenerated,
          quantity: 1,
          idempotencyKey: `insight:${digest}`,
          metadata: { kind },
        },
        requestId,
      );
    }

    return successResponse({ insight: toPublicInsight(inserted.value, false) }, requestId, 201);
  } catch {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  } finally {
    if (executor) await executor.dispose();
  }
}
