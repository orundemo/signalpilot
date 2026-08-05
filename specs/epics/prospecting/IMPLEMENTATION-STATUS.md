# prospecting — Implementation status

As-built record. This file tracks what actually shipped, kept deliberately
distinct from `design.md` (intent) and `implementation-plan.md` (plan).

## Summary

| Field | Value |
|-------|-------|
| Epic status | **In progress** |
| Branch | milestone branches → `main` (charter merged in #8) |
| Milestones shipped | SP0, SP1, SP2, SP3, SP4 |
| Live on `stage` | SP0, SP1, SP2, SP3, SP4 |
| Live on `prod` | SP0, SP1, SP2, SP3, SP4 |

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
| SP3 | Insights | **Shipped** | #12 | `stage` + `prod` | model adapter (Claude SDK + deterministic template fallback), `engine/guardrail.ts`, digest cache, entitlement gate before the model call |
| SP4 | Pipeline | **Shipped** | #13 | `stage` + `prod` | lazy stage seeding, board with stuck-in-stage day counts, entries with the one-open-entry constraint, activity timeline |
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

### SP3

- **Two model adapters ship, not one.** `anthropic.ts` calls the Claude
  Messages API through the official SDK when `MODEL_API_KEY` is bound;
  `template.ts` is a deterministic writer that composes prose from the
  contributions. The template adapter is what the tests exercise (a model call
  cannot give byte-identical output, and mocking the model everywhere would
  leave the caching and metering paths tested only against a fiction), and it
  is what an environment with no credential falls back to. The stored row
  records `model: "template"`, so nothing is misrepresented as a model
  generation. `design.md` §6.2 specifies one adapter behind one interface; this
  is two implementations of that interface, not a second seam.
- **The cache lookup runs *before* the entitlement gate.** Replaying a
  generation the tenant already paid for must not consume a second credit and
  must not fail when they are at their limit. The gate still precedes the
  *model call*, which is what §6.2 requires.
- **`POST /insights` returns 412, not 500, on a guardrail block or a model
  decline.** Both are expected outcomes with a typed `reason`, and the
  guardrail notes are returned so the console can say what was wrong rather
  than showing a bare failure.
- **An unscored prospect is a 412, not an implicit rescore.** Generating prose
  about a prospect with no score would have the model supply the judgement the
  engine is supposed to own.
- **Bundle cost.** Adding `@anthropic-ai/sdk` takes the worker bundle from
  24.6 KiB / 6.2 KiB gzipped to 744 KiB / 147 KiB gzipped — well inside the
  Workers limit, but a real jump for a worker that is otherwise database code.
  Recorded so the trade is visible if it ever needs revisiting.

### SP4

- **Stages are seeded lazily, on first read or write**, not at org creation. A
  tenant that never opens the pipeline carries no rows for it, and the seed is
  `ON CONFLICT DO NOTHING` so two concurrent first requests converge.
- **`PUT /pipeline/stages` rejects a board with no `open` stage.** Not in the
  design, but a board where every stage is terminal has nowhere to put a new
  prospect — the next `POST /pipeline/entries` would close on arrival.
- **`replaceStages` keeps a stage that still has an entry on it**, even when
  the caller omitted it. Deleting it would orphan a card with no way for the
  user to find it again.
- **Only `note` activities are writable through the API.** The other kinds are
  written by the system as a consequence of the thing happening; accepting one
  from a client would let the timeline claim an event that never occurred.
- **`daysInStage` is computed on read, not stored.** It is a pure function of
  `entered_stage_at` and the current clock, so a stored copy could only ever be
  stale.
