# Epic: prospecting

**Turn the multi-tenant platform baseline into a product: a B2B prospecting
system that discovers businesses, reads buying signals off them, scores the
opportunity deterministically, drafts the outreach, and moves the result
through a pipeline.**

Everything below the product line — users, organizations, RBAC, audit,
entitlements, metering, billing, notifications, webhooks, console shell,
CI/CD, IaC, migrations — is already live per environment. This epic adds the
one bounded context that makes the platform a product, and nothing else.

## Status

| Field | Value |
|-------|-------|
| Status | **Draft — not started** |
| Cluster | **SP** (SP0–SP8) — the first *product* bounded context on this baseline |
| Owner(s) | `apps/prospecting-worker` (new), `apps/api-edge`, `packages/{contracts,policy-engine,db,sdk,cli}`, `apps/web-console-next` |
| Target branch | `epic/prospecting` → `main` |
| Builds on | identity/membership, `policy-worker` + `packages/policy-engine`, `@saas/db` + Hyperdrive, `metering-worker`, `billing-worker`, `events-worker`, `notifications-worker`, `webhooks-worker`, the console foundation |
| Origin | Upwork job **"Full-Stack Developer for SaaS MVP" (LeadPilot)** — see [`market-context.md`](./market-context.md) |
| Decisions locked | See below |

### Decisions locked

1. **One bounded context, one worker.** `apps/prospecting-worker` owns
   discovery, scoring, insights, and pipeline. *Not* a `discovery-worker` +
   `scoring-worker` split: they share the prospect aggregate, and splitting
   them would force either a cross-worker join or shared schema ownership —
   both forbidden by the tenancy contract.
2. **Org = agency tenant.** Every prospecting row carries `org_id`; every
   query filters on it. No cross-context foreign keys.
3. **The score is deterministic and server-owned.** A pure, versioned rules
   engine produces the score. The LLM never produces a number — it only writes
   prose about a score that already exists.
4. **Raw provider payloads are never persisted.** Signals store derived
   features plus a `source_digest`; the fetched document is dropped in-request.
   The audit record proves what was *not* stored.
5. **Metered from day one.** `discovery.run` and `insight.generate` are gated
   by `billing-worker` entitlements and recorded to `metering-worker`.
   Discovery credits *are* the commercial model here — unlike a platform
   context, this one cannot ship ungated.
6. **Provider-neutral discovery.** Source adapters sit behind one interface.
   v1 ships two adapters that need no per-tenant credentials (`synthetic`,
   `web-signals`); credentialed third-party providers bind through
   `integrations-worker` in a later milestone.
7. **Audited from day one.** `prospecting.*` events emit to `events-worker` on
   every mutation, and are published as `webhooks-worker` event types.
8. **Outreach is drafted, not sent.** v1 generates the email; sending is out
   of scope (deliverability, consent, and suppression are their own product).
9. **RBAC is additive.** New `organization.prospect.*`,
   `organization.discovery.*`, `organization.insight.*`,
   `organization.pipeline.*`, `organization.scoring_profile.*` actions.
   No existing action changes meaning.
10. **One public surface only.** A storefront route group plus self-serve
    signup. No other unauthenticated ingress.

## Thesis

The client brief describes a product that helps agencies and freelancers find
customers by analysing business signals and generating outreach. Read
structurally, that brief is roughly 75% platform and 25% domain:

| What the brief asks for | Where it lives |
|---|---|
| Auth, users, sessions | `identity-worker` — shipped |
| Agencies as tenants, seats, invites | `membership-worker` — shipped |
| Who can see and do what | `policy-worker` + `packages/policy-engine` — shipped |
| Usage limits on discovery and AI credits | `metering-worker` — shipped |
| Plans, subscriptions, checkout | `billing-worker` (Polar) — shipped, live |
| Activity history, audit | `events-worker` — shipped |
| Transactional email + preferences | `notifications-worker` — shipped |
| Outbound integration hooks | `webhooks-worker` — shipped |
| Console shell, org switching, settings, billing UI | `web-console-next` — shipped |
| **Business discovery, signals, scoring, insights, pipeline** | **this epic** |

So the work is a *lift onto rails*, not a build from zero. The domain delta is
one worker, three migrations, one contracts module, one ~90-LOC edge facade,
four console route groups, and a test package.

