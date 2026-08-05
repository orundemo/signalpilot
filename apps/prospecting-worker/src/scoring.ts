import type { EventsRepository } from "@saas/db/events";
import type { ProspectingRepository, Score } from "@saas/db/prospecting";
import type { Uuid } from "@saas/db/ids";
import { asUuid } from "@saas/db/ids";
import type { ActorContext } from "./router.js";
import { emitProspectingEvent } from "./events.js";
import { orgPublicId, prospectPublicId, scorePublicId } from "./ids.js";
import { scoreProspect } from "./engine/scoring.js";

export interface ScoreAndStoreInput {
  repo: ProspectingRepository;
  eventsRepo: EventsRepository;
  orgId: Uuid;
  prospectId: Uuid;
  prospectName: string;
  actor: ActorContext | null;
  requestId: string;
  now: Date;
  /** `rescored` for an explicit request, `discovered` when a run produced it. */
  trigger: "discovered" | "rescored";
}

export type ScoreAndStoreResult =
  | { ok: true; score: Score; previous: Score | null }
  | { ok: false; reason: "not_found" | "internal" };

/**
 * Compute a score from the prospect's current signals and append it.
 *
 * Append-only is the whole point: a rescore INSERTs. The current score is the
 * newest row, history is free, and "why did this drop from 82 to 61" is
 * answerable by diffing two rows rather than by asking someone who remembers.
 *
 * The score is emitted as `prospecting.prospect.scored` with both the new and
 * the previous value, so a webhook consumer can act on the *change* without
 * having to keep its own copy of the board.
 */
export async function scoreAndStore(input: ScoreAndStoreInput): Promise<ScoreAndStoreResult> {
  const { repo, eventsRepo, orgId, prospectId, actor, requestId, now } = input;

  const signalsResult = await repo.listScorableSignals(orgId, prospectId, now);
  if (!signalsResult.ok) return { ok: false, reason: "internal" };

  const profileResult = await repo.getActiveScoringProfile(orgId);
  if (!profileResult.ok) return { ok: false, reason: "internal" };

  const previousResult = await repo.getLatestScore(orgId, prospectId);
  const previous = previousResult.ok ? previousResult.value : null;

  const profile = profileResult.value;
  const computed = scoreProspect(
    signalsResult.value.map((s) => ({
      id: s.id,
      kind: s.kind,
      severity: s.severity,
      features: s.features as Record<string, string | number | boolean | null>,
      observedAt: s.observedAt,
      expiresAt: s.expiresAt,
    })),
    profile ? { version: profile.version, weights: profile.weights } : null,
    { now },
  );

  const inserted = await repo.insertScore({
    id: crypto.randomUUID(),
    orgId,
    prospectId,
    score: computed.score,
    band: computed.band,
    rulesetVersion: computed.rulesetVersion,
    profileVersion: computed.profileVersion,
    contributions: computed.contributions,
    signalIds: computed.signalIds,
    computedAt: now,
  });
  if (!inserted.ok) return { ok: false, reason: "internal" };

  await emitProspectingEvent(eventsRepo, {
    type: "prospecting.prospect.scored",
    orgId,
    actor,
    subjectKind: "prospect",
    subjectId: prospectId,
    subjectName: input.prospectName,
    requestId,
    occurredAt: now,
    payload: {
      prospectId: prospectPublicId(prospectId),
      orgId: orgPublicId(orgId),
      scoreId: scorePublicId(inserted.value.id),
      score: computed.score,
      band: computed.band,
      previousScore: previous?.score ?? null,
      previousBand: previous?.band ?? null,
      rulesetVersion: computed.rulesetVersion,
      profileVersion: computed.profileVersion,
      trigger: input.trigger,
    },
    description:
      previous === null
        ? `Scored "${input.prospectName}" at ${computed.score} (${computed.band})`
        : `Rescored "${input.prospectName}": ${previous.score} → ${computed.score} (${computed.band})`,
  });

  if (input.trigger === "rescored") {
    await repo.insertActivity({
      id: crypto.randomUUID(),
      orgId,
      prospectId: asUuid(prospectId),
      kind: "rescored",
      actorUserId: actor ? actor.subjectUuid : null,
      body: null,
      metadata: {
        score: computed.score,
        band: computed.band,
        previousScore: previous?.score ?? null,
        rulesetVersion: computed.rulesetVersion,
        profileVersion: computed.profileVersion,
      },
      createdAt: now,
    });
  }

  return { ok: true, score: inserted.value, previous };
}
