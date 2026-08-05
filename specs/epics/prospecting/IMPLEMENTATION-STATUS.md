# prospecting — Implementation status

As-built record. This file tracks what actually shipped, kept deliberately
distinct from `design.md` (intent) and `implementation-plan.md` (plan).

## Summary

| Field | Value |
|-------|-------|
| Epic status | **In progress** |
| Branch | milestone branches → `main` (charter merged in #8) |
| Milestones shipped | SP0 |
| Live on `stage` | SP0 |
| Live on `prod` | SP0 |

The charter, design, and milestone ladder merged in #8. SP0 lands the contract
module, the three migrations, the persistence layer, the RBAC actions, and the
worker skeleton.

## Baseline this epic starts from

Recorded so that "what did the product layer add" stays answerable later.

| Layer | State at epic open |
|-------|--------------------|
| Workers | 13 shipped: `api-edge`, `identity`, `membership`, `projects`, `policy`, `events`, `config`, `metering`, `billing`, `notifications`, `webhooks`, `admin`, `integrations` |
| Console | `web-console-next` live; org surfaces: `api-keys`, `audit`, `billing`, `config`, `invitations`, `members`, `projects`, `settings`, `usage`, `webhooks` |
| Packages | `contracts`, `policy-engine`, `db`, `sdk`, `cli`, `shared`, `testing`, `notifications-client`, `webhook-verifier` |
| Migrations | `000_control` → `190_integrations_delivery_attribution` — product context starts at `200` |
| Contracts modules | 20, none domain-specific |
| Policy actions | `ORGANIZATION_ACTIONS` platform-only; no product actions |
| Environments | `dev` (verify-only), `stage`, `prod` — all converging through Orun |
| Composition stack | `oci://ghcr.io/sourceplane/stack-tectonic:0.18.2` (pinned) |

## Milestone log

| ID | Milestone | Status | PR | Verified on | Notes |
|----|-----------|--------|----|-------------|-------|
| SP0 | Contract + data model | **Shipped** | #9 | `stage` + `prod` | contracts module, migrations 200/210/220, `@saas/db/prospecting`, 11 RBAC actions, worker skeleton |
| SP1 | Discovery | Draft | — | — | |
| SP2 | Scoring | Draft | — | — | |
| SP3 | Insights | Draft | — | — | |
| SP4 | Pipeline | Draft | — | — | |
| SP5 | Edge + SDK + CLI | Draft | — | — | |
| SP6 | Console | Draft | — | — | |
| SP7 | Commercial | Draft | — | — | |
| SP8 | Storefront + evidence | Draft | — | — | |

## Deviations from design

Any implementation that diverges from `design.md` is noted here with the
reason, rather than by silently editing the design.

### SP0

- **`prospecting.signals` carries a `source` column** (the adapter id that
  derived the observation) which `design.md` §3 does not list. It mirrors
  `prospects.source` and makes "which adapter said this" answerable in the
  score explainer without a join. Additive; no behaviour depends on its
  absence.
- **The full repository surface landed in SP0**, not just the core tables.
  The plan assigns "repositories and types" to SP0 and all three migrations to
  SP0; splitting the repository across SP1–SP4 would have meant four rounds of
  edits to one file for no verification benefit. Handlers still land per
  milestone.
- **`ERROR_CODES.QUOTA_EXHAUSTED` was added in SP0** rather than SP7. It is a
  contract, and SP0 is the contract milestone; SP3/SP7 consume it.
