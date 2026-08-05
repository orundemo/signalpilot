import { handleRescoreProspect } from "@prospecting-worker/handlers/rescore-prospect";
import { handleListScores } from "@prospecting-worker/handlers/list-scores";
import { handleBulkRescore } from "@prospecting-worker/handlers/bulk-rescore";
import { handleGetScoringProfile, handlePutScoringProfile } from "@prospecting-worker/handlers/scoring-profile";
import { route } from "@prospecting-worker/router";
import type { Env } from "@prospecting-worker/env";
import type { ActorContext } from "@prospecting-worker/router";
import { asUuid } from "@saas/db/ids";
import { DEFAULT_SIGNAL_WEIGHTS } from "@saas/contracts/prospecting";
import { createFakeEventsRepo, createFakeRepo, fetcherReturning } from "./fakes.js";
import type { FakeProspectingRepo } from "./fakes.js";

const ORG_UUID = asUuid("11111111-1111-1111-1111-111111111111");
const ORG = "org_11111111111111111111111111111111";
const PROSPECT_UUID = asUuid("22222222-2222-2222-2222-222222222222");
const PROSPECT = "prs_22222222222222222222222222222222";
const NOW = new Date("2026-06-01T00:00:00.000Z");

const ACTOR: ActorContext = {
  subjectId: "usr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  subjectType: "user",
  subjectUuid: asUuid("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"),
};

const ACTOR_HEADERS = {
  "x-actor-subject-id": ACTOR.subjectId,
  "x-actor-subject-type": "user",
};

interface ErrorBody {
  error: { code: string; details?: Record<string, unknown> };
}

function allowingEnv(overrides?: Partial<Env>): Env {
  return {
    ENVIRONMENT: "test",
    PLATFORM_DB: {} as Hyperdrive,
    MEMBERSHIP_WORKER: fetcherReturning({
      data: { memberships: [{ kind: "role_assignment", role: "owner", scope: { kind: "organization", orgId: ORG_UUID } }] },
    }),
    POLICY_WORKER: fetcherReturning({ data: { allow: true, reason: "org_owner", policyVersion: 1, derivedScope: { orgId: ORG_UUID } } }),
    ...overrides,
  } as Env;
}

function denyingEnv(): Env {
  return allowingEnv({
    POLICY_WORKER: fetcherReturning({ data: { allow: false, reason: "no_matching_role", policyVersion: 1, derivedScope: { orgId: ORG_UUID } } }),
  });
}

async function seedProspect(repo: FakeProspectingRepo, kinds: Array<[string, number]>) {
  await repo.upsertProspect({
    id: PROSPECT_UUID,
    orgId: ORG_UUID,
    name: "Ridgeway Plumbing",
    domain: "ridgeway.example",
    dedupeKey: "d:ridgeway.example",
    industry: "plumbing",
    locality: "Leeds",
    region: "England",
    country: "GB",
    sizeBand: "micro",
    source: "synthetic",
    sourceRef: "syn-1",
    observedAt: NOW,
  });
  let i = 0;
  for (const [kind, severity] of kinds) {
    i += 1;
    await repo.insertSignal({
      id: `33333333-3333-3333-3333-${String(i).padStart(12, "0")}`,
      orgId: ORG_UUID,
      prospectId: PROSPECT_UUID,
      kind,
      severity,
      features: {},
      source: "synthetic",
      sourceDigest: "a".repeat(64),
      observedAt: NOW,
      expiresAt: new Date("2026-07-01T00:00:00.000Z"),
    });
  }
}

