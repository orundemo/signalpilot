import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  isProspectingRoute,
  handleProspectingRoute,
  prospectingRouteFamily,
} from "@api-edge/prospecting-facade";
import { __rateLimitConfigForTest } from "@api-edge/rate-limit";
import type { Env } from "@api-edge/env";

const __dirname = dirname(fileURLToPath(import.meta.url));

function stripJsoncComments(text: string): string {
  return text.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
}

interface FetchCall {
  url: string;
  init: RequestInit;
}

function createDownstream(status = 200): { fetcher: Fetcher; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fetcher = {
    fetch(input: string | Request | URL, init?: RequestInit): Promise<Response> {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      calls.push({ url, init: init ?? {} });
      return Promise.resolve(
        Response.json({ data: { prospects: [] }, meta: { requestId: "req_inner", cursor: null } }, { status }),
      );
    },
    connect() {
      throw new Error("not implemented");
    },
  } as unknown as Fetcher;
  return { fetcher, calls };
}

function createIdentity(userId = "usr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"): Fetcher {
  return {
    fetch(input: string | Request | URL): Promise<Response> {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("/v1/auth/resolve")) {
        return Promise.resolve(
          Response.json({
            data: {
              actor: { actorType: "user", actorId: userId, email: "user@test.com" },
              session: { id: "ses_abc", expiresAt: "2026-12-01T00:00:00Z", createdAt: "2026-01-01T00:00:00Z" },
              user: { id: userId, email: "user@test.com", displayName: "Test" },
            },
            meta: { requestId: "req_inner", cursor: null },
          }),
        );
      }
      return Promise.resolve(Response.json({ data: {}, meta: { requestId: "req_test", cursor: null } }));
    },
    connect() {
      throw new Error("not implemented");
    },
  } as unknown as Fetcher;
}

const ORG = "org_11111111111111111111111111111111";
const PROSPECT = "prs_22222222222222222222222222222222";

