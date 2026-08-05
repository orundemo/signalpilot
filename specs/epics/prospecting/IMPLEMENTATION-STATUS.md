# prospecting — Implementation status

As-built record. This file tracks what actually shipped, kept deliberately
distinct from `design.md` (intent) and `implementation-plan.md` (plan).

## Summary

| Field | Value |
|-------|-------|
| Epic status | **Draft — not started** |
| Branch | `epic/prospecting` |
| Milestones shipped | none |
| Live on `stage` | no |
| Live on `prod` | no |

Nothing has been implemented yet. This epic introduces the charter, the
technical design, and the SP0–SP8 milestone ladder; the first code lands with
SP0.

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
| SP0 | Contract + data model | Draft | — | — | |
| SP1 | Discovery | Draft | — | — | |
| SP2 | Scoring | Draft | — | — | |
| SP3 | Insights | Draft | — | — | |
| SP4 | Pipeline | Draft | — | — | |
| SP5 | Edge + SDK + CLI | Draft | — | — | |
| SP6 | Console | Draft | — | — | |
| SP7 | Commercial | Draft | — | — | |
| SP8 | Storefront + evidence | Draft | — | — | |

## Deviations from design

None recorded. Any implementation that diverges from `design.md` is noted here
with the reason, rather than by silently editing the design.