describe("POST /prospects/:id/rescore", () => {
  it("appends a score rather than updating one", async () => {
    const repo = createFakeRepo();
    const eventsRepo = createFakeEventsRepo();
    await seedProspect(repo, [["tls_missing", 5]]);

    const first = await handleRescoreProspect(allowingEnv(), "req_1", ACTOR, ORG_UUID, PROSPECT_UUID, { repo, eventsRepo, now: NOW });
    expect(first.status).toBe(201);
    expect(repo.scores).toHaveLength(1);

    const second = await handleRescoreProspect(allowingEnv(), "req_2", ACTOR, ORG_UUID, PROSPECT_UUID, {
      repo, eventsRepo, now: new Date("2026-06-02T00:00:00.000Z"),
    });
    expect(second.status).toBe(201);
    expect(repo.scores).toHaveLength(2);
  });

  it("returns the full explanation, not just a number", async () => {
    const repo = createFakeRepo();
    await seedProspect(repo, [["tls_missing", 5], ["perf_poor", 4]]);

    const response = await handleRescoreProspect(allowingEnv(), "req_1", ACTOR, ORG_UUID, PROSPECT_UUID, {
      repo, eventsRepo: createFakeEventsRepo(), now: NOW,
    });
    const body = (await response.json()) as {
      data: { score: { score: number; band: string; rulesetVersion: number; profileVersion: number; contributions: Array<{ kind: string; points: number; reason: string; signalId: string }>; signalIds: string[] } };
    };

    // tls_missing at severity 5 → 25; perf_poor at severity 4 → 20 × 0.85 = 17.
    expect(body.data.score.score).toBe(25 + 17);
    expect(body.data.score.band).toBe("warm");
    expect(body.data.score.rulesetVersion).toBe(1);
    expect(body.data.score.profileVersion).toBe(0);
    expect(body.data.score.contributions).toHaveLength(2);
    for (const contribution of body.data.score.contributions) {
      expect(contribution.reason.length).toBeGreaterThan(0);
      expect(contribution.signalId).toMatch(/^sig_[0-9a-f]{32}$/);
    }
    expect(body.data.score.signalIds).toHaveLength(2);
  });

  it("emits prospect.scored carrying the previous value so a consumer can act on the change", async () => {
    const repo = createFakeRepo();
    const eventsRepo = createFakeEventsRepo();
    await seedProspect(repo, [["tls_missing", 5]]);

    await handleRescoreProspect(allowingEnv(), "req_1", ACTOR, ORG_UUID, PROSPECT_UUID, { repo, eventsRepo, now: NOW });
    await handleRescoreProspect(allowingEnv(), "req_2", ACTOR, ORG_UUID, PROSPECT_UUID, {
      repo, eventsRepo, now: new Date("2026-06-02T00:00:00.000Z"),
    });

    const scored = eventsRepo.appended.filter((e) => e.event.type === "prospecting.prospect.scored");
    expect(scored).toHaveLength(2);
    expect(scored[0]!.event.payload.previousScore).toBeNull();
    expect(scored[1]!.event.payload.previousScore).toBe(25);
    expect(scored[1]!.event.payload.trigger).toBe("rescored");
  });

  it("writes a rescored activity to the timeline", async () => {
    const repo = createFakeRepo();
    await seedProspect(repo, [["tls_missing", 5]]);
    await handleRescoreProspect(allowingEnv(), "req_1", ACTOR, ORG_UUID, PROSPECT_UUID, {
      repo, eventsRepo: createFakeEventsRepo(), now: NOW,
    });
    expect(repo.activities.filter((a) => a.kind === "rescored")).toHaveLength(1);
  });

  it("returns 404 for an unknown prospect and for a denied caller", async () => {
    const repo = createFakeRepo();
    const deps = { repo, eventsRepo: createFakeEventsRepo(), now: NOW };
    expect((await handleRescoreProspect(allowingEnv(), "req_1", ACTOR, ORG_UUID, PROSPECT_UUID, deps)).status).toBe(404);

    await seedProspect(repo, [["tls_missing", 5]]);
    expect((await handleRescoreProspect(denyingEnv(), "req_1", ACTOR, ORG_UUID, PROSPECT_UUID, deps)).status).toBe(404);
  });
});

