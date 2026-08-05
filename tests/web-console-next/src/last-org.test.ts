import {
  defaultOrgDestination,
  entryDestination,
  resolvePostAuthDestination,
} from "@web-console-next/lib/last-org";

describe("defaultOrgDestination", () => {
  it("routes to the last-used org's board when one is remembered", () => {
    expect(defaultOrgDestination("acme")).toBe("/orgs/acme/prospects");
  });

  it("falls back to onboarding when none is remembered — there is no org-less landing view", () => {
    expect(defaultOrgDestination(null)).toBe("/onboarding");
  });

  it("lands on the same product surface under both profiles", () => {
    // The destination no longer depends on the profile: Projects is platform
    // plumbing (and edge-suppressed under Solo), so it is not anyone's
    // dashboard. The board is.
    expect(defaultOrgDestination("acme")).toBe("/orgs/acme/prospects");
    // No remembered org still routes to onboarding (which forwards to the
    // auto-provisioned personal org once it loads).
    expect(defaultOrgDestination(null)).toBe("/onboarding");
  });
});

describe("entryDestination", () => {
  it("sends a signed-out visitor to the storefront, not the login form", () => {
    // The root URL is the product's front door. A visitor with no session is
    // far more likely to be seeing the product for the first time than to be a
    // returning operator, and a bare credential prompt tells them nothing.
    expect(entryDestination(false, null)).toBe("/signalpilot");
    // Even a remembered slug doesn't change it — the slug is a stale hint once
    // the token is gone.
    expect(entryDestination(false, "acme")).toBe("/signalpilot");
  });

  it("sends a signed-in operator straight into the work", () => {
    expect(entryDestination(true, "acme")).toBe("/orgs/acme/prospects");
    expect(entryDestination(true, null)).toBe("/onboarding");
  });
});

describe("resolvePostAuthDestination", () => {
  const org = (id: string, slug: string, createdAt: string) => ({ id, slug, createdAt });
  const profile = (lastOrgSlug: string | null) => ({
    getProfile: async () => ({ user: { lastOrgSlug } }),
  });
  const failingProfile = {
    getProfile: async (): Promise<{ user: { lastOrgSlug?: string | null } }> => {
      throw new Error("api-key token");
    },
  };

  it("prefers the server-side last-org preference", async () => {
    const dest = await resolvePostAuthDestination({
      auth: profile("acme"),
      organizations: { list: async () => ({ organizations: [] }) },
    });
    expect(dest).toBe("/orgs/acme/prospects");
  });

  it("sends a first sign-in (no orgs) to mandatory onboarding", async () => {
    const dest = await resolvePostAuthDestination({
      auth: profile(null),
      organizations: { list: async () => ({ organizations: [] }) },
    });
    expect(dest).toBe("/onboarding");
  });

  it("lands on the account's billing-parent (earliest-created) org when no preference is set", async () => {
    const dest = await resolvePostAuthDestination({
      auth: profile(null),
      organizations: {
        list: async () => ({
          organizations: [
            org("org_b", "beta", "2026-02-01T00:00:00Z"),
            org("org_a", "alpha", "2026-01-01T00:00:00Z"),
          ],
        }),
      },
    });
    expect(dest).toBe("/orgs/alpha/prospects");
  });

  it("still resolves via the org list when the profile read fails", async () => {
    const dest = await resolvePostAuthDestination({
      auth: failingProfile,
      organizations: {
        list: async () => ({ organizations: [org("org_a", "alpha", "2026-01-01T00:00:00Z")] }),
      },
    });
    expect(dest).toBe("/orgs/alpha/prospects");
  });

  it("falls back to the local cache (empty here) when every read fails", async () => {
    const dest = await resolvePostAuthDestination({
      auth: failingProfile,
      organizations: {
        list: async () => {
          throw new Error("offline");
        },
      },
    });
    // No window/localStorage in this environment, so the cache is empty and the
    // resolver defers to onboarding — which itself forwards once orgs load.
    expect(dest).toBe("/onboarding");
  });
});
