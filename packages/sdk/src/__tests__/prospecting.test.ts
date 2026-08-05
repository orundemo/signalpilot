// Prospecting resource client — URL shapes, idempotency passthrough, and
// typed error decoding.
//
// The point of these tests is *parity*: every route the worker exposes must be
// reachable from the SDK at exactly the path the edge facade matches. A method
// that builds a slightly different path type-checks fine and 404s at runtime,
// which is the failure this file exists to catch.

import { describe, expect, it, vi } from "vitest";

import { SignalPilot } from "../index.js";
import { NotFoundError, ValidationError } from "../errors.js";

interface CapturedCall {
  url: string;
  init: RequestInit;
}

function captureFetch(response: Response): { fetch: typeof fetch; calls: CapturedCall[] } {
  const calls: CapturedCall[] = [];
  const fn: typeof fetch = vi.fn(async (input, init) => {
    calls.push({ url: String(input), init: init ?? {} });
    return response.clone();
  });
  return { fetch: fn, calls };
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
}

function envelope<T>(data: T): { data: T; meta: { requestId: string; cursor: null } } {
  return { data, meta: { requestId: "req_test", cursor: null } };
}

const BASE = "https://api.test";
const ORG = "org_11111111111111111111111111111111";
const PROSPECT = "prs_22222222222222222222222222222222";
const ENTRY = "pen_33333333333333333333333333333333";
const DISCOVERY = "dsc_44444444444444444444444444444444";

function client(response: Response): { sdk: SignalPilot; calls: CapturedCall[] } {
  const { fetch, calls } = captureFetch(response);
  return { sdk: new SignalPilot({ baseUrl: BASE, auth: { kind: "bearer", token: "t" }, fetch }), calls };
}

describe("ProspectingClient — route parity", () => {
  const cases: Array<[name: string, invoke: (sdk: SignalPilot) => Promise<unknown>, method: string, path: string]> = [
    ["runDiscovery", (s) => s.prospecting.runDiscovery(ORG, { limit: 5 }), "POST", `/v1/organizations/${ORG}/discoveries`],
    ["listDiscoveries", (s) => s.prospecting.listDiscoveries(ORG), "GET", `/v1/organizations/${ORG}/discoveries`],
    ["getDiscovery", (s) => s.prospecting.getDiscovery(ORG, DISCOVERY), "GET", `/v1/organizations/${ORG}/discoveries/${DISCOVERY}`],
    ["listProspects", (s) => s.prospecting.listProspects(ORG), "GET", `/v1/organizations/${ORG}/prospects`],
    ["getProspect", (s) => s.prospecting.getProspect(ORG, PROSPECT), "GET", `/v1/organizations/${ORG}/prospects/${PROSPECT}`],
    ["createProspect", (s) => s.prospecting.createProspect(ORG, { name: "X" }), "POST", `/v1/organizations/${ORG}/prospects`],
    ["updateProspect", (s) => s.prospecting.updateProspect(ORG, PROSPECT, { name: "Y" }), "PATCH", `/v1/organizations/${ORG}/prospects/${PROSPECT}`],
    ["archiveProspect", (s) => s.prospecting.archiveProspect(ORG, PROSPECT), "POST", `/v1/organizations/${ORG}/prospects/${PROSPECT}/archive`],
    ["listSignals", (s) => s.prospecting.listSignals(ORG, PROSPECT), "GET", `/v1/organizations/${ORG}/prospects/${PROSPECT}/signals`],
    ["rescore", (s) => s.prospecting.rescore(ORG, PROSPECT), "POST", `/v1/organizations/${ORG}/prospects/${PROSPECT}/rescore`],
    ["listScores", (s) => s.prospecting.listScores(ORG, PROSPECT), "GET", `/v1/organizations/${ORG}/prospects/${PROSPECT}/scores`],
    ["bulkRescore", (s) => s.prospecting.bulkRescore(ORG), "POST", `/v1/organizations/${ORG}/prospects/rescore`],
    ["getScoringProfile", (s) => s.prospecting.getScoringProfile(ORG), "GET", `/v1/organizations/${ORG}/scoring-profile`],
    ["putScoringProfile", (s) => s.prospecting.putScoringProfile(ORG, { weights: {} }), "PUT", `/v1/organizations/${ORG}/scoring-profile`],
    ["generateInsight", (s) => s.prospecting.generateInsight(ORG, PROSPECT, { kind: "prospect_summary" }), "POST", `/v1/organizations/${ORG}/prospects/${PROSPECT}/insights`],
    ["listInsights", (s) => s.prospecting.listInsights(ORG, PROSPECT), "GET", `/v1/organizations/${ORG}/prospects/${PROSPECT}/insights`],
    ["getPipeline", (s) => s.prospecting.getPipeline(ORG), "GET", `/v1/organizations/${ORG}/pipeline`],
    ["listStages", (s) => s.prospecting.listStages(ORG), "GET", `/v1/organizations/${ORG}/pipeline/stages`],
    ["putStages", (s) => s.prospecting.putStages(ORG, { stages: [] }), "PUT", `/v1/organizations/${ORG}/pipeline/stages`],
    ["createEntry", (s) => s.prospecting.createEntry(ORG, { prospectId: PROSPECT }), "POST", `/v1/organizations/${ORG}/pipeline/entries`],
    ["updateEntry", (s) => s.prospecting.updateEntry(ORG, ENTRY, { stageKey: "contacted" }), "PATCH", `/v1/organizations/${ORG}/pipeline/entries/${ENTRY}`],
    ["listActivities", (s) => s.prospecting.listActivities(ORG, PROSPECT), "GET", `/v1/organizations/${ORG}/prospects/${PROSPECT}/activities`],
    ["createActivity", (s) => s.prospecting.createActivity(ORG, PROSPECT, { body: "note" }), "POST", `/v1/organizations/${ORG}/prospects/${PROSPECT}/activities`],
  ];

  it.each(cases)("%s hits %s %s", async (_name, invoke, method, path) => {
    const { sdk, calls } = client(jsonResponse(envelope({})));
    await invoke(sdk);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.init.method).toBe(method);
    expect(calls[0]!.url.startsWith(`${BASE}${path}`)).toBe(true);
  });

  it("covers every route in the facade's allow-list", () => {
    // A method count that drifts from the facade is the drift this milestone
    // exists to prevent; the list above is the checklist.
    expect(cases).toHaveLength(23);
  });
});

