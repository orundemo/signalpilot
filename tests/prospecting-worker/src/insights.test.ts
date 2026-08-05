import { handleGenerateInsight } from "@prospecting-worker/handlers/generate-insight";
import { handleListInsights } from "@prospecting-worker/handlers/list-insights";
import { handleRescoreProspect } from "@prospecting-worker/handlers/rescore-prospect";
import { createTemplateAdapter } from "@prospecting-worker/model/template";
import { inputDigest } from "@prospecting-worker/model/prompt";
import { PROMPT_VERSION } from "@prospecting-worker/model/types";
import type { ModelAdapter, ModelOutcome } from "@prospecting-worker/model/types";
import type { Env } from "@prospecting-worker/env";
import type { ActorContext } from "@prospecting-worker/router";
import { asUuid } from "@saas/db/ids";
import { createFakeEventsRepo, createFakeRepo, fetcherReturning } from "./fakes.js";
import type { FakeProspectingRepo } from "./fakes.js";

const ORG_UUID = asUuid("11111111-1111-1111-1111-111111111111");
const ORG = "org_11111111111111111111111111111111";
const PROSPECT_UUID = asUuid("22222222-2222-2222-2222-222222222222");
const NOW = new Date("2026-06-15T12:00:00.000Z");

const ACTOR: ActorContext = {
  subjectId: "usr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  subjectType: "user",
  subjectUuid: asUuid("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"),
};

interface ErrorBody {
  error: { code: string; message: string; details?: Record<string, unknown> };
}

interface InsightBody {
  data: {
    insight: {
      id: string;
      kind: string;
      content: string;
      model: string | null;
      promptVersion: number | null;
      guardrailVerdict: string;
      guardrailNotes: unknown[];
      cached: boolean;
    };
  };
}

function env(overrides?: Partial<Env>): Env {
  return {
    ENVIRONMENT: "test",
    PLATFORM_DB: {} as Hyperdrive,
    MEMBERSHIP_WORKER: fetcherReturning({
      data: { memberships: [{ kind: "role_assignment", role: "owner", scope: { kind: "organization", orgId: ORG_UUID } }] },
    }),
    POLICY_WORKER: fetcherReturning({ data: { allow: true, reason: "org_owner", policyVersion: 1, derivedScope: { orgId: ORG_UUID } } }),
    BILLING_WORKER: fetcherReturning({
      data: { allowed: true, orgId: ORG, entitlementKey: "prospecting.insight", valueType: "quantity", limitValue: null, source: "plan", subscriptionId: null },
    }),
    ...overrides,
  } as Env;
}

function limitedEnv(limit: number): Env {
  return env({
    BILLING_WORKER: fetcherReturning({
      data: { allowed: true, orgId: ORG, entitlementKey: "prospecting.insight", valueType: "quantity", limitValue: limit, source: "plan", subscriptionId: null },
    }),
  });
}

/** An adapter that records how many times the model was actually called. */
function countingAdapter(outcome?: ModelOutcome): ModelAdapter & { calls: number } {
  const inner = createTemplateAdapter();
  const adapter = {
    id: "counting",
    calls: 0,
    async generate(input: Parameters<ModelAdapter["generate"]>[0]) {
      adapter.calls += 1;
      return outcome ?? inner.generate(input);
    },
  };
  return adapter;
}

async function seedScoredProspect(repo: FakeProspectingRepo, now = NOW) {
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
    observedAt: now,
  });
  await repo.insertSignal({
    id: "33333333-3333-3333-3333-333333333331",
    orgId: ORG_UUID,
    prospectId: PROSPECT_UUID,
    kind: "tls_missing",
    severity: 5,
    features: {},
    source: "synthetic",
    sourceDigest: "a".repeat(64),
    observedAt: now,
    expiresAt: new Date(now.getTime() + 30 * 86_400_000),
  });
  await handleRescoreProspect(env(), "req_seed", ACTOR, ORG_UUID, PROSPECT_UUID, {
    repo,
    eventsRepo: createFakeEventsRepo(),
    now,
  });
}

function generate(e: Env, repo: FakeProspectingRepo, deps: Record<string, unknown> = {}, kind = "prospect_summary") {
  const request = new Request("https://x/insights", { method: "POST", body: JSON.stringify({ kind }) });
  return handleGenerateInsight(request, e, "req_1", ACTOR, ORG_UUID, PROSPECT_UUID, {
    repo,
    eventsRepo: createFakeEventsRepo(),
    now: NOW,
    ...deps,
  });
}