describe("GET /prospects/:id/scores", () => {
  it("returns the history newest first", async () => {
    const repo = createFakeRepo();
    const eventsRepo = createFakeEventsRepo();
    await seedProspect(repo, [["tls_missing", 5]]);
    await handleRescoreProspect(allowingEnv(), "req_1", ACTOR, ORG_UUID, PROSPECT_UUID, { repo, eventsRepo, now: NOW });
    await handleRescoreProspect(allowingEnv(), "req_2", ACTOR, ORG_UUID, PROSPECT_UUID, {
      repo, eventsRepo, now: new Date("2026-06-05T00:00:00.000Z"),
    });

    const response = await handleListScores(
      new Request("https://prospecting.internal/scores"),
      allowingEnv(), "req_3", ACTOR, ORG_UUID, PROSPECT_UUID, { repo },
    );
    const body = (await response.json()) as { data: { scores: Array<{ computedAt: string }> } };
    expect(body.data.scores).toHaveLength(2);
    expect(new Date(body.data.scores[0]!.computedAt).getTime()).toBeGreaterThan(
      new Date(body.data.scores[1]!.computedAt).getTime(),
    );
  });

  it("404s on an unknown prospect rather than returning an empty list", async () => {
    const response = await handleListScores(
      new Request("https://prospecting.internal/scores"),
      allowingEnv(), "req_1", ACTOR, ORG_UUID, PROSPECT_UUID, { repo: createFakeRepo() },
    );
    expect(response.status).toBe(404);
  });
});

describe("scoring profile", () => {
  it("returns the ruleset defaults at version 0 before any org tuning", async () => {
    const response = await handleGetScoringProfile(allowingEnv(), "req_1", ACTOR, ORG_UUID, { repo: createFakeRepo() });
    const body = (await response.json()) as {
      data: { profile: { version: number; weights: Record<string, number>; effectiveWeights: Record<string, number> } };
    };
    expect(body.data.profile.version).toBe(0);
    expect(body.data.profile.weights).toEqual({});
    expect(body.data.profile.effectiveWeights).toEqual(DEFAULT_SIGNAL_WEIGHTS);
  });

  it("inserts a new version and deactivates the previous one", async () => {
    const repo = createFakeRepo();
    const env = allowingEnv();

    const first = await handlePutScoringProfile(
      new Request("https://x/p", { method: "PUT", body: JSON.stringify({ weights: { tls_missing: 40 } }) }),
      env, "req_1", ACTOR, ORG_UUID, { repo, now: NOW },
    );
    expect(first.status).toBe(201);

    const second = await handlePutScoringProfile(
      new Request("https://x/p", { method: "PUT", body: JSON.stringify({ weights: { tls_missing: 10 } }) }),
      env, "req_2", ACTOR, ORG_UUID, { repo, now: NOW },
    );
    const body = (await second.json()) as { data: { profile: { version: number; isActive: boolean } } };
    expect(body.data.profile.version).toBe(2);
    expect(body.data.profile.isActive).toBe(true);

    const active = await repo.getActiveScoringProfile(ORG_UUID);
    expect(active.ok && active.value?.version).toBe(2);
  });

  it("leaves existing scores untouched until a bulk rescore is explicitly run", async () => {
    const repo = createFakeRepo();
    const eventsRepo = createFakeEventsRepo();
    await seedProspect(repo, [["tls_missing", 5]]);
    await handleRescoreProspect(allowingEnv(), "req_1", ACTOR, ORG_UUID, PROSPECT_UUID, { repo, eventsRepo, now: NOW });
    expect(repo.scores[0]!.score).toBe(25);

    await handlePutScoringProfile(
      new Request("https://x/p", { method: "PUT", body: JSON.stringify({ weights: { tls_missing: 90 } }) }),
      allowingEnv(), "req_2", ACTOR, ORG_UUID, { repo, now: NOW },
    );

    // The board has not moved.
    expect(repo.scores).toHaveLength(1);
    expect(repo.scores[0]!.score).toBe(25);

    // …until asked.
    const bulk = await handleBulkRescore(allowingEnv(), "req_3", ACTOR, ORG_UUID, {
      repo, eventsRepo, now: new Date("2026-06-02T00:00:00.000Z"),
    });
    expect(bulk.status).toBe(200);
    expect(repo.scores).toHaveLength(2);
    expect(repo.scores[1]!.score).toBe(90);
    expect(repo.scores[1]!.profileVersion).toBe(1);
  });

  it("rejects an unknown signal kind and an out-of-range weight", async () => {
    const env = allowingEnv();
    const bad = await handlePutScoringProfile(
      new Request("https://x/p", { method: "PUT", body: JSON.stringify({ weights: { vibes_bad: 10 } }) }),
      env, "req_1", ACTOR, ORG_UUID, { repo: createFakeRepo(), now: NOW },
    );
    expect(bad.status).toBe(422);

    const outOfRange = await handlePutScoringProfile(
      new Request("https://x/p", { method: "PUT", body: JSON.stringify({ weights: { tls_missing: 500 } }) }),
      env, "req_2", ACTOR, ORG_UUID, { repo: createFakeRepo(), now: NOW },
    );
    expect(outOfRange.status).toBe(422);
    const body = (await outOfRange.json()) as ErrorBody;
    expect(body.error.code).toBe("validation_failed");
  });

  it("validates the body before authorizing — a malformed request is not an authorization question", async () => {
    const response = await handlePutScoringProfile(
      new Request("https://x/p", { method: "PUT", body: JSON.stringify({ weights: { vibes_bad: 1 } }) }),
      denyingEnv(), "req_1", ACTOR, ORG_UUID, { repo: createFakeRepo(), now: NOW },
    );
    expect(response.status).toBe(422);
  });

  it("denies weight tuning as a 404 when policy says no", async () => {
    const response = await handlePutScoringProfile(
      new Request("https://x/p", { method: "PUT", body: JSON.stringify({ weights: { tls_missing: 40 } }) }),
      denyingEnv(), "req_1", ACTOR, ORG_UUID, { repo: createFakeRepo(), now: NOW },
    );
    expect(response.status).toBe(404);
  });
});