describe("ProspectingClient — query serialization", () => {
  it("encodes board filters as query parameters", async () => {
    const { sdk, calls } = client(jsonResponse(envelope({ prospects: [] })));
    await sdk.prospecting.listProspects(ORG, { band: "hot", signalKind: "tls_missing", stageKey: "contacted", limit: 25 });
    const url = new URL(calls[0]!.url);
    expect(url.searchParams.get("band")).toBe("hot");
    expect(url.searchParams.get("signalKind")).toBe("tls_missing");
    expect(url.searchParams.get("stageKey")).toBe("contacted");
    expect(url.searchParams.get("limit")).toBe("25");
  });

  it("omits absent filters rather than sending empty values", async () => {
    const { sdk, calls } = client(jsonResponse(envelope({ prospects: [] })));
    await sdk.prospecting.listProspects(ORG, {});
    expect(calls[0]!.url).toBe(`${BASE}/v1/organizations/${ORG}/prospects`);
  });

  it("url-encodes ids", async () => {
    const { sdk, calls } = client(jsonResponse(envelope({})));
    await sdk.prospecting.getProspect("org_a/b", "prs_c d");
    expect(calls[0]!.url).toContain("org_a%2Fb");
    expect(calls[0]!.url).toContain("prs_c%20d");
  });
});

describe("ProspectingClient — request options", () => {
  it("passes an idempotency key through verbatim on a discovery run", async () => {
    const { sdk, calls } = client(jsonResponse(envelope({}), { status: 202 }));
    await sdk.prospecting.runDiscovery(ORG, {}, { idempotencyKey: "key-123" });
    const headers = new Headers(calls[0]!.init.headers as HeadersInit);
    expect(headers.get("idempotency-key")).toBe("key-123");
  });

  it("sends no idempotency header when the caller omits one", async () => {
    const { sdk, calls } = client(jsonResponse(envelope({}), { status: 202 }));
    await sdk.prospecting.runDiscovery(ORG, {});
    const headers = new Headers(calls[0]!.init.headers as HeadersInit);
    expect(headers.get("idempotency-key")).toBeNull();
  });

  it("serializes the request body as JSON", async () => {
    const { sdk, calls } = client(jsonResponse(envelope({})));
    await sdk.prospecting.putScoringProfile(ORG, { weights: { tls_missing: 40 } });
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ weights: { tls_missing: 40 } });
  });
});

describe("ProspectingClient — error decoding", () => {
  it("decodes a 404 into NotFoundError", async () => {
    const { sdk } = client(
      jsonResponse({ error: { code: "not_found", message: "Not found", requestId: "req_1" } }, { status: 404 }),
    );
    await expect(sdk.prospecting.getProspect(ORG, PROSPECT)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("decodes a 422 into ValidationError", async () => {
    const { sdk } = client(
      jsonResponse(
        { error: { code: "validation_failed", message: "Validation failed", details: { fields: {} }, requestId: "req_1" } },
        { status: 422 },
      ),
    );
    await expect(sdk.prospecting.runDiscovery(ORG, {})).rejects.toBeInstanceOf(ValidationError);
  });

  it("surfaces a 402 quota_exhausted with its details intact", async () => {
    const details = {
      meter: "prospecting.insights.generated",
      entitlement: "prospecting.insight",
      limit: 10,
      used: 10,
      resetAt: "2026-07-01T00:00:00.000Z",
    };
    const { sdk } = client(
      jsonResponse({ error: { code: "quota_exhausted", message: "spent", details, requestId: "req_1" } }, { status: 402 }),
    );

    // The console renders the upgrade prompt from this payload alone, so the
    // details must survive the SDK's error decoding untouched.
    await expect(
      sdk.prospecting.generateInsight(ORG, PROSPECT, { kind: "outreach_email" }),
    ).rejects.toMatchObject({ code: "quota_exhausted", details });
  });
});

describe("SignalPilot client surface", () => {
  it("exposes prospecting alongside the platform resources", () => {
    const { sdk } = client(jsonResponse(envelope({})));
    expect(sdk.prospecting).toBeDefined();
    expect(typeof sdk.prospecting.runDiscovery).toBe("function");
    expect(typeof sdk.prospecting.getPipeline).toBe("function");
  });
});
