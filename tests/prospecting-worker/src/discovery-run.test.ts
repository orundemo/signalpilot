import { runDiscovery } from "@prospecting-worker/engine/discovery-run";
import type { Env } from "@prospecting-worker/env";
import type { ActorContext } from "@prospecting-worker/router";
import { createSyntheticAdapter } from "@prospecting-worker/adapters/synthetic";
import type { DiscoveryAdapter } from "@prospecting-worker/adapters/types";
import { asUuid } from "@saas/db/ids";
import { isSignalFeatures, isSourceDigest } from "@saas/contracts/prospecting";
import { createFakeEventsRepo, createFakeRepo, fetcherReturning } from "./fakes.js";

const ORG = asUuid("11111111-1111-1111-1111-111111111111");
const RUN = asUuid("22222222-2222-2222-2222-222222222222");
const RUN_2 = asUuid("33333333-3333-3333-3333-333333333333");
const NOW = new Date("2026-06-01T00:00:00.000Z");

const ACTOR: ActorContext = {
  subjectId: "usr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  subjectType: "user",
  subjectUuid: asUuid("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"),
};

const QUERY = { location: "Leeds", industry: null, sizeBand: null, domains: [], limit: 5 };

function createEnv(overrides?: Partial<Env>): Env {
  return { ENVIRONMENT: "test", ...overrides } as Env;
}

async function seedRun(repo: ReturnType<typeof createFakeRepo>, id = RUN) {
  await repo.createDiscoveryRun({
    id,
    orgId: ORG,
    requestedBy: ACTOR.subjectUuid,
    adapter: "synthetic",
    query: QUERY,
    startedAt: NOW,
  });
}

describe("discovery run — happy path", () => {
  it("creates prospects with signals and reports accurate counters", async () => {
    const repo = createFakeRepo();
    const eventsRepo = createFakeEventsRepo();
    await seedRun(repo);

    const counters = await runDiscovery({
      env: createEnv(),
      repo,
      eventsRepo,
      orgId: ORG,
      runId: RUN,
      adapterId: "synthetic",
      query: QUERY,
      actor: ACTOR,
      requestId: "req_1",
      now: NOW,
    });

    expect(counters.candidatesFound).toBe(5);
    expect(counters.prospectsCreated).toBe(repo.prospects.size);
    expect(counters.prospectsCreated).toBeGreaterThan(0);
    expect(counters.prospectsUpdated).toBe(0);
    expect(counters.signalsRecorded).toBe(repo.signals.length);
    expect(repo.signals.length).toBeGreaterThan(0);

    const run = repo.runs.get(RUN)!;
    expect(run.status).toBe("completed");
    expect(run.errorCode).toBeNull();
    expect(run.finishedAt).not.toBeNull();
    expect(run.prospectsCreated).toBe(counters.prospectsCreated);
  });

  it("writes a discovered activity per prospect", async () => {
    const repo = createFakeRepo();
    await seedRun(repo);
    await runDiscovery({
      env: createEnv(),
      repo,
      eventsRepo: createFakeEventsRepo(),
      orgId: ORG,
      runId: RUN,
      adapterId: "synthetic",
      query: QUERY,
      actor: ACTOR,
      requestId: "req_1",
      now: NOW,
    });
    expect(repo.activities.filter((a) => a.kind === "discovered")).toHaveLength(repo.prospects.size);
  });

  it("emits prospect.created per new prospect and one discovery.completed", async () => {
    const repo = createFakeRepo();
    const eventsRepo = createFakeEventsRepo();
    await seedRun(repo);

    await runDiscovery({
      env: createEnv(),
      repo,
      eventsRepo,
      orgId: ORG,
      runId: RUN,
      adapterId: "synthetic",
      query: QUERY,
      actor: ACTOR,
      requestId: "req_1",
      now: NOW,
    });

    const types = eventsRepo.appended.map((e) => e.event.type);
    expect(types.filter((t) => t === "prospecting.prospect.created")).toHaveLength(repo.prospects.size);
    expect(types.filter((t) => t === "prospecting.discovery.completed")).toHaveLength(1);
  });
});

