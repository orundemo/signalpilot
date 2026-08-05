import { route } from "@prospecting-worker/router";
import type { Env } from "@prospecting-worker/env";
import { handleCreateDiscovery } from "@prospecting-worker/handlers/create-discovery";
import type { ActorContext } from "@prospecting-worker/router";
import { asUuid } from "@saas/db/ids";
import { createFakeEventsRepo, createFakeRepo, fetcherReturning } from "./fakes.js";

const ORG_UUID = asUuid("11111111-1111-1111-1111-111111111111");
const ORG = "org_11111111111111111111111111111111";
const PROSPECT = "prs_22222222222222222222222222222222";
const DISCOVERY = "dsc_33333333333333333333333333333333";

const ACTOR_HEADERS = {
  "x-actor-subject-id": "usr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "x-actor-subject-type": "user",
};

const ACTOR: ActorContext = {
  subjectId: ACTOR_HEADERS["x-actor-subject-id"],
  subjectType: "user",
  subjectUuid: asUuid("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"),
};

interface ErrorBody {
  error: { code: string; message: string; details?: Record<string, unknown> };
}

/** Membership answers with one org-owner fact; policy answers `allow`. */
function allowingEnv(overrides?: Partial<Env>): Env {
  return {
    ENVIRONMENT: "test",
    PLATFORM_DB: {} as Hyperdrive,
    MEMBERSHIP_WORKER: fetcherReturning({
      data: { memberships: [{ kind: "role_assignment", role: "owner", scope: { kind: "organization", orgId: ORG_UUID } }] },
    }),
    POLICY_WORKER: fetcherReturning({ data: { allow: true, reason: "org_owner", policyVersion: 1, derivedScope: { orgId: ORG_UUID } } }),
    BILLING_WORKER: fetcherReturning({ data: { allowed: true, orgId: ORG, entitlementKey: "prospecting.discovery", valueType: "quantity", limitValue: null, source: "plan", subscriptionId: null } }),
    ...overrides,
  } as Env;
}

/** Same membership, but policy denies. */
function denyingEnv(): Env {
  return allowingEnv({
    POLICY_WORKER: fetcherReturning({ data: { allow: false, reason: "no_matching_role", policyVersion: 1, derivedScope: { orgId: ORG_UUID } } }),
  });
}

const ROUTES: Array<[method: string, path: string]> = [
  ["POST", `/v1/organizations/${ORG}/discoveries`],
  ["GET", `/v1/organizations/${ORG}/discoveries`],
  ["GET", `/v1/organizations/${ORG}/discoveries/${DISCOVERY}`],
  ["GET", `/v1/organizations/${ORG}/prospects`],
  ["POST", `/v1/organizations/${ORG}/prospects`],
  ["GET", `/v1/organizations/${ORG}/prospects/${PROSPECT}`],
  ["PATCH", `/v1/organizations/${ORG}/prospects/${PROSPECT}`],
  ["POST", `/v1/organizations/${ORG}/prospects/${PROSPECT}/archive`],
  ["GET", `/v1/organizations/${ORG}/prospects/${PROSPECT}/signals`],
];

function request(method: string, path: string, headers: Record<string, string> = ACTOR_HEADERS): Request {
  const init: RequestInit = { method, headers: { ...headers, "content-type": "application/json" } };
  if (method === "POST" || method === "PATCH") init.body = JSON.stringify({ name: "Test Business" });
  return new Request(`https://prospecting.internal${path}`, init);
}

describe("deny-as-404", () => {
  it.each(ROUTES)("%s %s returns 404 when policy denies", async (method, path) => {
    const response = await route(request(method, path), denyingEnv());
    expect(response.status).toBe(404);
    const body = (await response.json()) as ErrorBody;
    expect(body.error.code).toBe("not_found");
  });

  it.each(ROUTES)("%s %s returns 404 when the caller is not a member", async (method, path) => {
    // membership-worker answers non-OK for a non-member.
    const env = allowingEnv({ MEMBERSHIP_WORKER: fetcherReturning({ error: { code: "not_found" } }, 404) });
    const response = await route(request(method, path), env);
    expect(response.status).toBe(404);
  });

  it("never distinguishes 'not a member' from 'no permission'", async () => {
    const nonMember = await route(request("GET", `/v1/organizations/${ORG}/prospects`), allowingEnv({
      MEMBERSHIP_WORKER: fetcherReturning({ error: {} }, 404),
    }));
    const unpermitted = await route(request("GET", `/v1/organizations/${ORG}/prospects`), denyingEnv());
    expect(nonMember.status).toBe(unpermitted.status);
    expect(((await nonMember.json()) as ErrorBody).error.code).toBe(((await unpermitted.json()) as ErrorBody).error.code);
  });
});