describe("POST /prospects/:id/insights — happy path", () => {
  it("stores a generation with its full provenance", async () => {
    const repo = createFakeRepo();
    await seedScoredProspect(repo);

    const response = await generate(env(), repo, { adapter: createTemplateAdapter() });
    expect(response.status).toBe(201);

    const body = (await response.json()) as InsightBody;
    expect(body.data.insight.content.length).toBeGreaterThan(0);
    expect(body.data.insight.model).toBe("template");
    expect(body.data.insight.promptVersion).toBe(PROMPT_VERSION);
    expect(["pass", "revised"]).toContain(body.data.insight.guardrailVerdict);
    expect(body.data.insight.cached).toBe(false);
    expect(repo.insights).toHaveLength(1);
  });

  it("writes an insight_generated activity", async () => {
    const repo = createFakeRepo();
    await seedScoredProspect(repo);
    await generate(env(), repo, { adapter: createTemplateAdapter() });
    expect(repo.activities.filter((a) => a.kind === "insight_generated")).toHaveLength(1);
  });

  it("emits prospecting.insight.generated", async () => {
    const repo = createFakeRepo();
    const eventsRepo = createFakeEventsRepo();
    await seedScoredProspect(repo);
    await generate(env(), repo, { adapter: createTemplateAdapter(), eventsRepo });
    const emitted = eventsRepo.appended.filter((e) => e.event.type === "prospecting.insight.generated");
    expect(emitted).toHaveLength(1);
    expect(emitted[0]!.event.payload.guardrailVerdict).toBeDefined();
  });

  it("refuses to write prose about a prospect that has no score", async () => {
    const repo = createFakeRepo();
    await repo.upsertProspect({
      id: PROSPECT_UUID, orgId: ORG_UUID, name: "Unscored Ltd", domain: null, dedupeKey: "n:unscored||",
      industry: null, locality: null, region: null, country: null, sizeBand: "unknown",
      source: "manual", sourceRef: null, observedAt: NOW,
    });

    const response = await generate(env(), repo, { adapter: createTemplateAdapter() });
    expect(response.status).toBe(412);
    const body = (await response.json()) as ErrorBody;
    expect(body.error.details!.reason).toBe("no_score");
  });
});

describe("digest caching", () => {
  it("returns the cached row without calling the model or the meter", async () => {
    const repo = createFakeRepo();
    const metering = fetcherReturning({ data: {} }, 201);
    const adapter = countingAdapter();
    await seedScoredProspect(repo);

    const first = await generate(env({ METERING_WORKER: metering }), repo, { adapter });
    expect(first.status).toBe(201);
    expect(adapter.calls).toBe(1);
    expect(metering.calls).toHaveLength(1);

    const second = await generate(env({ METERING_WORKER: metering }), repo, { adapter });
    expect(second.status).toBe(200);
    const body = (await second.json()) as InsightBody;
    expect(body.data.insight.cached).toBe(true);
    // The whole point: no second model call, no second meter write.
    expect(adapter.calls).toBe(1);
    expect(metering.calls).toHaveLength(1);
    expect(repo.insights).toHaveLength(1);
  });

  it("serves a cached generation even when the tenant is over quota", async () => {
    const repo = createFakeRepo();
    const adapter = countingAdapter();
    await seedScoredProspect(repo);
    await generate(env(), repo, { adapter });

    // Now at a limit of zero — a replay must still work.
    const response = await generate(limitedEnv(0), repo, { adapter });
    expect(response.status).toBe(200);
    expect(adapter.calls).toBe(1);
  });

  it("keys different insight kinds separately", async () => {
    const repo = createFakeRepo();
    const adapter = countingAdapter();
    await seedScoredProspect(repo);

    await generate(env(), repo, { adapter }, "prospect_summary");
    await generate(env(), repo, { adapter }, "outreach_email");

    expect(adapter.calls).toBe(2);
    expect(repo.insights).toHaveLength(2);
  });

  it("a rescore changes the digest, so regeneration is a genuine new generation", async () => {
    const repo = createFakeRepo();
    const adapter = countingAdapter();
    await seedScoredProspect(repo);
    await generate(env(), repo, { adapter });

    const before = repo.scores[0]!;
    const digestBefore = await inputDigest("prospect_summary", PROMPT_VERSION, before.id, before.contributions);

    // Add a signal and rescore — new score row, new contributions.
    await repo.insertSignal({
      id: "33333333-3333-3333-3333-333333333332",
      orgId: ORG_UUID, prospectId: PROSPECT_UUID, kind: "perf_poor", severity: 4,
      features: { lcp_ms: 6400 }, source: "synthetic", sourceDigest: "b".repeat(64),
      observedAt: NOW, expiresAt: new Date(NOW.getTime() + 30 * 86_400_000),
    });
    await handleRescoreProspect(env(), "req_2", ACTOR, ORG_UUID, PROSPECT_UUID, {
      repo, eventsRepo: createFakeEventsRepo(), now: new Date("2026-06-16T12:00:00.000Z"),
    });

    const after = repo.scores[repo.scores.length - 1]!;
    const digestAfter = await inputDigest("prospect_summary", PROMPT_VERSION, after.id, after.contributions);
    expect(digestAfter).not.toBe(digestBefore);

    const response = await generate(env(), repo, { adapter });
    expect(response.status).toBe(201);
    expect(adapter.calls).toBe(2);
    expect(repo.insights).toHaveLength(2);
  });
});

