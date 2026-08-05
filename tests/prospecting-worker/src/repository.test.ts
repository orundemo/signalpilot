import { createProspectingRepository } from "@saas/db/prospecting";
import type { SqlExecutor, SqlExecutorResult, SqlRow } from "@saas/db/hyperdrive";
import { asUuid } from "@saas/db/ids";

const ORG = asUuid("11111111-1111-1111-1111-111111111111");
const OTHER_ORG = asUuid("99999999-9999-9999-9999-999999999999");
const PROSPECT = asUuid("22222222-2222-2222-2222-222222222222");

interface MockCall {
  sql: string;
  params: unknown[];
}

function createMockExecutor(
  handler?: (sql: string, params: unknown[]) => SqlExecutorResult<Record<string, unknown>>,
): SqlExecutor & { calls: MockCall[] } {
  const calls: MockCall[] = [];
  return {
    calls,
    async execute<T extends SqlRow = SqlRow>(text: string, params: unknown[] = []): Promise<SqlExecutorResult<T>> {
      calls.push({ sql: text, params });
      if (handler) return handler(text, params) as unknown as SqlExecutorResult<T>;
      return { rows: [] as T[], rowCount: 0 };
    },
  };
}

function prospectRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: PROSPECT,
    org_id: ORG,
    name: "Bakery Ltd",
    domain: "bakery.example",
    dedupe_key: "d:bakery.example",
    industry: "food",
    locality: "Leeds",
    region: "England",
    country: "GB",
    size_band: "micro",
    source: "synthetic",
    source_ref: "syn-1",
    status: "active",
    first_seen_at: "2026-01-01T00:00:00.000Z",
    last_enriched_at: null,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    archived_at: null,
    ...overrides,
  };
}