describe("authentication and addressing", () => {
  it.each(ROUTES)("%s %s returns 401 without actor headers", async (method, path) => {
    const response = await route(request(method, path, {}), allowingEnv());
    expect(response.status).toBe(401);
  });

  it("returns 401 for an actor id that is not a public id", async () => {
    const response = await route(
      request("GET", `/v1/organizations/${ORG}/prospects`, { ...ACTOR_HEADERS, "x-actor-subject-id": "root" }),
      allowingEnv(),
    );
    expect(response.status).toBe(401);
  });

  it("returns 404 — not 400 — for a malformed org id", async () => {
    const response = await route(request("GET", "/v1/organizations/not-an-org/prospects"), allowingEnv());
    expect(response.status).toBe(404);
  });

  it("returns 404 for a malformed prospect id", async () => {
    const response = await route(request("GET", `/v1/organizations/${ORG}/prospects/nope/signals`), allowingEnv());
    expect(response.status).toBe(404);
  });

  it("rejects an unsupported method with 405", async () => {
    const response = await route(request("DELETE", `/v1/organizations/${ORG}/prospects/${PROSPECT}`), allowingEnv());
    expect(response.status).toBe(405);
  });

  it("returns 404 for an unknown path under the org prefix", async () => {
    const response = await route(request("GET", `/v1/organizations/${ORG}/unicorns`), allowingEnv());
    expect(response.status).toBe(404);
  });
});

describe("service degradation", () => {
  it("returns 503 rather than a wrong answer when the database is unbound", async () => {
    const env = allowingEnv();
    delete (env as { PLATFORM_DB?: Hyperdrive }).PLATFORM_DB;
    const response = await route(request("GET", `/v1/organizations/${ORG}/prospects`), env);
    expect(response.status).toBe(503);
  });

  it("fails closed with 503 when billing is unreachable on a discovery run", async () => {
    const env = allowingEnv({
      BILLING_WORKER: {
        fetch() { return Promise.reject(new Error("billing down")); },
        connect() { throw new Error("not implemented"); },
      } as unknown as Fetcher,
    });
    const response = await route(request("POST", `/v1/organizations/${ORG}/discoveries`), env);
    expect(response.status).toBe(503);
  });
});

