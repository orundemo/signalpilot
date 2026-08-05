import { route } from "@prospecting-worker/router";
import type { Env } from "@prospecting-worker/env";

interface HealthBody {
  data: {
    status: string;
    service: string;
    environment: string;
    checks: Record<string, { configured: boolean }>;
  };
  meta: { requestId: string };
}

interface ErrorBody {
  error: { code: string; message: string; requestId: string };
}

function createEnv(overrides?: Partial<Env>): Env {
  return { ENVIRONMENT: "test", ...overrides } as Env;
}

describe("prospecting-worker router", () => {
  it("answers the health route", async () => {
    const response = await route(new Request("https://prospecting.internal/health"), createEnv());
    expect(response.status).toBe(200);
    const body = (await response.json()) as HealthBody;
    expect(body.data.status).toBe("ok");
    expect(body.data.service).toBe("prospecting-worker");
    expect(body.data.environment).toBe("test");
  });

  it("reports each binding's configured state on health", async () => {
    const response = await route(
      new Request("https://prospecting.internal/health"),
      createEnv({ PLATFORM_DB: {} as Hyperdrive }),
    );
    const body = (await response.json()) as HealthBody;
    expect(body.data.checks.database!.configured).toBe(true);
    expect(body.data.checks.membership!.configured).toBe(false);
    expect(body.data.checks.policy!.configured).toBe(false);
    expect(body.data.checks.billing!.configured).toBe(false);
    expect(body.data.checks.metering!.configured).toBe(false);
  });

  it("echoes a caller-supplied request id", async () => {
    const response = await route(
      new Request("https://prospecting.internal/health", { headers: { "x-request-id": "req_abc123" } }),
      createEnv(),
    );
    const body = (await response.json()) as HealthBody;
    expect(body.meta.requestId).toBe("req_abc123");
  });

  it("generates a request id when the header is malformed", async () => {
    const response = await route(
      new Request("https://prospecting.internal/health", { headers: { "x-request-id": "not a valid id!" } }),
      createEnv(),
    );
    const body = (await response.json()) as HealthBody;
    expect(body.meta.requestId).toMatch(/^req_[0-9a-f]{24}$/);
  });

  it("returns the platform 404 envelope for an unknown route", async () => {
    const response = await route(new Request("https://prospecting.internal/v1/nope"), createEnv());
    expect(response.status).toBe(404);
    const body = (await response.json()) as ErrorBody;
    expect(body.error.code).toBe("not_found");
  });

  it("does not answer health on a non-GET method", async () => {
    const response = await route(
      new Request("https://prospecting.internal/health", { method: "POST" }),
      createEnv(),
    );
    expect(response.status).toBe(404);
  });
});
