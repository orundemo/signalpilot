import {
  handleCreateEntry,
  handleGetPipeline,
  handleListStages,
  handlePutStages,
  handleUpdateEntry,
} from "@prospecting-worker/handlers/pipeline";
import { handleCreateActivity, handleListActivities } from "@prospecting-worker/handlers/activities";
import { route } from "@prospecting-worker/router";
import type { Env } from "@prospecting-worker/env";
import type { ActorContext } from "@prospecting-worker/router";
import { asUuid } from "@saas/db/ids";
import { DEFAULT_PIPELINE_STAGES } from "@saas/contracts/prospecting";
import { createFakeEventsRepo, createFakeRepo, fetcherReturning } from "./fakes.js";
import type { FakeEventsRepo, FakeProspectingRepo } from "./fakes.js";

const ORG_UUID = asUuid("11111111-1111-1111-1111-111111111111");
const ORG = "org_11111111111111111111111111111111";
const PROSPECT_UUID = asUuid("22222222-2222-2222-2222-222222222222");
const PROSPECT = "prs_22222222222222222222222222222222";
const OWNER = "usr_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const NOW = new Date("2026-06-15T12:00:00.000Z");

const ACTOR: ActorContext = {
  subjectId: "usr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  subjectType: "user",
  subjectUuid: asUuid("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"),
};

const ACTOR_HEADERS = { "x-actor-subject-id": ACTOR.subjectId, "x-actor-subject-type": "user" };

interface ErrorBody {
  error: { code: string; details?: Record<string, unknown> };
}

function env(overrides?: Partial<Env>): Env {
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
  return env({
    POLICY_WORKER: fetcherReturning({ data: { allow: false, reason: "no_matching_role", policyVersion: 1, derivedScope: { orgId: ORG_UUID } } }),
  });
}

async function seedProspect(repo: FakeProspectingRepo, id = PROSPECT_UUID, name = "Ridgeway Plumbing") {
  await repo.upsertProspect({
    id, orgId: ORG_UUID, name, domain: `${name.toLowerCase().replace(/\W+/g, "-")}.example`,
    dedupeKey: `d:${name.toLowerCase().replace(/\W+/g, "-")}.example`,
    industry: "plumbing", locality: "Leeds", region: "England", country: "GB",
    sizeBand: "micro", source: "synthetic", sourceRef: "syn-1", observedAt: NOW,
  });
}

function deps(repo: FakeProspectingRepo, eventsRepo: FakeEventsRepo = createFakeEventsRepo(), now = NOW) {
  return { repo, eventsRepo, now };
}

function createEntry(repo: FakeProspectingRepo, body: unknown, eventsRepo = createFakeEventsRepo(), now = NOW) {
  return handleCreateEntry(
    new Request("https://x/entries", { method: "POST", body: JSON.stringify(body) }),
    env(), "req_1", ACTOR, ORG_UUID, deps(repo, eventsRepo, now),
  );
}

describe("stage seeding", () => {
  it("seeds the default stages on first read", async () => {
    const repo = createFakeRepo();
    const response = await handleListStages(env(), "req_1", ACTOR, ORG_UUID, deps(repo));
    const body = (await response.json()) as { data: { stages: Array<{ key: string; position: number; outcome: string }> } };

    expect(body.data.stages.map((s) => s.key)).toEqual(DEFAULT_PIPELINE_STAGES.map((s) => s.key));
    expect(body.data.stages.find((s) => s.key === "won")!.outcome).toBe("won");
    expect(body.data.stages.find((s) => s.key === "lost")!.outcome).toBe("lost");
  });

  it("is idempotent — a second read does not duplicate the stage set", async () => {
    const repo = createFakeRepo();
    await handleListStages(env(), "req_1", ACTOR, ORG_UUID, deps(repo));
    await handleListStages(env(), "req_2", ACTOR, ORG_UUID, deps(repo));
    expect(repo.stages.size).toBe(DEFAULT_PIPELINE_STAGES.length);
  });
});

