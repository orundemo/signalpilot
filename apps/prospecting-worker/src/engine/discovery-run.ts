import type { EventsRepository } from "@saas/db/events";
import type { ProspectingRepository } from "@saas/db/prospecting";
import type { Uuid } from "@saas/db/ids";
import type { DiscoveryAdapterId, DiscoveryQuery } from "@saas/contracts/prospecting";
import { PROSPECTING_METERS, isSignalFeatures, isSourceDigest } from "@saas/contracts/prospecting";
import { asUuid } from "@saas/db/ids";
import type { Env } from "../env.js";
import type { ActorContext } from "../router.js";
import type { DiscoveryAdapter } from "../adapters/index.js";
import { resolveAdapter } from "../adapters/index.js";
import { dedupeKey } from "./dedupe.js";
import { scoreAndStore } from "../scoring.js";
import { emitProspectingEvent } from "../events.js";
import { recordUsage } from "../metering-client.js";
import { discoveryPublicId, orgPublicId, prospectPublicId } from "../ids.js";

export interface RunDiscoveryInput {
  env: Env;
  repo: ProspectingRepository;
  eventsRepo: EventsRepository;
  orgId: Uuid;
  runId: Uuid;
  adapterId: DiscoveryAdapterId;
  query: DiscoveryQuery;
  actor: ActorContext;
  requestId: string;
  now: Date;
  /** Injected in tests; production resolves from the registry. */
  adapter?: DiscoveryAdapter;
}

export interface RunCounters {
  candidatesFound: number;
  prospectsCreated: number;
  prospectsUpdated: number;
  signalsRecorded: number;
}

/**
 * The background half of a discovery run (design.md §4.2, steps 5–7).
 *
 * Two properties are load-bearing:
 *
 * **Partial failure is a first-class outcome.** A run that produced 60 of 100
 * candidates before an adapter error finishes as `failed` with the counters it
 * did achieve, and every prospect already written stays. Discovery is
 * idempotent by dedupe key, so a retry converges rather than duplicating.
 *
 * **Metering counts created prospects, not candidates examined.** The number
 * the tenant is billed for is the number they can see in the console. Anything
 * else invites a support argument that the vendor loses.
 */
export async function runDiscovery(input: RunDiscoveryInput): Promise<RunCounters> {
  const { repo, eventsRepo, orgId, runId, query, actor, requestId, now } = input;
  const adapter = input.adapter ?? resolveAdapter(input.adapterId);

  const counters: RunCounters = {
    candidatesFound: 0,
    prospectsCreated: 0,
    prospectsUpdated: 0,
    signalsRecorded: 0,
  };

  let errorCode: string | null = null;

  try {
    for await (const candidate of adapter.search(
      {
        location: query.location ?? null,
        industry: query.industry ?? null,
        sizeBand: query.sizeBand ?? null,
        domains: query.domains ?? [],
        limit: query.limit,
      },
      { requestId, now },
    )) {
      counters.candidatesFound += 1;

      const prospectId = crypto.randomUUID();
      const upserted = await repo.upsertProspect({
        id: prospectId,
        orgId,
        name: candidate.name,
        domain: candidate.domain,
        dedupeKey: dedupeKey(candidate),
        industry: candidate.industry,
        locality: candidate.locality,
        region: candidate.region,
        country: candidate.country,
        sizeBand: candidate.sizeBand,
        source: adapter.id,
        sourceRef: candidate.sourceRef,
        observedAt: now,
      });

      if (!upserted.ok) {
        // One bad row must not abandon the rest of the run.
        continue;
      }

      const prospect = upserted.value.prospect;
      if (upserted.value.created) counters.prospectsCreated += 1;
      else counters.prospectsUpdated += 1;

      const drafts = await adapter.observe(candidate, { requestId, now });
      for (const draft of drafts) {
        // The contract's invariants are enforced at the persistence boundary,
        // not only at the adapter's own edge: a third-party adapter added
        // later cannot smuggle a payload through by ignoring the interface.
        if (!isSignalFeatures(draft.features) || !isSourceDigest(draft.sourceDigest)) continue;

        const expiresAt =
          draft.expiresInDays > 0
            ? new Date(now.getTime() + draft.expiresInDays * 24 * 60 * 60 * 1000)
            : null;

        const inserted = await repo.insertSignal({
          id: crypto.randomUUID(),
          orgId,
          prospectId: asUuid(prospect.id),
          kind: draft.kind,
          severity: draft.severity,
          features: draft.features,
          source: adapter.id,
          sourceDigest: draft.sourceDigest,
          observedAt: now,
          expiresAt,
        });
        if (inserted.ok) counters.signalsRecorded += 1;
      }

      if (upserted.value.created) {
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
            source: adapter.id,
            discoveryId: discoveryPublicId(runId),
          },
          description: `Discovered prospect "${prospect.name}"`,
        });
      }

      await repo.insertActivity({
        id: crypto.randomUUID(),
        orgId,
        prospectId: asUuid(prospect.id),
        kind: "discovered",
        actorUserId: actor.subjectUuid,
        body: null,
        metadata: { discoveryId: discoveryPublicId(runId), adapter: adapter.id },
        createdAt: now,
      });

      // Score at the end of each candidate rather than in a second pass: the
      // signals are already written, and a run that dies later still leaves
      // every prospect it produced with a score the board can render.
      await scoreAndStore({
        repo,
        eventsRepo,
        orgId,
        prospectId: asUuid(prospect.id),
        prospectName: prospect.name,
        actor,
        requestId,
        now,
        trigger: "discovered",
      });
    }
  } catch (err: unknown) {
    errorCode = err instanceof Error && err.message ? err.message.slice(0, 120) : "adapter_error";
  }

  // ── Meter what was created, then close the run ────────────
  if (counters.prospectsCreated > 0 && input.env.METERING_WORKER) {
    // The key is the run, so a retried or duplicated background pass cannot
    // double-charge: metering-worker rejects the second write as a conflict.
    await recordUsage(
      input.env.METERING_WORKER,
      {
        orgPublicId: orgPublicId(orgId),
        metric: PROSPECTING_METERS.prospectsDiscovered,
        quantity: counters.prospectsCreated,
        idempotencyKey: `discovery:${runId}`,
        metadata: { adapter: adapter.id },
      },
      requestId,
    );
  }

  const status = errorCode ? "failed" : "completed";
  const finishedAt = new Date(now.getTime());
  await repo.finishDiscoveryRun(orgId, runId, {
    status,
    ...counters,
    errorCode,
    finishedAt,
  });

  await emitProspectingEvent(eventsRepo, {
    type: "prospecting.discovery.completed",
    orgId,
    actor,
    subjectKind: "discovery_run",
    subjectId: runId,
    subjectName: adapter.id,
    requestId,
    occurredAt: finishedAt,
    payload: {
      discoveryId: discoveryPublicId(runId),
      orgId: orgPublicId(orgId),
      adapter: adapter.id,
      status,
      errorCode,
      ...counters,
    },
    description:
      status === "completed"
        ? `Discovery run completed — ${counters.prospectsCreated} created, ${counters.prospectsUpdated} updated`
        : `Discovery run failed after ${counters.prospectsCreated} created (${errorCode})`,
  });

  return counters;
}
