# prospecting — Implementation status

As-built record. This file tracks what actually shipped, kept deliberately
distinct from `design.md` (intent) and `implementation-plan.md` (plan).

## Summary

| Field | Value |
|-------|-------|
| Epic status | **In progress** |
| Branch | milestone branches → `main` (charter merged in #8) |
| Milestones shipped | SP0, SP1, SP2 |
| Live on `stage` | SP0, SP1, SP2 |
| Live on `prod` | SP0, SP1, SP2 |

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
| SP1 | Discovery | **Shipped** | #10 | `stage` + `prod` | adapters (`synthetic`, `web-signals`), `engine/dedupe.ts`, discovery + prospect routes, metering seam, events; edge facade pulled forward from SP5 |
| SP2 | Scoring | **Shipped** | #11 | `stage` + `prod` | `engine/scoring.ts` (pure, 33 unit tests), scoring profiles, auto-score at discovery, rescore + bulk rescore, score history |
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

### SP1

- **The `api-edge` facade was pulled forward from SP5.** The epic's own bar is
  "implemented locally is not a completion state", and without the facade the
  worker has no reachable surface on `stage` — SP1 would ship unverifiable.
  The facade, the `PROSPECTING_WORKER` binding, and the two rate-limit classes
  land here; SP5 keeps the SDK, the CLI, and full route parity as the routes
  arrive.
- **A new service-binding seam on `metering-worker`**
  (`POST /v1/internal/metering/usage`). The public usage route authorizes an
  end user against `organization.metering.write`; a bounded context recording
  its own product meter has no end user to authorize. The seam is gated on the
  caller allow-list *and* a metric allow-list, so a misconfigured caller
  cannot write arbitrary meters.
- **`prospecting.signals.source` is written from the adapter id**, using the
  column added in SP0.
- **The billing period is the UTC calendar month.** `design.md` §9 states
  allowances per month but does not define the window. A rolling 30 days makes
  "when do my credits reset" a support question; the calendar month is
  predictable and is what the 402 payload reports as `resetAt`.

### SP2

- **The bulk rescore is bounded at 200 prospects per call** and reports
  `truncated` when the corpus is larger. `design.md` §5.2 names the action but
  not its shape; an unbounded foreground loop would either time out mid-way —
  leaving a half-rescored board with no record of where it stopped — or hold a
  connection long enough to matter. The caller repeats.
- **`profileVersion: 0` means "no org profile, code ruleset defaults".** The
  design's profile table starts at version 1; an org that has never tuned
  weights needs a value, and 0 reads correctly in the explainer.
- **A zero-weight rule still appears in `contributions`, at zero points.** The
  explainer then shows that the signal was seen and priced at nothing, rather
  than looking identical to a signal that was never observed.
- **`toPublicScore` maps `contributions[].signalId` to the public `sig_` form.**
  It is stored as the internal UUID; returning both forms for one observation
  would leave the console unable to join a contribution to the signal it came
  from.