describe("pipeline entries — the open-entry constraint", () => {
  it("adds a prospect to the board at the first stage by default", async () => {
    const repo = createFakeRepo();
    await seedProspect(repo);

    const response = await createEntry(repo, { prospectId: PROSPECT });
    expect(response.status).toBe(201);
    const body = (await response.json()) as { data: { entry: { stageKey: string; closedAt: string | null; id: string } } };
    expect(body.data.entry.stageKey).toBe("new");
    expect(body.data.entry.closedAt).toBeNull();
    expect(body.data.entry.id).toMatch(/^pen_[0-9a-f]{32}$/);
  });

  it("rejects a second open entry for the same prospect", async () => {
    const repo = createFakeRepo();
    await seedProspect(repo);
    await createEntry(repo, { prospectId: PROSPECT });

    const second = await createEntry(repo, { prospectId: PROSPECT });
    expect(second.status).toBe(409);
    const body = (await second.json()) as ErrorBody;
    expect(body.error.code).toBe("conflict");
  });

  it("lets a closed prospect be re-entered", async () => {
    const repo = createFakeRepo();
    await seedProspect(repo);
    const created = await createEntry(repo, { prospectId: PROSPECT });
    const entryId = ((await created.json()) as { data: { entry: { id: string } } }).data.entry.id;

    // Close it by moving to a terminal stage.
    await handleUpdateEntry(
      new Request("https://x/e", { method: "PATCH", body: JSON.stringify({ stageKey: "lost" }) }),
      env(), "req_2", ACTOR, ORG_UUID, asUuid(entryUuid(entryId)), deps(repo),
    );

    const reentered = await createEntry(repo, { prospectId: PROSPECT });
    expect(reentered.status).toBe(201);
    expect(repo.entries.size).toBe(2);
  });

  it("404s for a prospect that does not exist", async () => {
    const response = await createEntry(createFakeRepo(), { prospectId: PROSPECT });
    expect(response.status).toBe(404);
  });

  it("rejects a malformed prospect id and an unknown stage", async () => {
    const repo = createFakeRepo();
    await seedProspect(repo);
    expect((await createEntry(repo, { prospectId: "nope" })).status).toBe(422);
    expect((await createEntry(repo, { prospectId: PROSPECT, stageKey: "nirvana" })).status).toBe(422);
  });
});