function authedRequest(method: string, path: string, body?: unknown): Request {
  const init: RequestInit = {
    method,
    headers: { authorization: "Bearer sess_test", "content-type": "application/json" },
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  return new Request(`https://api.test${path}`, init);
}

describe("api-edge prospecting facade", () => {
  describe("isProspectingRoute", () => {
    it.each([
      `/v1/organizations/${ORG}/discoveries`,
      `/v1/organizations/${ORG}/discoveries/dsc_33333333333333333333333333333333`,
      `/v1/organizations/${ORG}/prospects`,
      `/v1/organizations/${ORG}/prospects/${PROSPECT}`,
      `/v1/organizations/${ORG}/prospects/${PROSPECT}/archive`,
      `/v1/organizations/${ORG}/prospects/${PROSPECT}/signals`,
      `/v1/organizations/${ORG}/prospects/${PROSPECT}/rescore`,
      `/v1/organizations/${ORG}/prospects/${PROSPECT}/scores`,
      `/v1/organizations/${ORG}/prospects/rescore`,
      `/v1/organizations/${ORG}/scoring-profile`,
    ])("matches %s", (path) => {
      expect(isProspectingRoute(path)).toBe(true);
    });

    it("does not shadow the projects family", () => {
      expect(isProspectingRoute(`/v1/organizations/${ORG}/projects`)).toBe(false);
      expect(isProspectingRoute(`/v1/organizations/${ORG}/projects/prj_1/environments`)).toBe(false);
    });

    it("does not match a route outside the org prefix", () => {
      expect(isProspectingRoute("/v1/prospects")).toBe(false);
      expect(isProspectingRoute("/health")).toBe(false);
    });
  });

  describe("rate-limit class", () => {
    it("puts a discovery run in the expensive class", () => {
      expect(prospectingRouteFamily(`/v1/organizations/${ORG}/discoveries`, "POST")).toBe("prospecting_expensive");
    });

    it("leaves reads in the standard class", () => {
      expect(prospectingRouteFamily(`/v1/organizations/${ORG}/discoveries`, "GET")).toBe("prospecting");
      expect(prospectingRouteFamily(`/v1/organizations/${ORG}/prospects`, "GET")).toBe("prospecting");
    });

    it("puts a cheap write in the standard class", () => {
      expect(prospectingRouteFamily(`/v1/organizations/${ORG}/prospects`, "POST")).toBe("prospecting");
      expect(prospectingRouteFamily(`/v1/organizations/${ORG}/prospects/${PROSPECT}/archive`, "POST")).toBe("prospecting");
    });

    it("budgets the expensive class an order of magnitude tighter", () => {
      const standard = __rateLimitConfigForTest.prospecting;
      const expensive = __rateLimitConfigForTest.prospecting_expensive;
      expect(expensive.identity.limit).toBeLessThan(standard.identity.limit);
      expect(expensive.org.limit).toBeLessThan(standard.org.limit);
      expect(expensive.identity.limit).toBeGreaterThan(0);
      expect(expensive.org.limit).toBeGreaterThan(0);
    });
  });

  describe("dispatch", () => {
    it("forwards to PROSPECTING_WORKER with the resolved actor headers", async () => {
      const { fetcher, calls } = createDownstream();
      const env = { IDENTITY_WORKER: createIdentity(), PROSPECTING_WORKER: fetcher, ENVIRONMENT: "test" } as Env;

      const path = `/v1/organizations/${ORG}/prospects`;
      const response = await handleProspectingRoute(authedRequest("GET", path), env, "req_1", path);

      expect(response.status).toBe(200);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.url).toContain(path);
      const headers = calls[0]!.init.headers as Headers;
      expect(headers.get("x-actor-subject-id")).toBe("usr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
      expect(headers.get("x-actor-subject-type")).toBe("user");
      expect(headers.get("x-request-id")).toBe("req_1");
    });

    it("preserves the query string", async () => {
      const { fetcher, calls } = createDownstream();
      const env = { IDENTITY_WORKER: createIdentity(), PROSPECTING_WORKER: fetcher, ENVIRONMENT: "test" } as Env;
      const path = `/v1/organizations/${ORG}/prospects`;
      await handleProspectingRoute(
        new Request(`https://api.test${path}?band=hot&limit=10`, {
          method: "GET",
          headers: { authorization: "Bearer sess_test" },
        }),
        env,
        "req_1",
        path,
      );
      expect(calls[0]!.url).toContain("band=hot");
      expect(calls[0]!.url).toContain("limit=10");
    });

    it("rejects an unsupported method before touching the downstream", async () => {
      const { fetcher, calls } = createDownstream();
      const env = { IDENTITY_WORKER: createIdentity(), PROSPECTING_WORKER: fetcher, ENVIRONMENT: "test" } as Env;
      const path = `/v1/organizations/${ORG}/prospects/${PROSPECT}/signals`;
      const response = await handleProspectingRoute(authedRequest("DELETE", path), env, "req_1", path);
      expect(response.status).toBe(405);
      expect(calls).toHaveLength(0);
    });

    it("returns 503 when the prospecting binding is absent", async () => {
      const env = { IDENTITY_WORKER: createIdentity(), ENVIRONMENT: "test" } as Env;
      const path = `/v1/organizations/${ORG}/prospects`;
      const response = await handleProspectingRoute(authedRequest("GET", path), env, "req_1", path);
      expect(response.status).toBe(503);
    });

    it("returns 503 when the downstream throws", async () => {
      const env = {
        IDENTITY_WORKER: createIdentity(),
        PROSPECTING_WORKER: {
          fetch() { return Promise.reject(new Error("down")); },
          connect() { throw new Error("not implemented"); },
        } as unknown as Fetcher,
        ENVIRONMENT: "test",
      } as Env;
      const path = `/v1/organizations/${ORG}/prospects`;
      const response = await handleProspectingRoute(authedRequest("GET", path), env, "req_1", path);
      expect(response.status).toBe(503);
    });

    it("passes the downstream status through unchanged — the edge does not reinterpret 402", async () => {
      const quota = {
        fetch() {
          return Promise.resolve(
            Response.json({ error: { code: "quota_exhausted", message: "spent", details: {} } }, { status: 402 }),
          );
        },
        connect() { throw new Error("not implemented"); },
      } as unknown as Fetcher;
      const env = { IDENTITY_WORKER: createIdentity(), PROSPECTING_WORKER: quota, ENVIRONMENT: "test" } as Env;
      const path = `/v1/organizations/${ORG}/discoveries`;
      const response = await handleProspectingRoute(authedRequest("POST", path, {}), env, "req_1", path);
      expect(response.status).toBe(402);
      const body = (await response.json()) as { error: { code: string } };
      expect(body.error.code).toBe("quota_exhausted");
    });

    it("requires a session", async () => {
      const { fetcher, calls } = createDownstream();
      const env = { IDENTITY_WORKER: createIdentity(), PROSPECTING_WORKER: fetcher, ENVIRONMENT: "test" } as Env;
      const path = `/v1/organizations/${ORG}/prospects`;
      const response = await handleProspectingRoute(new Request(`https://api.test${path}`), env, "req_1", path);
      expect(response.status).toBe(401);
      expect(calls).toHaveLength(0);
    });
  });

  describe("method allow-lists", () => {
    it("only permits PUT and GET on the scoring profile", async () => {
      const { fetcher, calls } = createDownstream();
      const env = { IDENTITY_WORKER: createIdentity(), PROSPECTING_WORKER: fetcher, ENVIRONMENT: "test" } as Env;
      const path = `/v1/organizations/${ORG}/scoring-profile`;
      expect((await handleProspectingRoute(authedRequest("DELETE", path), env, "req_1", path)).status).toBe(405);
      expect(calls).toHaveLength(0);
      expect((await handleProspectingRoute(authedRequest("GET", path), env, "req_2", path)).status).toBe(200);
    });

    it("only permits POST on a rescore", async () => {
      const { fetcher } = createDownstream();
      const env = { IDENTITY_WORKER: createIdentity(), PROSPECTING_WORKER: fetcher, ENVIRONMENT: "test" } as Env;
      const path = `/v1/organizations/${ORG}/prospects/${PROSPECT}/rescore`;
      expect((await handleProspectingRoute(authedRequest("GET", path), env, "req_1", path)).status).toBe(405);
    });

    it("treats /prospects/rescore as the bulk action, not a prospect id", async () => {
      const { fetcher, calls } = createDownstream();
      const env = { IDENTITY_WORKER: createIdentity(), PROSPECTING_WORKER: fetcher, ENVIRONMENT: "test" } as Env;
      const path = `/v1/organizations/${ORG}/prospects/rescore`;
      const response = await handleProspectingRoute(authedRequest("POST", path, {}), env, "req_1", path);
      expect(response.status).toBe(200);
      expect(calls).toHaveLength(1);
    });
  });

  describe("wrangler wiring", () => {
    const configPath = resolve(__dirname, "../../../apps/api-edge/wrangler.template.jsonc");
    const config = JSON.parse(stripJsoncComments(readFileSync(configPath, "utf8"))) as {
      env: Record<string, { services?: Array<{ binding: string; service: string }> }>;
    };

    it.each(["stage", "prod"])("binds PROSPECTING_WORKER on %s", (envName) => {
      const services = config.env[envName]!.services ?? [];
      const binding = services.find((s) => s.binding === "PROSPECTING_WORKER");
      expect(binding).toBeDefined();
      expect(binding!.service).toBe(`signalpilot-prospecting-worker-${envName}`);
    });
  });
});