describe("bulk rescore", () => {
  it("reports what it did and whether more remains", async () => {
    const repo = createFakeRepo();
    await seedProspect(repo, [["tls_missing", 5]]);
    const response = await handleBulkRescore(allowingEnv(), "req_1", ACTOR, ORG_UUID, {
      repo, eventsRepo: createFakeEventsRepo(), now: NOW,
    });
    const body = (await response.json()) as { data: { rescored: number; failed: number; truncated: boolean; limit: number } };
    expect(body.data.rescored).toBe(1);
    expect(body.data.failed).toBe(0);
    expect(body.data.truncated).toBe(false);
    expect(body.data.limit).toBeGreaterThan(0);
  });
});

describe("SP2 routing", () => {
  const env = allowingEnv();

  it("matches POST /prospects/rescore as the bulk action, not as a prospect id", async () => {
    const response = await route(
      new Request(`https://x/v1/organizations/${ORG}/prospects/rescore`, { method: "POST", headers: ACTOR_HEADERS }),
      env,
    );
    // Reaches the handler (which then fails on the stub DB) rather than 405.
    expect(response.status).not.toBe(405);
  });

  it("routes the per-prospect rescore, the score history, and the profile", async () => {
    for (const [method, path] of [
      ["POST", `/v1/organizations/${ORG}/prospects/${PROSPECT}/rescore`],
      ["GET", `/v1/organizations/${ORG}/prospects/${PROSPECT}/scores`],
      ["GET", `/v1/organizations/${ORG}/scoring-profile`],
      ["PUT", `/v1/organizations/${ORG}/scoring-profile`],
    ] as const) {
      const init: RequestInit = { method, headers: ACTOR_HEADERS };
      if (method === "PUT") init.body = JSON.stringify({ weights: {} });
      const response = await route(new Request(`https://x${path}`, init), env);
      expect(response.status).not.toBe(404);
      expect(response.status).not.toBe(405);
    }
  });

  it("rejects the wrong method on the new routes", async () => {
    for (const [method, path] of [
      ["GET", `/v1/organizations/${ORG}/prospects/${PROSPECT}/rescore`],
      ["POST", `/v1/organizations/${ORG}/prospects/${PROSPECT}/scores`],
      ["DELETE", `/v1/organizations/${ORG}/scoring-profile`],
    ] as const) {
      const response = await route(new Request(`https://x${path}`, { method, headers: ACTOR_HEADERS }), env);
      expect(response.status).toBe(405);
    }
  });
});