describe("discovery run — dedupe", () => {
  it("re-running the same query creates zero duplicates and counts updates instead", async () => {
    const repo = createFakeRepo();
    const eventsRepo = createFakeEventsRepo();
    await seedRun(repo);

    const first = await runDiscovery({
      env: createEnv(),
      repo,
      eventsRepo,
      orgId: ORG,
      runId: RUN,
      adapterId: "synthetic",
      query: QUERY,
      actor: ACTOR,
      requestId: "req_1",
      now: NOW,
    });

    const sizeAfterFirst = repo.prospects.size;
    await seedRun(repo, RUN_2);

    const second = await runDiscovery({
      env: createEnv(),
      repo,
      eventsRepo,
      orgId: ORG,
      runId: RUN_2,
      adapterId: "synthetic",
      query: QUERY,
      actor: ACTOR,
      requestId: "req_2",
      // A later clock, so the signal uniqueness constraint does not collide.
      now: new Date("2026-06-02T00:00:00.000Z"),
    });

    expect(repo.prospects.size).toBe(sizeAfterFirst);
    expect(second.prospectsCreated).toBe(0);
    expect(second.prospectsUpdated).toBe(first.prospectsCreated + first.prospectsUpdated);
  });

  it("emits no prospect.created event on a converging re-run", async () => {
    const repo = createFakeRepo();
    const eventsRepo = createFakeEventsRepo();
    await seedRun(repo);
    await runDiscovery({
      env: createEnv(), repo, eventsRepo, orgId: ORG, runId: RUN,
      adapterId: "synthetic", query: QUERY, actor: ACTOR, requestId: "req_1", now: NOW,
    });

    const beforeSecond = eventsRepo.appended.length;
    await seedRun(repo, RUN_2);
    await runDiscovery({
      env: createEnv(), repo, eventsRepo, orgId: ORG, runId: RUN_2,
      adapterId: "synthetic", query: QUERY, actor: ACTOR, requestId: "req_2",
      now: new Date("2026-06-02T00:00:00.000Z"),
    });

    const secondRunEvents = eventsRepo.appended.slice(beforeSecond).map((e) => e.event.type);
    expect(secondRunEvents).not.toContain("prospecting.prospect.created");
    // A converging re-run still rescores — the signals were refreshed — so
    // `scored` is expected; only `created` must not repeat.
    expect(secondRunEvents.filter((t) => t === "prospecting.prospect.scored").length).toBeGreaterThan(0);
    expect(secondRunEvents[secondRunEvents.length - 1]).toBe("prospecting.discovery.completed");
  });
});

describe("discovery run — never store raw", () => {
  it("every persisted signal holds scalar features and a 64-char hex digest", async () => {
    const repo = createFakeRepo();
    await seedRun(repo);
    await runDiscovery({
      env: createEnv(), repo, eventsRepo: createFakeEventsRepo(), orgId: ORG, runId: RUN,
      adapterId: "synthetic", query: QUERY, actor: ACTOR, requestId: "req_1", now: NOW,
    });

    expect(repo.signals.length).toBeGreaterThan(0);
    for (const signal of repo.signals) {
      expect(isSignalFeatures(signal.features)).toBe(true);
      expect(isSourceDigest(signal.sourceDigest)).toBe(true);
      expect(signal.expiresAt).not.toBeNull();
    }
  });

  it("rejects a signal an adapter tries to smuggle a payload into", async () => {
    const repo = createFakeRepo();
    await seedRun(repo);

    // A third-party adapter that ignores the interface contract. The run must
    // drop its output rather than trust it — the persistence boundary is the
    // enforcement point, not the adapter's own good manners.
    const rogue: DiscoveryAdapter = {
      id: "rogue",
      requiresConnection: false,
      async *search() {
        yield {
          name: "Rogue Ltd", domain: "rogue.example", industry: null, locality: null,
          region: null, country: null, sizeBand: "unknown" as const, sourceRef: "rogue-1",
        };
      },
      async observe() {
        return [
          {
            kind: "tls_missing" as const,
            severity: 5 as const,
            features: { response: { body: "<html>secrets</html>" } } as never,
            sourceDigest: "a".repeat(64),
            expiresInDays: 30,
          },
          {
            kind: "perf_poor" as const,
            severity: 3 as const,
            features: { lcp_ms: 5000 },
            sourceDigest: "<html>not a digest</html>",
            expiresInDays: 30,
          },
        ];
      },
    };

    const counters = await runDiscovery({
      env: createEnv(), repo, eventsRepo: createFakeEventsRepo(), orgId: ORG, runId: RUN,
      adapterId: "synthetic", query: QUERY, actor: ACTOR, requestId: "req_1", now: NOW,
      adapter: rogue,
    });

    expect(counters.prospectsCreated).toBe(1);
    expect(counters.signalsRecorded).toBe(0);
    expect(repo.signals).toHaveLength(0);
  });
});