function entryUuid(publicId: string): string {
  const hex = publicId.slice(4);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

describe("moving through the pipeline", () => {
  async function seedEntry(repo: FakeProspectingRepo, eventsRepo = createFakeEventsRepo()) {
    await seedProspect(repo);
    const created = await createEntry(repo, { prospectId: PROSPECT }, eventsRepo);
    const id = ((await created.json()) as { data: { entry: { id: string } } }).data.entry.id;
    return asUuid(entryUuid(id));
  }

  it("resets the stage clock on every move", async () => {
    const repo = createFakeRepo();
    const entryId = await seedEntry(repo);
    const later = new Date("2026-06-20T12:00:00.000Z");

    const response = await handleUpdateEntry(
      new Request("https://x/e", { method: "PATCH", body: JSON.stringify({ stageKey: "contacted" }) }),
      env(), "req_2", ACTOR, ORG_UUID, entryId, deps(repo, createFakeEventsRepo(), later),
    );
    const body = (await response.json()) as { data: { entry: { enteredStageAt: string; stageKey: string } } };
    expect(body.data.entry.stageKey).toBe("contacted");
    expect(body.data.entry.enteredStageAt).toBe(later.toISOString());
  });

  it("does not reset the clock when the stage did not change", async () => {
    const repo = createFakeRepo();
    const entryId = await seedEntry(repo);
    const later = new Date("2026-06-20T12:00:00.000Z");

    const response = await handleUpdateEntry(
      new Request("https://x/e", { method: "PATCH", body: JSON.stringify({ valueCents: 250_000 }) }),
      env(), "req_2", ACTOR, ORG_UUID, entryId, deps(repo, createFakeEventsRepo(), later),
    );
    const body = (await response.json()) as { data: { entry: { enteredStageAt: string; valueCents: number } } };
    expect(body.data.entry.enteredStageAt).toBe(NOW.toISOString());
    expect(body.data.entry.valueCents).toBe(250_000);
  });

  it("closes the entry on a terminal stage", async () => {
    const repo = createFakeRepo();
    const entryId = await seedEntry(repo);

    const response = await handleUpdateEntry(
      new Request("https://x/e", { method: "PATCH", body: JSON.stringify({ stageKey: "won" }) }),
      env(), "req_2", ACTOR, ORG_UUID, entryId, deps(repo),
    );
    const body = (await response.json()) as { data: { entry: { closedAt: string | null } } };
    expect(body.data.entry.closedAt).toBe(NOW.toISOString());
  });

  it("emits stage_changed with both the from and the to stage", async () => {
    const repo = createFakeRepo();
    const eventsRepo = createFakeEventsRepo();
    const entryId = await seedEntry(repo, eventsRepo);

    await handleUpdateEntry(
      new Request("https://x/e", { method: "PATCH", body: JSON.stringify({ stageKey: "meeting" }) }),
      env(), "req_2", ACTOR, ORG_UUID, entryId, deps(repo, eventsRepo),
    );

    const moves = eventsRepo.appended.filter((e) => e.event.type === "prospecting.pipeline.stage_changed");
    expect(moves).toHaveLength(2);
    expect(moves[0]!.event.payload.fromStage).toBeNull();
    expect(moves[1]!.event.payload.fromStage).toBe("new");
    expect(moves[1]!.event.payload.toStage).toBe("meeting");
  });

  it("records an owner change on the timeline", async () => {
    const repo = createFakeRepo();
    const entryId = await seedEntry(repo);

    await handleUpdateEntry(
      new Request("https://x/e", { method: "PATCH", body: JSON.stringify({ ownerUserId: OWNER }) }),
      env(), "req_2", ACTOR, ORG_UUID, entryId, deps(repo),
    );

    const owners = repo.activities.filter((a) => a.kind === "owner_change");
    expect(owners).toHaveLength(1);
    expect(owners[0]!.metadata.to).toBeTruthy();
  });

  it("accepts unassigning an owner", async () => {
    const repo = createFakeRepo();
    const entryId = await seedEntry(repo);
    await handleUpdateEntry(
      new Request("https://x/e", { method: "PATCH", body: JSON.stringify({ ownerUserId: OWNER }) }),
      env(), "req_2", ACTOR, ORG_UUID, entryId, deps(repo),
    );
    const response = await handleUpdateEntry(
      new Request("https://x/e", { method: "PATCH", body: JSON.stringify({ ownerUserId: null }) }),
      env(), "req_3", ACTOR, ORG_UUID, entryId, deps(repo),
    );
    const body = (await response.json()) as { data: { entry: { ownerUserId: string | null } } };
    expect(body.data.entry.ownerUserId).toBeNull();
  });

  it("404s on an unknown entry and on a denied caller", async () => {
    const repo = createFakeRepo();
    const entryId = await seedEntry(repo);
    const unknown = asUuid("99999999-9999-9999-9999-999999999999");

    expect(
      (await handleUpdateEntry(
        new Request("https://x/e", { method: "PATCH", body: JSON.stringify({ stageKey: "won" }) }),
        env(), "req_2", ACTOR, ORG_UUID, unknown, deps(repo),
      )).status,
    ).toBe(404);

    expect(
      (await handleUpdateEntry(
        new Request("https://x/e", { method: "PATCH", body: JSON.stringify({ stageKey: "won" }) }),
        denyingEnv(), "req_3", ACTOR, ORG_UUID, entryId, deps(repo),
      )).status,
    ).toBe(404);
  });
});

describe("GET /pipeline — the board", () => {
  it("returns stages and open entries with a stuck-in-stage day count", async () => {
    const repo = createFakeRepo();
    await seedProspect(repo);
    await createEntry(repo, { prospectId: PROSPECT });

    const eleven = new Date("2026-06-26T12:00:00.000Z");
    const response = await handleGetPipeline(env(), "req_2", ACTOR, ORG_UUID, deps(repo, createFakeEventsRepo(), eleven));
    const body = (await response.json()) as {
      data: { stages: unknown[]; entries: Array<{ daysInStage: number; prospectName: string; stageKey: string }> };
    };

    expect(body.data.stages).toHaveLength(DEFAULT_PIPELINE_STAGES.length);
    expect(body.data.entries).toHaveLength(1);
    expect(body.data.entries[0]!.daysInStage).toBe(11);
    expect(body.data.entries[0]!.prospectName).toBe("Ridgeway Plumbing");
    expect(body.data.entries[0]!.stageKey).toBe("new");
  });

  it("drops closed entries off the board", async () => {
    const repo = createFakeRepo();
    await seedProspect(repo);
    const created = await createEntry(repo, { prospectId: PROSPECT });
    const entryId = asUuid(entryUuid(((await created.json()) as { data: { entry: { id: string } } }).data.entry.id));

    await handleUpdateEntry(
      new Request("https://x/e", { method: "PATCH", body: JSON.stringify({ stageKey: "won" }) }),
      env(), "req_2", ACTOR, ORG_UUID, entryId, deps(repo),
    );

    const response = await handleGetPipeline(env(), "req_3", ACTOR, ORG_UUID, deps(repo));
    const body = (await response.json()) as { data: { entries: unknown[] } };
    expect(body.data.entries).toHaveLength(0);
  });
});

describe("PUT /pipeline/stages", () => {
  it("replaces the stage set", async () => {
    const repo = createFakeRepo();
    const response = await handlePutStages(
      new Request("https://x/s", {
        method: "PUT",
        body: JSON.stringify({
          stages: [
            { key: "new", label: "Inbox", position: 1, outcome: "open" },
            { key: "pitched", label: "Pitched", position: 2, outcome: "open" },
            { key: "won", label: "Signed", position: 3, outcome: "won" },
          ],
        }),
      }),
      env(), "req_1", ACTOR, ORG_UUID, deps(repo),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { data: { stages: Array<{ key: string; label: string }> } };
    expect(body.data.stages.map((s) => s.key)).toEqual(["new", "pitched", "won"]);
    expect(body.data.stages[0]!.label).toBe("Inbox");
  });

  it("rejects a board with no open stage — there would be nowhere to add a prospect", async () => {
    const response = await handlePutStages(
      new Request("https://x/s", {
        method: "PUT",
        body: JSON.stringify({ stages: [{ key: "won", label: "Won", position: 1, outcome: "won" }] }),
      }),
      env(), "req_1", ACTOR, ORG_UUID, deps(createFakeRepo()),
    );
    expect(response.status).toBe(422);
  });

  it("rejects duplicate keys and duplicate positions", async () => {
    const dupKey = await handlePutStages(
      new Request("https://x/s", {
        method: "PUT",
        body: JSON.stringify({
          stages: [
            { key: "new", label: "A", position: 1, outcome: "open" },
            { key: "new", label: "B", position: 2, outcome: "open" },
          ],
        }),
      }),
      env(), "req_1", ACTOR, ORG_UUID, deps(createFakeRepo()),
    );
    expect(dupKey.status).toBe(422);

    const dupPosition = await handlePutStages(
      new Request("https://x/s", {
        method: "PUT",
        body: JSON.stringify({
          stages: [
            { key: "a", label: "A", position: 1, outcome: "open" },
            { key: "b", label: "B", position: 1, outcome: "open" },
          ],
        }),
      }),
      env(), "req_2", ACTOR, ORG_UUID, deps(createFakeRepo()),
    );
    expect(dupPosition.status).toBe(422);
  });

  it("keeps a stage that still has an entry on it rather than orphaning the card", async () => {
    const repo = createFakeRepo();
    await seedProspect(repo);
    await createEntry(repo, { prospectId: PROSPECT });

    await handlePutStages(
      new Request("https://x/s", {
        method: "PUT",
        body: JSON.stringify({ stages: [{ key: "pitched", label: "Pitched", position: 1, outcome: "open" }] }),
      }),
      env(), "req_2", ACTOR, ORG_UUID, deps(repo),
    );

    const board = await handleGetPipeline(env(), "req_3", ACTOR, ORG_UUID, deps(repo));
    const body = (await board.json()) as { data: { entries: Array<{ stageKey: string }> } };
    expect(body.data.entries).toHaveLength(1);
  });
});

describe("activity timeline", () => {
  it("reads back newest-first with typed metadata per kind", async () => {
    const repo = createFakeRepo();
    const eventsRepo = createFakeEventsRepo();
    await seedProspect(repo);
    const created = await createEntry(repo, { prospectId: PROSPECT }, eventsRepo);
    const entryId = asUuid(entryUuid(((await created.json()) as { data: { entry: { id: string } } }).data.entry.id));

    await handleUpdateEntry(
      new Request("https://x/e", { method: "PATCH", body: JSON.stringify({ stageKey: "contacted", ownerUserId: OWNER }) }),
      env(), "req_2", ACTOR, ORG_UUID, entryId,
      deps(repo, eventsRepo, new Date("2026-06-16T12:00:00.000Z")),
    );

    const response = await handleListActivities(
      new Request("https://x/a"), env(), "req_3", ACTOR, ORG_UUID, PROSPECT_UUID, { repo },
    );
    const body = (await response.json()) as {
      data: { activities: Array<{ kind: string; metadata: Record<string, unknown>; createdAt: string }> };
    };

    const kinds = body.data.activities.map((a) => a.kind);
    expect(kinds).toContain("stage_change");
    expect(kinds).toContain("owner_change");

    const move = body.data.activities.find((a) => a.kind === "stage_change" && a.metadata.to === "contacted")!;
    expect(move.metadata.from).toBe("new");
    expect(move.metadata.entryId).toMatch(/^pen_/);

    const timestamps = body.data.activities.map((a) => new Date(a.createdAt).getTime());
    expect(timestamps).toEqual([...timestamps].sort((a, b) => b - a));
  });

  it("accepts a manual note", async () => {
    const repo = createFakeRepo();
    await seedProspect(repo);

    const response = await handleCreateActivity(
      new Request("https://x/a", { method: "POST", body: JSON.stringify({ body: "Left a voicemail with the owner." }) }),
      env(), "req_1", ACTOR, ORG_UUID, PROSPECT_UUID, { repo, now: NOW },
    );
    expect(response.status).toBe(201);
    const body = (await response.json()) as { data: { activity: { kind: string; body: string; actorUserId: string } } };
    expect(body.data.activity.kind).toBe("note");
    expect(body.data.activity.body).toBe("Left a voicemail with the owner.");
    expect(body.data.activity.actorUserId).toBe(ACTOR.subjectId);
  });

  it("refuses to let a client fabricate a system activity kind", async () => {
    const repo = createFakeRepo();
    await seedProspect(repo);
    const response = await handleCreateActivity(
      new Request("https://x/a", { method: "POST", body: JSON.stringify({ kind: "stage_change", body: "moved" }) }),
      env(), "req_1", ACTOR, ORG_UUID, PROSPECT_UUID, { repo, now: NOW },
    );
    expect(response.status).toBe(422);
  });

  it("rejects an empty note and 404s on an unknown prospect", async () => {
    const repo = createFakeRepo();
    await seedProspect(repo);
    expect(
      (await handleCreateActivity(
        new Request("https://x/a", { method: "POST", body: JSON.stringify({ body: "   " }) }),
        env(), "req_1", ACTOR, ORG_UUID, PROSPECT_UUID, { repo, now: NOW },
      )).status,
    ).toBe(422);

    expect(
      (await handleListActivities(
        new Request("https://x/a"), env(), "req_2", ACTOR, ORG_UUID,
        asUuid("99999999-9999-9999-9999-999999999999"), { repo },
      )).status,
    ).toBe(404);
  });
});

describe("SP4 routing", () => {
  const e = env();

  it("matches the pipeline routes without reading 'stages' or 'entries' as ids", async () => {
    for (const [method, path] of [
      ["GET", `/v1/organizations/${ORG}/pipeline`],
      ["GET", `/v1/organizations/${ORG}/pipeline/stages`],
      ["PUT", `/v1/organizations/${ORG}/pipeline/stages`],
      ["POST", `/v1/organizations/${ORG}/pipeline/entries`],
      ["PATCH", `/v1/organizations/${ORG}/pipeline/entries/pen_33333333333333333333333333333333`],
      ["GET", `/v1/organizations/${ORG}/prospects/${PROSPECT}/activities`],
      ["POST", `/v1/organizations/${ORG}/prospects/${PROSPECT}/activities`],
    ] as const) {
      const init: RequestInit = { method, headers: ACTOR_HEADERS };
      if (method !== "GET") init.body = JSON.stringify({});
      const response = await route(new Request(`https://x${path}`, init), e);
      expect(response.status).not.toBe(404);
      expect(response.status).not.toBe(405);
    }
  });

  it("rejects the wrong method on the pipeline routes", async () => {
    for (const [method, path] of [
      ["DELETE", `/v1/organizations/${ORG}/pipeline`],
      ["POST", `/v1/organizations/${ORG}/pipeline/stages`],
      ["GET", `/v1/organizations/${ORG}/pipeline/entries`],
    ] as const) {
      const response = await route(new Request(`https://x${path}`, { method, headers: ACTOR_HEADERS }), e);
      expect(response.status).toBe(405);
    }
  });
});
