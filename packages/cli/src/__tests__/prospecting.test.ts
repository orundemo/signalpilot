// The prospecting command group.
//
// These tests exercise the walkthrough that verifies every backend milestone
// on a deployed environment: discover → signals → explain → generate → move.
// Each assertion is about what a person running the command actually sees —
// the score breakdown, the guardrail verdict, the stage clock — because that
// is what the milestone evidence is.

import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { describe, expect, it } from "vitest";

import { SignalPilot } from "@saas/sdk";

import { runCli } from "../cli-runner.js";
import { ContextStore } from "../context/store.js";
import { captureFetch, envelope, jsonResponse, MemoryTokenStore } from "./helpers.js";

const ORG = "org_11111111111111111111111111111111";
const PROSPECT = "prs_22222222222222222222222222222222";
const ENTRY = "pen_33333333333333333333333333333333";
const DISCOVERY = "dsc_44444444444444444444444444444444";

interface Cap {
  stdout: string[];
  stderr: string[];
  fetchCalls: { url: string; init: RequestInit }[];
}

async function withHarness(
  fn: (h: { cap: Cap; runArgv: (argv: string[]) => Promise<{ exitCode: number }> }) => Promise<void>,
  options: { response: () => Response; activeOrgId?: string },
): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cli-prospecting-"));
  try {
    const cap: Cap = { stdout: [], stderr: [], fetchCalls: [] };
    const fetchHarness = captureFetch(options.response);
    cap.fetchCalls = fetchHarness.calls;
    const tokenStore = new MemoryTokenStore({ apiUrl: "https://api.test", token: "tok" });
    const contextStore = new ContextStore({ configDir: dir });
    await contextStore.setActiveOrg(options.activeOrgId ?? ORG);

    const runArgv = (argv: string[]): Promise<{ exitCode: number }> =>
      runCli(argv, {
        stdout: (l) => cap.stdout.push(l),
        stderr: (l) => cap.stderr.push(l),
        tokenStore,
        contextStore,
        sdkFactory: (baseUrl, token) =>
          new SignalPilot({ baseUrl, auth: { kind: "bearer", token }, fetch: fetchHarness.fetch }),
      });

    await fn({ cap, runArgv });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

const DISCOVERY_RUN = envelope({
  discovery: {
    id: DISCOVERY,
    orgId: ORG,
    requestedBy: "usr_a",
    adapter: "synthetic",
    query: { location: "Leeds", industry: null, sizeBand: null, domains: [], limit: 25 },
    status: "running",
    candidatesFound: 0,
    prospectsCreated: 0,
    prospectsUpdated: 0,
    signalsRecorded: 0,
    errorCode: null,
    startedAt: "2026-06-15T12:00:00.000Z",
    finishedAt: null,
  },
});

const SCORE = {
  id: "scr_55555555555555555555555555555555",
  orgId: ORG,
  prospectId: PROSPECT,
  score: 82,
  band: "hot",
  rulesetVersion: 1,
  profileVersion: 0,
  contributions: [
    { kind: "tls_missing", points: 25, reason: "No valid HTTPS — visitors see a browser security warning", severity: 5, features: {}, signalId: "sig_1" },
    { kind: "perf_poor", points: 20, reason: "Page loads in 6.4s — slow enough to lose visitors", severity: 5, features: { lcp_ms: 6400 }, signalId: "sig_2" },
  ],
  signalIds: ["sig_1", "sig_2"],
  computedAt: "2026-06-15T12:00:00.000Z",
};

const PROSPECT_GET = envelope({
  prospect: {
    id: PROSPECT,
    orgId: ORG,
    name: "Ridgeway Plumbing",
    domain: "ridgeway.example",
    industry: "plumbing",
    locality: "Leeds",
    region: "England",
    country: "GB",
    sizeBand: "micro",
    source: "synthetic",
    status: "active",
    firstSeenAt: "2026-06-15T12:00:00.000Z",
    lastEnrichedAt: null,
    createdAt: "2026-06-15T12:00:00.000Z",
    updatedAt: "2026-06-15T12:00:00.000Z",
    archivedAt: null,
    currentScore: SCORE,
  },
});

const SIGNALS = envelope({
  signals: [
    {
      id: "sig_1",
      orgId: ORG,
      prospectId: PROSPECT,
      kind: "tls_missing",
      severity: 5,
      features: { scheme: "http", certificate: "absent" },
      source: "web-signals",
      sourceDigest: "a".repeat(64),
      observedAt: "2026-06-15T12:00:00.000Z",
      expiresAt: "2026-07-15T12:00:00.000Z",
    },
  ],
});

const INSIGHT = envelope({
  insight: {
    id: "ins_66666666666666666666666666666666",
    orgId: ORG,
    prospectId: PROSPECT,
    scoreId: SCORE.id,
    kind: "outreach_email",
    content: "I had a look at ridgeway.example and noticed the site has no valid HTTPS.",
    model: "template",
    promptVersion: 1,
    guardrailVerdict: "revised",
    guardrailNotes: [{ check: "bounds", action: "stripped", detail: 'Removed banned phrase "act now"' }],
    generatedBy: "usr_a",
    createdAt: "2026-06-15T12:00:00.000Z",
    cached: false,
  },
});

const PIPELINE = envelope({
  stages: [
    { id: "stg_1", orgId: ORG, key: "new", label: "New", position: 1, outcome: "open" },
    { id: "stg_2", orgId: ORG, key: "contacted", label: "Contacted", position: 2, outcome: "open" },
  ],
  entries: [
    {
      id: ENTRY,
      orgId: ORG,
      prospectId: PROSPECT,
      stageId: "stg_1",
      stageKey: "new",
      ownerUserId: null,
      valueCents: null,
      enteredStageAt: "2026-06-04T12:00:00.000Z",
      closedAt: null,
      createdAt: "2026-06-04T12:00:00.000Z",
      updatedAt: "2026-06-04T12:00:00.000Z",
      prospectName: "Ridgeway Plumbing",
      prospectDomain: "ridgeway.example",
      score: 82,
      band: "hot",
      daysInStage: 11,
    },
  ],
});

const ENTRY_RESPONSE = envelope({
  entry: {
    id: ENTRY,
    orgId: ORG,
    prospectId: PROSPECT,
    stageId: "stg_2",
    stageKey: "contacted",
    ownerUserId: null,
    valueCents: null,
    enteredStageAt: "2026-06-15T12:00:00.000Z",
    closedAt: null,
    createdAt: "2026-06-04T12:00:00.000Z",
    updatedAt: "2026-06-15T12:00:00.000Z",
  },
});

describe("discover", () => {
  it("starts a run and tells the user how to poll it", async () => {
    await withHarness(
      async ({ cap, runArgv }) => {
        const result = await runArgv(["discover", "run", "--location=Leeds", "--limit=5"]);
        expect(result.exitCode).toBe(0);
        expect(cap.fetchCalls[0]!.url).toBe(`https://api.test/v1/organizations/${ORG}/discoveries`);
        expect(cap.fetchCalls[0]!.init.method).toBe("POST");
        expect(JSON.parse(String(cap.fetchCalls[0]!.init.body))).toEqual({ location: "Leeds", limit: 5 });

        const text = cap.stdout.join("\n");
        expect(text).toContain(DISCOVERY);
        expect(text).toContain("discover status");
      },
      { response: () => jsonResponse(DISCOVERY_RUN, { status: 202 }) },
    );
  });

  it("splits a --domains list for the web-signals adapter", async () => {
    await withHarness(
      async ({ cap, runArgv }) => {
        await runArgv(["discover", "run", "--adapter=web-signals", "--domains=a.example, b.example"]);
        expect(JSON.parse(String(cap.fetchCalls[0]!.init.body))).toEqual({
          adapter: "web-signals",
          domains: ["a.example", "b.example"],
        });
      },
      { response: () => jsonResponse(DISCOVERY_RUN, { status: 202 }) },
    );
  });

  it("prints run counters on status", async () => {
    const completed = envelope({
      discovery: { ...DISCOVERY_RUN.data.discovery, status: "completed", candidatesFound: 5, prospectsCreated: 5, signalsRecorded: 14 },
    });
    await withHarness(
      async ({ cap, runArgv }) => {
        await runArgv(["discover", "status", DISCOVERY]);
        const text = cap.stdout.join("\n");
        expect(text).toContain("completed");
        expect(text).toContain("14");
      },
      { response: () => jsonResponse(completed) },
    );
  });

  it("emits the raw SDK shape under --output=json", async () => {
    await withHarness(
      async ({ cap, runArgv }) => {
        await runArgv(["discover", "run", "--output=json"]);
        expect(JSON.parse(cap.stdout[0] ?? "")).toEqual(DISCOVERY_RUN.data);
      },
      { response: () => jsonResponse(DISCOVERY_RUN, { status: 202 }) },
    );
  });
});

describe("prospects explain — the score derivation", () => {
  it("prints every contribution with its points and reason", async () => {
    await withHarness(
      async ({ cap, runArgv }) => {
        const result = await runArgv(["prospects", "explain", PROSPECT]);
        expect(result.exitCode).toBe(0);

        const text = cap.stdout.join("\n");
        expect(text).toContain("Ridgeway Plumbing — 82/100 (hot)");
        // The whole claim of the product, printable from a terminal:
        expect(text).toContain("No valid HTTPS");
        expect(text).toContain("Page loads in 6.4s");
        expect(text).toContain("25");
        expect(text).toContain("20");
        // …with the versions that produced it.
        expect(text).toContain("rulesetVersion");
      },
      { response: () => jsonResponse(PROSPECT_GET) },
    );
  });

  it("says so plainly when a prospect has not been scored yet", async () => {
    const unscored = envelope({ prospect: { ...PROSPECT_GET.data.prospect, currentScore: null } });
    await withHarness(
      async ({ cap, runArgv }) => {
        await runArgv(["prospects", "explain", PROSPECT]);
        const text = cap.stdout.join("\n");
        expect(text).toContain("not yet scored");
        expect(text).toContain("prospects rescore");
      },
      { response: () => jsonResponse(unscored) },
    );
  });

  it("requires a prospect id", async () => {
    await withHarness(
      async ({ runArgv }) => {
        const result = await runArgv(["prospects", "explain"]);
        expect(result.exitCode).not.toBe(0);
      },
      { response: () => jsonResponse(PROSPECT_GET) },
    );
  });
});

describe("prospects signals — the never-store-raw evidence", () => {
  it("shows the derived features and an abbreviated digest", async () => {
    await withHarness(
      async ({ cap, runArgv }) => {
        await runArgv(["prospects", "signals", PROSPECT]);
        const text = cap.stdout.join("\n");
        expect(text).toContain("tls_missing");
        expect(text).toContain('"scheme":"http"');
        expect(text).toContain("aaaaaaaaaaaa…");
      },
      { response: () => jsonResponse(SIGNALS) },
    );
  });
});

describe("prospects list", () => {
  it("passes band and stage filters through as query parameters", async () => {
    await withHarness(
      async ({ cap, runArgv }) => {
        await runArgv(["prospects", "list", "--band=hot", "--stage=contacted"]);
        const url = new URL(cap.fetchCalls[0]!.url);
        expect(url.searchParams.get("band")).toBe("hot");
        expect(url.searchParams.get("stageKey")).toBe("contacted");
      },
      { response: () => jsonResponse(envelope({ prospects: [PROSPECT_GET.data.prospect] })) },
    );
  });

  it("renders the score and band per row", async () => {
    await withHarness(
      async ({ cap, runArgv }) => {
        await runArgv(["prospects", "list"]);
        const text = cap.stdout.join("\n");
        expect(text).toContain("Ridgeway Plumbing");
        expect(text).toContain("82");
        expect(text).toContain("hot");
      },
      { response: () => jsonResponse(envelope({ prospects: [PROSPECT_GET.data.prospect] })) },
    );
  });
});

describe("insights generate", () => {
  it("prints the draft, the guardrail verdict, and what the guardrail changed", async () => {
    await withHarness(
      async ({ cap, runArgv }) => {
        const result = await runArgv(["insights", "generate", PROSPECT, "--kind=outreach_email"]);
        expect(result.exitCode).toBe(0);
        expect(cap.fetchCalls[0]!.url).toBe(
          `https://api.test/v1/organizations/${ORG}/prospects/${PROSPECT}/insights`,
        );

        const text = cap.stdout.join("\n");
        expect(text).toContain("guardrail: revised");
        expect(text).toContain("no valid HTTPS");
        // The edits are the feature — a draft changed silently would be worse
        // than one refused outright.
        expect(text).toContain('Removed banned phrase "act now"');
      },
      { response: () => jsonResponse(INSIGHT, { status: 201 }) },
    );
  });

  it("marks a replayed generation as cached", async () => {
    const cached = envelope({ insight: { ...INSIGHT.data.insight, cached: true } });
    await withHarness(
      async ({ cap, runArgv }) => {
        await runArgv(["insights", "generate", PROSPECT]);
        expect(cap.stdout.join("\n")).toContain("(cached)");
      },
      { response: () => jsonResponse(cached) },
    );
  });

  it("surfaces a 402 as a non-zero exit with the quota payload", async () => {
    await withHarness(
      async ({ cap, runArgv }) => {
        const result = await runArgv(["insights", "generate", PROSPECT, "--output=json"]);
        expect(result.exitCode).not.toBe(0);
        expect(cap.stderr.join("\n")).toContain("quota_exhausted");
      },
      {
        response: () =>
          jsonResponse(
            {
              error: {
                code: "quota_exhausted",
                message: "Your plan's monthly insight allowance is spent",
                details: { meter: "prospecting.insights.generated", limit: 10, used: 10, resetAt: "2026-07-01T00:00:00.000Z" },
                requestId: "req_1",
              },
            },
            { status: 402 },
          ),
      },
    );
  });
});

describe("pipeline", () => {
  it("renders the board with stuck-in-stage day counts", async () => {
    await withHarness(
      async ({ cap, runArgv }) => {
        await runArgv(["pipeline", "board"]);
        const text = cap.stdout.join("\n");
        expect(text).toContain("Ridgeway Plumbing");
        expect(text).toContain("new");
        expect(text).toContain("11");
      },
      { response: () => jsonResponse(PIPELINE) },
    );
  });

  it("adds a prospect to the board", async () => {
    await withHarness(
      async ({ cap, runArgv }) => {
        await runArgv(["pipeline", "add", PROSPECT, "--stage=new"]);
        expect(cap.fetchCalls[0]!.url).toBe(`https://api.test/v1/organizations/${ORG}/pipeline/entries`);
        expect(JSON.parse(String(cap.fetchCalls[0]!.init.body))).toEqual({ prospectId: PROSPECT, stageKey: "new" });
      },
      { response: () => jsonResponse(ENTRY_RESPONSE, { status: 201 }) },
    );
  });

  it("moves an entry and shows the reset stage clock", async () => {
    await withHarness(
      async ({ cap, runArgv }) => {
        const result = await runArgv(["pipeline", "move", ENTRY, "--stage=contacted"]);
        expect(result.exitCode).toBe(0);
        expect(cap.fetchCalls[0]!.init.method).toBe("PATCH");
        const text = cap.stdout.join("\n");
        expect(text).toContain("contacted");
        expect(text).toContain("2026-06-15T12:00:00.000Z");
      },
      { response: () => jsonResponse(ENTRY_RESPONSE) },
    );
  });

  it("rejects a move with nothing to change", async () => {
    await withHarness(
      async ({ runArgv }) => {
        const result = await runArgv(["pipeline", "move", ENTRY]);
        expect(result.exitCode).not.toBe(0);
      },
      { response: () => jsonResponse(ENTRY_RESPONSE) },
    );
  });

  it("lists the stages in position order", async () => {
    await withHarness(
      async ({ cap, runArgv }) => {
        await runArgv(["pipeline", "stages"]);
        const text = cap.stdout.join("\n");
        expect(text).toContain("contacted");
        expect(text).toContain("open");
      },
      { response: () => jsonResponse(envelope({ stages: PIPELINE.data.stages })) },
    );
  });
});

describe("org context", () => {
  it("honours an explicit --org over the active context", async () => {
    const other = "org_99999999999999999999999999999999";
    await withHarness(
      async ({ cap, runArgv }) => {
        await runArgv(["prospects", "list", `--org=${other}`]);
        expect(cap.fetchCalls[0]!.url).toContain(other);
      },
      { response: () => jsonResponse(envelope({ prospects: [] })) },
    );
  });
});
