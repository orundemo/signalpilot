// The commercial surface: plans, entitlements, notification templates, and
// the published webhook event schemas.
//
// The quota *paths* are asserted where they run (discovery in
// `routes.test.ts`, insights in `insights.test.ts`). This file covers what
// makes those paths mean something commercially: that every plan actually
// carries the two entitlements, that the allowances match the design, and that
// nothing leaves the tenant boundary in an email or a webhook that should not.

import { PLAN_CATALOG } from "@billing-worker/plan-catalog";
import {
  DISCOVERY_NOTIFY_THRESHOLD,
  PROSPECTING_TEMPLATES,
  buildDiscoveryComplete,
  buildHotProspectDigest,
  shouldNotifyDiscovery,
} from "@prospecting-worker/notifications";
import {
  PROSPECTING_ENTITLEMENTS,
  PROSPECTING_EVENT_SCHEMAS,
  PROSPECTING_EVENT_TYPES,
  PROSPECTING_METERS,
} from "@saas/contracts/prospecting";

function planEntitlement(code: string, key: string) {
  const plan = PLAN_CATALOG.find((p) => p.code === code);
  return plan?.entitlements.find((e) => e.entitlementKey === key);
}

describe("plans carry the prospecting entitlements", () => {
  it("defines both on every plan — an org with neither could not be gated at all", () => {
    for (const plan of PLAN_CATALOG) {
      for (const key of [PROSPECTING_ENTITLEMENTS.discovery, PROSPECTING_ENTITLEMENTS.insight]) {
        const entitlement = plan.entitlements.find((e) => e.entitlementKey === key);
        expect(entitlement).toBeDefined();
        expect(entitlement!.valueType).toBe("quantity");
        expect(entitlement!.enabled).toBe(true);
      }
    }
  });

  it("matches the allowances in design.md §9", () => {
    // The design names Free / Starter / Growth; this baseline's live plan codes
    // are free / pro / business (renaming a live plan code is a breaking
    // change), so the tiers map onto them in order.
    expect(planEntitlement("free", PROSPECTING_ENTITLEMENTS.discovery)!.limitValue).toBe(100);
    expect(planEntitlement("free", PROSPECTING_ENTITLEMENTS.insight)!.limitValue).toBe(10);

    expect(planEntitlement("pro", PROSPECTING_ENTITLEMENTS.discovery)!.limitValue).toBe(1000);
    expect(planEntitlement("pro", PROSPECTING_ENTITLEMENTS.insight)!.limitValue).toBe(200);

    expect(planEntitlement("business", PROSPECTING_ENTITLEMENTS.discovery)!.limitValue).toBe(10000);
    expect(planEntitlement("business", PROSPECTING_ENTITLEMENTS.insight)!.limitValue).toBe(2000);
  });

  it("leaves enterprise unlimited", () => {
    expect(planEntitlement("enterprise", PROSPECTING_ENTITLEMENTS.discovery)!.limitValue).toBeNull();
    expect(planEntitlement("enterprise", PROSPECTING_ENTITLEMENTS.insight)!.limitValue).toBeNull();
  });

  it("never lowers an allowance as the plan gets more expensive", () => {
    const ladder = ["free", "pro", "business"];
    for (const key of Object.values(PROSPECTING_ENTITLEMENTS)) {
      const values = ladder.map((code) => planEntitlement(code, key)!.limitValue as number);
      for (let i = 1; i < values.length; i++) {
        expect(values[i]!).toBeGreaterThan(values[i - 1]!);
      }
    }
  });
});

describe("meters", () => {
  it("names one meter per gated operation", () => {
    expect(PROSPECTING_METERS.prospectsDiscovered).toBe("prospecting.prospects.discovered");
    expect(PROSPECTING_METERS.insightsGenerated).toBe("prospecting.insights.generated");
  });
});