Two design commitments carry disproportionate weight, and both exist to make
the product defensible rather than merely functional:

- **Explainability.** A score is worthless to a salesperson who cannot see why
  it is 82. Scores are append-only rows carrying the ruleset version, the
  weight-profile version, and a per-rule contribution breakdown. The console
  renders that breakdown directly, so "why this prospect" is a UI feature, not
  a support ticket.
- **Restraint about the model.** The LLM sits behind a guardrail pass and is
  cached by input digest. It cannot invent facts outside the signal set, it
  cannot move the score, and every generation is metered. This is what keeps
  an AI feature from becoming an unbounded cost and an unbounded liability.

## Read order

1. `README.md` (this file) — charter and locked decisions.
2. `design.md` — bounded context, data model, discovery, scoring engine,
   insight guardrails, pipeline, RBAC, commercial surface, non-goals.
3. `implementation-plan.md` — SP0–SP8 with acceptance criteria.
4. `market-context.md` — the originating Upwork job, what the client is
   actually buying, and the proposal artefacts this epic must produce.
5. `risks-and-open-questions.md` — what could go wrong, what is undecided.
6. `IMPLEMENTATION-STATUS.md` — as-built record (empty until SP0 lands).

## Milestones at a glance

| ID | Milestone | Status |
|----|-----------|--------|
| SP0 | Contract + data model: `@saas/contracts/prospecting`, migrations `200`/`210`/`220`, manifest entries, policy actions | Draft |
| SP1 | Discovery: provider-neutral adapters, ingestion, identity resolution/dedupe, enrichment cache, discovery runs | Draft |
| SP2 | Scoring: pure versioned rules engine, weight profiles, append-only explainable score records | Draft |
| SP3 | Insights: LLM behind a supervisor/guardrail layer, digest-cached, metered; prospect summary + outreach draft | Draft |
| SP4 | Pipeline: stages, entries, owners, activities timeline | Draft |
| SP5 | Edge + SDK + CLI: `prospecting-facade.ts`, rate-limit wiring, full contract parity | Draft |
| SP6 | Console: `discover` / `prospects` / `pipeline` / `insights` on the design system, over the live API | Draft |
| SP7 | Commercial: plans, entitlements, quotas, notification templates, webhook event types | Draft |
| SP8 | Storefront + evidence: public marketing route group, self-serve signup, seeded demo tenant, `08-docs` re-run | Draft |

## Scope boundary

| In scope | Out of scope |
|----------|--------------|
| One product bounded context (`prospecting`); org-scoped prospects, signals, scores, insights, pipeline, activities; provider-neutral discovery adapters; deterministic versioned scoring with per-rule explainability; guardrailed, cached, metered AI drafting; additive RBAC actions; full API/SDK/CLI parity; four console surfaces; a public storefront and self-serve signup; a seeded demo tenant | Sending outreach email (drafting only); two-way CRM sync; sequence/cadence automation; large-scale crawling; contact-level personal data enrichment (business records only); multi-currency deal values; cross-tenant benchmarking; changing identity/tenancy/billing ownership |

## Relationship to the platform

- **`metering-worker` / `billing-worker`** — this is the first context to take
  a hard entitlement gate on the request path. The pattern follows
  `projects-worker`'s `billing-client.ts`; it does not invent a new one.
- **`events-worker`** — receives `prospecting.*` domain events; the audit
  console surface picks them up with no change.
- **`integrations-worker`** — untouched in v1. It becomes the credential
  broker when a credentialed discovery provider lands (SP1 follow-on).
- **`api-edge`** — one new facade, registered in the dispatch chain and in
  `rate-limit.ts`. No change to existing facades.

## Verification bar

The scoring engine and the guardrail evaluator are unit-tested with no
database and no network. Backend milestones are verified on `stage` via an
authenticated CLI walkthrough (`signalpilot prospects …`) and smoke-checked on
`prod` after promotion. Console milestones are verified with an authenticated
Playwright walkthrough plus screenshots. Quota behaviour is verified by
driving a tenant past its limit and asserting the 402/429 contract and the
`prospecting.quota.exhausted` event.

**"Implemented locally" is not a completion state.**