describe("POST /discoveries — quota contract", () => {
  const NOW = new Date("2026-06-15T12:00:00.000Z");

  async function postDiscovery(env: Env, repo = createFakeRepo(), body: unknown = {}) {
    const req = new Request(`https://prospecting.internal/v1/organizations/${ORG}/discoveries`, {
      method: "POST",
      headers: { ...ACTOR_HEADERS, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const scheduled: Promise<unknown>[] = [];
    const response = await handleCreateDiscovery(req, env, "req_1", ACTOR, ORG_UUID, undefined, {
      repo,
      eventsRepo: createFakeEventsRepo(),
      waitUntil: (p) => scheduled.push(p),
      now: NOW,
    });
    await Promise.all(scheduled);
    return { response, repo };
  }

  it("returns 202 with the run id and completes in the background", async () => {
    const { response, repo } = await postDiscovery(allowingEnv(), createFakeRepo(), { limit: 3 });
    expect(response.status).toBe(202);
    const body = (await response.json()) as { data: { discovery: { id: string; status: string } } };
    expect(body.data.discovery.id).toMatch(/^dsc_[0-9a-f]{32}$/);
    expect(body.data.discovery.status).toBe("running");
    // The background pass has run by now: the stored run is terminal.
    const stored = [...repo.runs.values()][0]!;
    expect(stored.status).toBe("completed");
    expect(stored.prospectsCreated).toBeGreaterThan(0);
  });

  it("returns a typed 402 carrying meter, limit, and reset date when the allowance is spent", async () => {
    const repo = createFakeRepo();
    // Seed 100 prospects inside the current billing period.
    for (let i = 0; i < 100; i++) {
      await repo.upsertProspect({
        id: crypto.randomUUID(), orgId: ORG_UUID, name: `Biz ${i}`, domain: null,
        dedupeKey: `n:biz-${i}||`, industry: null, locality: null, region: null, country: null,
        sizeBand: "unknown", source: "synthetic", sourceRef: null, observedAt: NOW,
      });
    }
    const env = allowingEnv({
      BILLING_WORKER: fetcherReturning({
        data: { allowed: true, orgId: ORG, entitlementKey: "prospecting.discovery", valueType: "quantity", limitValue: 100, source: "plan", subscriptionId: null },
      }),
    });

    const { response } = await postDiscovery(env, repo);
    expect(response.status).toBe(402);
    const body = (await response.json()) as ErrorBody;
    expect(body.error.code).toBe("quota_exhausted");
    expect(body.error.details!.meter).toBe("prospecting.prospects.discovered");
    expect(body.error.details!.entitlement).toBe("prospecting.discovery");
    expect(body.error.details!.limit).toBe(100);
    expect(body.error.details!.used).toBe(100);
    // Reset is the start of the next calendar month, UTC.
    expect(body.error.details!.resetAt).toBe("2026-07-01T00:00:00.000Z");
  });

  it("does not create a run row when the tenant is over quota", async () => {
    const repo = createFakeRepo();
    await repo.upsertProspect({
      id: crypto.randomUUID(), orgId: ORG_UUID, name: "Only", domain: null, dedupeKey: "n:only||",
      industry: null, locality: null, region: null, country: null, sizeBand: "unknown",
      source: "synthetic", sourceRef: null, observedAt: NOW,
    });
    const env = allowingEnv({
      BILLING_WORKER: fetcherReturning({
        data: { allowed: true, orgId: ORG, entitlementKey: "prospecting.discovery", valueType: "quantity", limitValue: 1, source: "plan", subscriptionId: null },
      }),
    });

    const { response } = await postDiscovery(env, repo);
    expect(response.status).toBe(402);
    expect(repo.runs.size).toBe(0);
  });

  it("denies when the plan does not include discovery at all", async () => {
    const env = allowingEnv({
      BILLING_WORKER: fetcherReturning({
        data: { allowed: false, orgId: ORG, entitlementKey: "prospecting.discovery", reason: "not_configured" },
      }),
    });
    const { response } = await postDiscovery(env);
    expect(response.status).toBe(402);
  });

  it("allows an unlimited plan", async () => {
    const { response } = await postDiscovery(allowingEnv(), createFakeRepo(), { limit: 2 });
    expect(response.status).toBe(202);
  });

  it("rejects a web-signals run with no domains instead of silently finding nothing", async () => {
    const { response } = await postDiscovery(allowingEnv(), createFakeRepo(), { adapter: "web-signals" });
    expect(response.status).toBe(422);
    const body = (await response.json()) as ErrorBody;
    expect((body.error.details!.fields as Record<string, string[]>).domains).toBeDefined();
  });

  it("rejects an unknown adapter and an out-of-range limit", async () => {
    expect((await postDiscovery(allowingEnv(), createFakeRepo(), { adapter: "scrape-all" })).response.status).toBe(422);
    expect((await postDiscovery(allowingEnv(), createFakeRepo(), { limit: 5000 })).response.status).toBe(422);
    expect((await postDiscovery(allowingEnv(), createFakeRepo(), { limit: 0 })).response.status).toBe(422);
  });

  it("checks the entitlement before doing any work", async () => {
    const billing = fetcherReturning({
      data: { allowed: false, orgId: ORG, entitlementKey: "prospecting.discovery", reason: "disabled" },
    });
    const repo = createFakeRepo();
    await postDiscovery(allowingEnv({ BILLING_WORKER: billing }), repo);
    expect(billing.calls).toHaveLength(1);
    expect(repo.prospects.size).toBe(0);
    expect(repo.signals).toHaveLength(0);
  });
});