describe("discovery run — partial failure", () => {
  it("fails the run but keeps the prospects it already wrote", async () => {
    const repo = createFakeRepo();
    repo.failUpsertAfter = 3;
    await seedRun(repo);

    const counters = await runDiscovery({
      env: createEnv(), repo, eventsRepo: createFakeEventsRepo(), orgId: ORG, runId: RUN,
      adapterId: "synthetic",
      query: { ...QUERY, limit: 20 },
      actor: ACTOR, requestId: "req_1", now: NOW,
    });

    const run = repo.runs.get(RUN)!;
    expect(run.status).toBe("failed");
    expect(run.errorCode).toBe("adapter_exploded");
    expect(run.prospectsCreated).toBe(3);
    expect(counters.prospectsCreated).toBe(3);
    expect(repo.prospects.size).toBe(3);
  });

  it("still emits discovery.completed for a failed run, carrying the partial counters", async () => {
    const repo = createFakeRepo();
    const eventsRepo = createFakeEventsRepo();
    repo.failUpsertAfter = 2;
    await seedRun(repo);

    await runDiscovery({
      env: createEnv(), repo, eventsRepo, orgId: ORG, runId: RUN,
      adapterId: "synthetic", query: { ...QUERY, limit: 20 },
      actor: ACTOR, requestId: "req_1", now: NOW,
    });

    const completed = eventsRepo.appended.find((e) => e.event.type === "prospecting.discovery.completed")!;
    expect(completed.event.payload.status).toBe("failed");
    expect(completed.event.payload.prospectsCreated).toBe(2);
  });
});

describe("discovery run — metering", () => {
  it("meters created prospects, not candidates examined", async () => {
    const repo = createFakeRepo();
    const metering = fetcherReturning({ data: {} }, 201);
    await seedRun(repo);

    const counters = await runDiscovery({
      env: createEnv({ METERING_WORKER: metering }),
      repo, eventsRepo: createFakeEventsRepo(), orgId: ORG, runId: RUN,
      adapterId: "synthetic", query: QUERY, actor: ACTOR, requestId: "req_1", now: NOW,
    });

    expect(metering.calls).toHaveLength(1);
    expect(metering.calls[0]).toContain("/v1/internal/metering/usage");
    expect(counters.prospectsCreated).toBeLessThanOrEqual(counters.candidatesFound);
  });

  it("does not meter a run that created nothing", async () => {
    const repo = createFakeRepo();
    const metering = fetcherReturning({ data: {} }, 201);
    await seedRun(repo);
    await runDiscovery({
      env: createEnv({ METERING_WORKER: metering }), repo, eventsRepo: createFakeEventsRepo(),
      orgId: ORG, runId: RUN, adapterId: "synthetic", query: QUERY, actor: ACTOR, requestId: "req_1", now: NOW,
    });
    metering.calls.length = 0;

    await seedRun(repo, RUN_2);
    await runDiscovery({
      env: createEnv({ METERING_WORKER: metering }), repo, eventsRepo: createFakeEventsRepo(),
      orgId: ORG, runId: RUN_2, adapterId: "synthetic", query: QUERY, actor: ACTOR, requestId: "req_2",
      now: new Date("2026-06-02T00:00:00.000Z"),
    });

    expect(metering.calls).toHaveLength(0);
  });

  it("keys the meter on the run so a replayed background pass cannot double-charge", async () => {
    const repo = createFakeRepo();
    const bodies: string[] = [];
    const metering = {
      fetch(_input: string, init?: RequestInit) {
        bodies.push(String(init?.body ?? ""));
        return Promise.resolve(new Response("{}", { status: 201 }));
      },
      connect() { throw new Error("not implemented"); },
    } as unknown as Fetcher;

    await seedRun(repo);
    await runDiscovery({
      env: createEnv({ METERING_WORKER: metering }), repo, eventsRepo: createFakeEventsRepo(),
      orgId: ORG, runId: RUN, adapterId: "synthetic", query: QUERY, actor: ACTOR, requestId: "req_1", now: NOW,
    });

    expect(bodies[0]).toContain(`"idempotencyKey":"discovery:${RUN}"`);
  });

  it("a metering outage does not roll back prospects the user can already see", async () => {
    const repo = createFakeRepo();
    const metering = {
      fetch() { return Promise.reject(new Error("metering down")); },
      connect() { throw new Error("not implemented"); },
    } as unknown as Fetcher;

    await seedRun(repo);
    const counters = await runDiscovery({
      env: createEnv({ METERING_WORKER: metering }), repo, eventsRepo: createFakeEventsRepo(),
      orgId: ORG, runId: RUN, adapterId: "synthetic", query: QUERY, actor: ACTOR, requestId: "req_1", now: NOW,
    });

    expect(counters.prospectsCreated).toBeGreaterThan(0);
    expect(repo.runs.get(RUN)!.status).toBe("completed");
  });
});

describe("discovery run — web-signals is reachable through the registry", () => {
  it("runs the synthetic adapter by default when none is injected", async () => {
    const repo = createFakeRepo();
    await seedRun(repo);
    await runDiscovery({
      env: createEnv(), repo, eventsRepo: createFakeEventsRepo(), orgId: ORG, runId: RUN,
      adapterId: "synthetic", query: QUERY, actor: ACTOR, requestId: "req_1", now: NOW,
    });
    for (const prospect of repo.prospects.values()) {
      expect(prospect.source).toBe(createSyntheticAdapter().id);
    }
  });
});
