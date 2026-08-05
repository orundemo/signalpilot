import { authorize } from "@saas/policy-engine";
import { ORGANIZATION_ACTIONS } from "@saas/contracts/policy";
import type { MembershipFact, PolicyMembershipFact, PolicySubject } from "@saas/contracts/policy";
import type { TenancyRole } from "@saas/contracts/tenancy";

const subject: PolicySubject = { type: "user", id: "usr_abc123" };
const ORG = "org_1";

function orgFact(role: string, orgId: string = ORG): MembershipFact {
  return { kind: "role_assignment", role: role as TenancyRole, scope: { kind: "organization", orgId } };
}

function can(action: string, memberships: PolicyMembershipFact[]): boolean {
  return authorize({
    subject,
    action,
    resource: { kind: "organization", orgId: ORG },
    context: { memberships },
  }).allow;
}

/**
 * The role matrix from specs/epics/prospecting/design.md §8, transcribed
 * verbatim. If the design and the engine disagree, this table is the
 * disagreement.
 */
const MATRIX: Array<[action: string, owner: boolean, admin: boolean, builder: boolean, viewer: boolean]> = [
  ["organization.prospect.read", true, true, true, true],
  ["organization.prospect.write", true, true, true, false],
  ["organization.prospect.archive", true, true, true, false],
  ["organization.discovery.read", true, true, true, true],
  ["organization.discovery.run", true, true, true, false],
  ["organization.insight.read", true, true, true, true],
  ["organization.insight.generate", true, true, true, false],
  ["organization.pipeline.read", true, true, true, true],
  ["organization.pipeline.write", true, true, true, false],
  ["organization.scoring_profile.read", true, true, true, true],
  ["organization.scoring_profile.write", true, true, false, false],
];

describe("prospecting actions — registration", () => {
  it("registers every prospecting action in ORGANIZATION_ACTIONS", () => {
    for (const [action] of MATRIX) {
      expect(ORGANIZATION_ACTIONS as readonly string[]).toContain(action);
    }
  });

  it("registers every prospecting action with the engine — an unregistered action denies as unknown_action", () => {
    for (const [action] of MATRIX) {
      const result = authorize({
        subject,
        action,
        resource: { kind: "organization", orgId: ORG },
        context: { memberships: [orgFact("owner")] },
      });
      expect(result.reason).not.toBe("unknown_action");
    }
  });

  it("still denies a plausible-looking but unregistered prospecting action", () => {
    const result = authorize({
      subject,
      action: "organization.prospect.delete",
      resource: { kind: "organization", orgId: ORG },
      context: { memberships: [orgFact("owner")] },
    });
    expect(result.allow).toBe(false);
    expect(result.reason).toBe("unknown_action");
  });
});

describe("prospecting actions — role matrix (design.md §8)", () => {
  it.each(MATRIX)("%s: owner=%s admin=%s builder=%s viewer=%s", (action, owner, admin, builder, viewer) => {
    expect(can(action, [orgFact("owner")])).toBe(owner);
    expect(can(action, [orgFact("admin")])).toBe(admin);
    expect(can(action, [orgFact("builder")])).toBe(builder);
    expect(can(action, [orgFact("viewer")])).toBe(viewer);
  });

  it("withholds weight tuning from builder — it changes what every number in the org means", () => {
    expect(can("organization.scoring_profile.read", [orgFact("builder")])).toBe(true);
    expect(can("organization.scoring_profile.write", [orgFact("builder")])).toBe(false);
  });

  it("gives billing_admin no prospecting write access", () => {
    expect(can("organization.prospect.write", [orgFact("billing_admin")])).toBe(false);
    expect(can("organization.discovery.run", [orgFact("billing_admin")])).toBe(false);
    expect(can("organization.insight.generate", [orgFact("billing_admin")])).toBe(false);
  });
});

describe("prospecting actions — tenancy", () => {
  it("denies a role held in a different organization", () => {
    for (const [action] of MATRIX) {
      expect(can(action, [orgFact("owner", "org_other")])).toBe(false);
    }
  });

  it("denies with no memberships at all", () => {
    for (const [action] of MATRIX) {
      expect(can(action, [])).toBe(false);
    }
  });
});