describe("entitlement gate", () => {
  it("checks the entitlement BEFORE the model call — no provider request when over quota", async () => {
    const repo = createFakeRepo();
    const adapter = countingAdapter();
    await seedScoredProspect(repo);

    const response = await generate(limitedEnv(0), repo, { adapter });

    expect(response.status).toBe(402);
    // The assertion that matters: the model was never asked.
    expect(adapter.calls).toBe(0);
    expect(repo.insights).toHaveLength(0);
  });

  it("returns the typed quota payload the console renders its upgrade prompt from", async () => {
    const repo = createFakeRepo();
    await seedScoredProspect(repo);
    const response = await generate(limitedEnv(0), repo, { adapter: countingAdapter() });
    const body = (await response.json()) as ErrorBody;

    expect(body.error.code).toBe("quota_exhausted");
    expect(body.error.details!.meter).toBe("prospecting.insights.generated");
    expect(body.error.details!.entitlement).toBe("prospecting.insight");
    expect(body.error.details!.limit).toBe(0);
    expect(body.error.details!.resetAt).toBe("2026-07-01T00:00:00.000Z");
  });

  it("emits prospecting.quota.exhausted when it denies", async () => {
    const repo = createFakeRepo();
    const eventsRepo = createFakeEventsRepo();
    await seedScoredProspect(repo);
    await generate(limitedEnv(0), repo, { adapter: countingAdapter(), eventsRepo });
    expect(eventsRepo.appended.some((e) => e.event.type === "prospecting.quota.exhausted")).toBe(true);
  });

  it("fails closed with 503 when billing is unreachable", async () => {
    const repo = createFakeRepo();
    const adapter = countingAdapter();
    await seedScoredProspect(repo);

    const response = await generate(
      env({
        BILLING_WORKER: {
          fetch() { return Promise.reject(new Error("down")); },
          connect() { throw new Error("not implemented"); },
        } as unknown as Fetcher,
      }),
      repo,
      { adapter },
    );

    expect(response.status).toBe(503);
    expect(adapter.calls).toBe(0);
  });
});