describe("prospecting repository — tenant scoping", () => {
  it("filters every read on org_id", async () => {
    const executor = createMockExecutor(() => ({ rows: [], rowCount: 0 }));
    const repo = createProspectingRepository(executor);

    await repo.getProspect(ORG, PROSPECT);
    await repo.listProspectsPaged(ORG, { limit: 10, cursor: null });
    await repo.listSignals(ORG, PROSPECT, 50);
    await repo.listScorableSignals(ORG, PROSPECT, new Date("2026-01-01T00:00:00Z"));
    await repo.listScores(ORG, PROSPECT, 10);
    await repo.listInsights(ORG, PROSPECT, 10);
    await repo.listActivities(ORG, PROSPECT, 10);
    await repo.listStages(ORG);
    await repo.listBoard(ORG, 100);

    expect(executor.calls.length).toBeGreaterThan(0);
    for (const call of executor.calls) {
      expect(call.sql).toMatch(/org_id = \$1/);
      expect(call.params[0]).toBe(ORG);
    }
  });

  it("cannot read another tenant's prospect by id alone", async () => {
    const executor = createMockExecutor((_sql, params) => {
      // The fixture only holds ORG's row; a query bound to OTHER_ORG misses.
      if (params[0] === ORG) return { rows: [prospectRow()], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });
    const repo = createProspectingRepository(executor);

    const mine = await repo.getProspect(ORG, PROSPECT);
    expect(mine.ok).toBe(true);

    const theirs = await repo.getProspect(OTHER_ORG, PROSPECT);
    expect(theirs.ok).toBe(false);
    if (!theirs.ok) expect(theirs.error.kind).toBe("not_found");
  });
});

describe("prospecting repository — dedupe upsert", () => {
  it("reports created:true when the row was inserted", async () => {
    const executor = createMockExecutor(() => ({
      rows: [prospectRow({ inserted: true })],
      rowCount: 1,
    }));
    const repo = createProspectingRepository(executor);

    const result = await repo.upsertProspect({
      id: PROSPECT,
      orgId: ORG,
      name: "Bakery Ltd",
      domain: "bakery.example",
      dedupeKey: "d:bakery.example",
      industry: null,
      locality: null,
      region: null,
      country: null,
      sizeBand: "unknown",
      source: "synthetic",
      sourceRef: null,
      observedAt: new Date("2026-01-01T00:00:00Z"),
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.created).toBe(true);
      expect(result.value.prospect.dedupeKey).toBe("d:bakery.example");
    }
    expect(executor.calls[0]!.sql).toMatch(/ON CONFLICT \(org_id, dedupe_key\) DO UPDATE/);
  });

  it("reports created:false when the dedupe key already existed", async () => {
    const executor = createMockExecutor(() => ({
      rows: [prospectRow({ inserted: false })],
      rowCount: 1,
    }));
    const repo = createProspectingRepository(executor);

    const result = await repo.upsertProspect({
      id: PROSPECT,
      orgId: ORG,
      name: "Bakery Ltd",
      domain: "bakery.example",
      dedupeKey: "d:bakery.example",
      industry: null,
      locality: null,
      region: null,
      country: null,
      sizeBand: "unknown",
      source: "synthetic",
      sourceRef: null,
      observedAt: new Date("2026-01-01T00:00:00Z"),
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.created).toBe(false);
  });
});

describe("prospecting repository — scoring reads", () => {
  it("takes the most recent signal per kind and drops expired ones", async () => {
    const executor = createMockExecutor(() => ({ rows: [], rowCount: 0 }));
    const repo = createProspectingRepository(executor);

    await repo.listScorableSignals(ORG, PROSPECT, new Date("2026-06-01T00:00:00Z"));

    const sql = executor.calls[0]!.sql;
    expect(sql).toMatch(/DISTINCT ON \(kind\)/);
    expect(sql).toMatch(/expires_at IS NULL OR expires_at > \$3/);
    expect(sql).toMatch(/ORDER BY kind, observed_at DESC/);
  });

  it("serializes a score's signal ids as a uuid array literal", async () => {
    const executor = createMockExecutor(() => ({
      rows: [
        {
          id: "33333333-3333-3333-3333-333333333333",
          org_id: ORG,
          prospect_id: PROSPECT,
          score: 82,
          band: "hot",
          ruleset_version: 1,
          profile_version: 1,
          contributions: [],
          signal_ids: ["44444444-4444-4444-4444-444444444444"],
          computed_at: "2026-01-01T00:00:00.000Z",
        },
      ],
      rowCount: 1,
    }));
    const repo = createProspectingRepository(executor);

    const result = await repo.insertScore({
      id: asUuid("33333333-3333-3333-3333-333333333333"),
      orgId: ORG,
      prospectId: PROSPECT,
      score: 82,
      band: "hot",
      rulesetVersion: 1,
      profileVersion: 1,
      contributions: [],
      signalIds: ["44444444-4444-4444-4444-444444444444"],
      computedAt: new Date("2026-01-01T00:00:00Z"),
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.signalIds).toEqual(["44444444-4444-4444-4444-444444444444"]);
    expect(executor.calls[0]!.params).toContain("{44444444-4444-4444-4444-444444444444}");
  });

  it("deactivates the previous profile before inserting the next version", async () => {
    const executor = createMockExecutor((sql) => {
      if (sql.startsWith("UPDATE")) return { rows: [], rowCount: 1 };
      return {
        rows: [
          {
            id: "55555555-5555-5555-5555-555555555555",
            org_id: ORG,
            version: 2,
            ruleset_version: 1,
            weights: { tls_missing: 40 },
            is_active: true,
            created_by: null,
            created_at: "2026-01-01T00:00:00.000Z",
          },
        ],
        rowCount: 1,
      };
    });
    const repo = createProspectingRepository(executor);

    const result = await repo.insertScoringProfile({
      id: asUuid("55555555-5555-5555-5555-555555555555"),
      orgId: ORG,
      rulesetVersion: 1,
      weights: { tls_missing: 40 },
      createdBy: null,
      createdAt: new Date("2026-01-01T00:00:00Z"),
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.version).toBe(2);
    expect(executor.calls[0]!.sql).toMatch(/SET is_active = false/);
    expect(executor.calls[1]!.sql).toMatch(/COALESCE\(MAX\(version\), 0\) \+ 1/);
  });
});

describe("prospecting repository — insight cache", () => {
  it("looks a generation up by its input digest", async () => {
    const executor = createMockExecutor(() => ({ rows: [], rowCount: 0 }));
    const repo = createProspectingRepository(executor);

    const result = await repo.findInsightByDigest(ORG, "b".repeat(64));

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBeNull();
    expect(executor.calls[0]!.sql).toMatch(/input_digest = \$2/);
  });

  it("treats a digest collision as a conflict, not a duplicate row", async () => {
    const executor = createMockExecutor(() => ({ rows: [], rowCount: 0 }));
    const repo = createProspectingRepository(executor);

    const result = await repo.insertInsight({
      id: asUuid("66666666-6666-6666-6666-666666666666"),
      orgId: ORG,
      prospectId: PROSPECT,
      scoreId: asUuid("33333333-3333-3333-3333-333333333333"),
      kind: "prospect_summary",
      content: "…",
      model: "test",
      promptVersion: 1,
      inputDigest: "c".repeat(64),
      guardrailVerdict: "pass",
      guardrailNotes: [],
      generatedBy: null,
      createdAt: new Date("2026-01-01T00:00:00Z"),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("conflict");
    expect(executor.calls[0]!.sql).toMatch(/ON CONFLICT \(org_id, input_digest\) DO NOTHING/);
  });
});

describe("prospecting repository — pipeline", () => {
  it("only surfaces open entries on the board", async () => {
    const executor = createMockExecutor(() => ({ rows: [], rowCount: 0 }));
    const repo = createProspectingRepository(executor);

    await repo.listBoard(ORG, 200);

    expect(executor.calls[0]!.sql).toMatch(/e\.closed_at IS NULL/);
  });

  it("seeds stages idempotently", async () => {
    const executor = createMockExecutor(() => ({ rows: [], rowCount: 0 }));
    const repo = createProspectingRepository(executor);

    await repo.seedStages(ORG, [
      { id: "77777777-7777-7777-7777-777777777777", key: "new", label: "New", position: 1, outcome: "open" },
    ]);

    expect(executor.calls[0]!.sql).toMatch(/ON CONFLICT \(org_id, key\) DO NOTHING/);
  });
});