describe("notification templates", () => {
  const digest = buildHotProspectDigest({
    orgPublicId: "org_1",
    recipientUserPublicId: "usr_1",
    recipientEmail: "rep@agency.example",
    newlyHot: [
      { name: "Ridgeway Plumbing", score: 82 },
      { name: "Corner Bakery", score: 74 },
    ],
    consoleUrl: "https://console.example/orgs/acme/prospects",
  });

  it("routes through the platform's product category, so the existing opt-out applies", () => {
    expect(digest.category).toBe("product");
    expect(digest.templateKey).toBe(PROSPECTING_TEMPLATES.hotProspectDigest);
  });

  it("carries the count and the top score — the decision the recipient makes from the inbox", () => {
    expect(digest.templateData!.count).toBe(2);
    expect(digest.templateData!.topScore).toBe(82);
  });

  it("bounds the preview so a large digest is not an unbounded payload", () => {
    const large = buildHotProspectDigest({
      orgPublicId: "org_1",
      recipientUserPublicId: "usr_1",
      recipientEmail: "rep@agency.example",
      newlyHot: Array.from({ length: 40 }, (_, i) => ({ name: `Business ${i}`, score: 70 + (i % 20) })),
      consoleUrl: "https://console.example",
    });
    expect(large.templateData!.truncated).toBe(true);
    expect(String(large.templateData!.preview).split(",")).toHaveLength(5);
  });

  it("puts no signal features, prose, or contact data in the payload", () => {
    const serialized = JSON.stringify(digest.templateData);
    for (const forbidden of ["source_digest", "features", "content", "lcp_ms"]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("addresses the recipient by channel and address, with the user as the preference subject", () => {
    expect(digest.recipient.channel).toBe("email");
    expect(digest.recipient.address).toBe("rep@agency.example");
    expect(digest.recipient.subjectKind).toBe("user");
    expect(digest.recipient.subjectId).toBe("usr_1");
  });

  it("builds the discovery-complete template with the run's counters", () => {
    const message = buildDiscoveryComplete({
      orgPublicId: "org_1",
      recipientUserPublicId: "usr_1",
      recipientEmail: "rep@agency.example",
      adapter: "synthetic",
      status: "completed",
      prospectsCreated: 60,
      prospectsUpdated: 4,
      signalsRecorded: 180,
      consoleUrl: "https://console.example",
    });
    expect(message.category).toBe("product");
    expect(message.templateData!.prospectsCreated).toBe(60);
    expect(message.templateData!.status).toBe("completed");
  });
});

describe("discovery notification threshold", () => {
  it("stays quiet for a small run the requester is watching", () => {
    expect(shouldNotifyDiscovery({ status: "completed", prospectsCreated: 5 })).toBe(false);
  });

  it("emails for a run above the threshold", () => {
    expect(shouldNotifyDiscovery({ status: "completed", prospectsCreated: DISCOVERY_NOTIFY_THRESHOLD })).toBe(true);
  });

  it("always emails a failure, however small — that is the run they need to know about", () => {
    expect(shouldNotifyDiscovery({ status: "failed", prospectsCreated: 1 })).toBe(true);
  });
});

describe("published webhook event schemas", () => {
  it("publishes a schema for every event type — an unpublished event is not integrable", () => {
    for (const type of PROSPECTING_EVENT_TYPES) {
      const schema = PROSPECTING_EVENT_SCHEMAS[type];
      expect(schema).toBeDefined();
      expect(schema.description.length).toBeGreaterThan(0);
      expect(Object.keys(schema.fields).length).toBeGreaterThan(0);
    }
  });

  it("publishes exactly the eight types the design names", () => {
    expect(PROSPECTING_EVENT_TYPES).toHaveLength(8);
    expect(Object.keys(PROSPECTING_EVENT_SCHEMAS)).toHaveLength(8);
  });

  it("scopes every event to an org — a webhook payload without a tenant is a leak waiting to happen", () => {
    for (const type of PROSPECTING_EVENT_TYPES) {
      expect(PROSPECTING_EVENT_SCHEMAS[type].fields.orgId).toBeDefined();
    }
  });

  it("keeps the generated text out of the insight event", () => {
    const fields = PROSPECTING_EVENT_SCHEMAS["prospecting.insight.generated"].fields;
    expect(fields.content).toBeUndefined();
    expect(fields.guardrailVerdict).toBeDefined();
  });

  it("keeps signal features out of every payload", () => {
    for (const type of PROSPECTING_EVENT_TYPES) {
      expect(PROSPECTING_EVENT_SCHEMAS[type].fields.features).toBeUndefined();
      expect(PROSPECTING_EVENT_SCHEMAS[type].fields.sourceDigest).toBeUndefined();
    }
  });

  it("carries the previous value on a score change, so a consumer need not keep its own board", () => {
    const fields = PROSPECTING_EVENT_SCHEMAS["prospecting.prospect.scored"].fields;
    expect(fields.previousScore).toBeDefined();
    expect(fields.previousBand).toBeDefined();
  });

  it("carries everything an upgrade prompt needs on the quota event", () => {
    const fields = PROSPECTING_EVENT_SCHEMAS["prospecting.quota.exhausted"].fields;
    for (const key of ["meter", "entitlement", "limit", "used", "resetAt"]) {
      expect(fields[key]).toBeDefined();
    }
  });
});