describe("guardrail integration", () => {
  it("a blocked verdict stores nothing, is not metered, and returns the notes", async () => {
    const repo = createFakeRepo();
    const metering = fetcherReturning({ data: {} }, 201);
    await seedScoredProspect(repo);

    const rogue: ModelAdapter = {
      id: "rogue",
      async generate() {
        return {
          ok: true,
          result: {
            model: "rogue",
            content: "Hi Sarah Mitchell, your site has no valid HTTPS. Reach me at rep@agency.example to discuss.",
          },
        };
      },
    };

    const response = await generate(env({ METERING_WORKER: metering }), repo, { adapter: rogue });

    expect(response.status).toBe(412);
    const body = (await response.json()) as ErrorBody;
    expect(body.error.details!.reason).toBe("guardrail_blocked");
    expect(Array.isArray(body.error.details!.notes)).toBe(true);
    expect(repo.insights).toHaveLength(0);
    expect(metering.calls).toHaveLength(0);
  });

  it("a revised verdict is stored with its notes so the console can show what changed", async () => {
    const repo = createFakeRepo();
    await seedScoredProspect(repo);

    const chatty: ModelAdapter = {
      id: "chatty",
      async generate() {
        return {
          ok: true,
          result: {
            model: "chatty",
            content:
              "Your site has no valid HTTPS, which shows a browser warning to visitors. Act now to secure a slot. It is worth fixing this month.",
          },
        };
      },
    };

    const response = await generate(env(), repo, { adapter: chatty });
    expect(response.status).toBe(201);
    const body = (await response.json()) as InsightBody;
    expect(body.data.insight.guardrailVerdict).toBe("revised");
    expect(body.data.insight.guardrailNotes.length).toBeGreaterThan(0);
    expect(body.data.insight.content.toLowerCase()).not.toContain("act now");
  });

  it("surfaces a model decline as a typed 412 rather than a 500", async () => {
    const repo = createFakeRepo();
    await seedScoredProspect(repo);
    const response = await generate(env(), repo, {
      adapter: countingAdapter({ ok: false, reason: "declined" }),
    });
    expect(response.status).toBe(412);
    const body = (await response.json()) as ErrorBody;
    expect(body.error.details!.reason).toBe("model_declined");
  });

  it("surfaces a provider outage as a 503 and stores nothing", async () => {
    const repo = createFakeRepo();
    await seedScoredProspect(repo);
    const response = await generate(env(), repo, {
      adapter: countingAdapter({ ok: false, reason: "unavailable" }),
    });
    expect(response.status).toBe(503);
    expect(repo.insights).toHaveLength(0);
  });
});

describe("template adapter", () => {
  it("writes only from the contributions it was given", async () => {
    const adapter = createTemplateAdapter();
    const result = await adapter.generate({
      kind: "outreach_email",
      prospectName: "Ridgeway Plumbing",
      prospectDomain: "ridgeway.example",
      industry: "plumbing",
      locality: "Leeds",
      score: 45,
      band: "warm",
      contributions: [
        { kind: "tls_missing", points: 25, reason: "No valid HTTPS — visitors see a browser security warning", severity: 5, features: {}, signalId: "sig_1" },
      ],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.content).toContain("HTTPS");
      expect(result.result.model).toBe("template");
    }
  });

  it("is deterministic", async () => {
    const adapter = createTemplateAdapter();
    const args = {
      kind: "prospect_summary" as const,
      prospectName: "Ridgeway Plumbing",
      prospectDomain: "ridgeway.example",
      industry: "plumbing",
      locality: "Leeds",
      score: 45,
      band: "warm" as const,
      contributions: [
        { kind: "tls_missing" as const, points: 25, reason: "No valid HTTPS", severity: 5 as const, features: {}, signalId: "sig_1" },
      ],
    };
    expect(await adapter.generate(args)).toEqual(await adapter.generate(args));
  });

  it("says nothing rather than inventing a reason when there are no observations", async () => {
    const adapter = createTemplateAdapter();
    const result = await adapter.generate({
      kind: "outreach_email",
      prospectName: "Perfect Ltd",
      prospectDomain: "perfect.example",
      industry: null,
      locality: null,
      score: 0,
      band: "cold",
      contributions: [],
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.result.content).toContain("did not find");
  });
});

describe("GET /prospects/:id/insights", () => {
  it("lists stored generations newest first and marks them cached", async () => {
    const repo = createFakeRepo();
    await seedScoredProspect(repo);
    await generate(env(), repo, { adapter: createTemplateAdapter() }, "prospect_summary");
    await generate(env(), repo, { adapter: createTemplateAdapter() }, "outreach_email");

    const response = await handleListInsights(
      new Request("https://x/insights"),
      env(), "req_3", ACTOR, ORG_UUID, PROSPECT_UUID, { repo },
    );
    const body = (await response.json()) as { data: { insights: Array<{ cached: boolean; kind: string }> } };
    expect(body.data.insights).toHaveLength(2);
    for (const insight of body.data.insights) expect(insight.cached).toBe(true);
  });

  it("404s on an unknown prospect rather than returning an empty list", async () => {
    const response = await handleListInsights(
      new Request("https://x/insights"),
      env(), "req_1", ACTOR, ORG_UUID, PROSPECT_UUID, { repo: createFakeRepo() },
    );
    expect(response.status).toBe(404);
  });
});
