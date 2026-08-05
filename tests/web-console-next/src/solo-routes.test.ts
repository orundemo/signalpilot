// The console-side mirror of the edge's Solo suppression.
//
// `apps/api-edge/src/solo-mode.ts` is the enforcer; this predicate keeps the
// console from offering a door to a room the edge has locked. They have to
// agree, so the cases below are written against the capabilities the edge
// suppresses rather than against the console's route table.

import { isSoloSuppressedPath } from "@web-console-next/lib/solo-routes";

describe("isSoloSuppressedPath", () => {
  it("suppresses the platform plumbing the sidebar drops", () => {
    expect(isSoloSuppressedPath("/orgs/acme/projects")).toBe(true);
    expect(isSoloSuppressedPath("/orgs/acme/usage")).toBe(true);
  });

  it("suppresses collaboration, credentials, and the developer surface", () => {
    for (const segment of ["members", "invitations", "api-keys", "webhooks", "integrations", "audit"]) {
      expect(isSoloSuppressedPath(`/orgs/acme/settings/${segment}`)).toBe(true);
    }
  });

  it("suppresses a suppressed surface at any depth", () => {
    // The legacy un-nested paths still redirect, and project scope nests two
    // levels deeper — both have to be caught.
    expect(isSoloSuppressedPath("/orgs/acme/members")).toBe(true);
    expect(isSoloSuppressedPath("/orgs/acme/projects/web/environments")).toBe(true);
    expect(isSoloSuppressedPath("/orgs/acme/settings/webhooks/ep_123")).toBe(true);
  });

  it("suppresses creating a second organization — the user is the tenant", () => {
    expect(isSoloSuppressedPath("/orgs?new=1")).toBe(true);
    // Listing and reading the personal org stay open, so the console can
    // resolve it. This mirrors the edge, which only 404s POST /organizations.
    expect(isSoloSuppressedPath("/orgs")).toBe(false);
  });

  it("serves the product in full", () => {
    for (const segment of ["discover", "prospects", "pipeline", "insights", "isolation-proof"]) {
      expect(isSoloSuppressedPath(`/orgs/acme/${segment}`)).toBe(false);
    }
  });

  it("serves the settings Solo keeps", () => {
    expect(isSoloSuppressedPath("/orgs/acme/settings")).toBe(false);
    expect(isSoloSuppressedPath("/orgs/acme/settings/billing")).toBe(false);
    expect(isSoloSuppressedPath("/orgs/acme/settings/notifications")).toBe(false);
    expect(isSoloSuppressedPath("/orgs/acme/settings/config")).toBe(false);
  });

  it("never suppresses an account surface — those are the ones Solo is built around", () => {
    expect(isSoloSuppressedPath("/account")).toBe(false);
    expect(isSoloSuppressedPath("/account/security")).toBe(false);
    expect(isSoloSuppressedPath("/login")).toBe(false);
    expect(isSoloSuppressedPath("/signalpilot")).toBe(false);
  });

  it("does not confuse an org slug with a surface name", () => {
    // An org could legitimately be slugged "projects"; the slug sits at
    // segment 1 and is never inspected.
    expect(isSoloSuppressedPath("/orgs/projects/prospects")).toBe(false);
  });

  it("carries a query string without tripping over it", () => {
    expect(isSoloSuppressedPath("/orgs/acme/projects?new=1")).toBe(true);
    expect(isSoloSuppressedPath("/orgs/acme/prospects?band=hot")).toBe(false);
  });
});
