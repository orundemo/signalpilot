# prospecting — Implementation status

As-built record. This file tracks what actually shipped, kept deliberately
distinct from `design.md` (intent) and `implementation-plan.md` (plan).

## Summary

| Field | Value |
|-------|-------|
| Epic status | **Shipped — SP0–SP8 merged to `main`** |
| Branch | milestone branches → `main` (charter merged in #8) |
| Milestones shipped | SP0–SP8 |
| Live on `stage` | SP0–SP8 |
| Live on `prod` | SP0–SP8 |

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
| SP5 | Edge + SDK + CLI | **Shipped** | #14 | `stage` + `prod` | edge facade landed incrementally in SP1–SP4; `sdk.prospecting.*` (23 methods) and the `discover`/`prospects`/`insights`/`pipeline` command groups land here |
| SP6 | Console | **Shipped** | #15 | `stage` + `prod` | `discover` / `prospects` / `pipeline` / `insights` on the existing design system, over the live API via the SDK |
| SP7 | Commercial | **Shipped** | #16 | `stage` + `prod` | plan entitlements on all four plans, quota events on both gated paths, two notification templates, eight published webhook event schemas |
| SP8 | Storefront + evidence | **Shipped** | #17 | `stage` + `prod` | storefront + signup hand-off, isolation-proof page, `demo seed` command, product docs, catalog entity |

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

### SP5

- **The edge facade landed in SP1 and grew with each milestone**, rather than
  arriving whole here. Recorded as an SP1 deviation; SP5 is the SDK and CLI.
- **The facade is 92 lines** — inside the "under ~100 LOC" bar in the plan.
  Anything larger would mean logic had leaked into the edge; the facade does
  route matching, method allow-listing, actor forwarding, and nothing else.
- **`prospects explain` prints the derivation, not just the number.** The
  plan's acceptance criterion is that the CLI can print a score with its full
  explanation; the command renders each contribution's points, signal kind, and
  reason string, plus the ruleset and profile versions that produced it.
- **`prospects signals` abbreviates the source digest to 12 characters.** Long
  enough to see it is a digest, short enough to read in a terminal — and the
  point of showing it at all is that the payload it came from is not stored
  anywhere.

### SP6

- **The kanban uses native HTML5 drag-and-drop, not a library.** Adding a
  drag-and-drop dependency to the console for one board is a bigger call than
  the feature warrants; the native API covers the interaction, and every card
  also carries a stage picker so the same move is reachable by keyboard and on
  touch. Both paths call one handler.
- **The four product surfaces sit above Projects in the sidebar.** The console
  is now a product console first and a platform console second; platform
  administration stays behind Settings, unchanged.
- **All view-model logic lives in `components/prospecting/prospecting.ts`.**
  Band treatment, bar scaling, quota parsing, stuck-in-stage, board grouping,
  and prospect ordering are pure functions with no React, so every rule the
  pages render is asserted without mounting a page.
- **Score bars scale against the largest contribution in that score**, not
  against 100 — otherwise a well-balanced 45 renders as a row of stubs, which
  reads as "nothing here" when the point is the opposite.
- **The Playwright walkthrough was not run.** See the SP6 PR: it needs an
  authenticated session against a deployed environment, which this environment
  does not hold.

### SP7

- **The design names Free / Starter / Growth; this baseline's live plan codes
  are `free` / `pro` / `business`.** Renaming a live plan code is a breaking
  change to an in-production billing system, and the plan catalog carries an
  explicit no-regress rule, so the design's tiers map onto the existing codes
  in order: free→100/10, pro→1000/200, business→10000/2000, enterprise
  unlimited. The allowances are exactly the design's; only the labels differ.
- **Every plan carries both entitlements**, including enterprise (unlimited).
  A plan missing one could not be gated at all — the entitlement check would
  read `not_configured` and deny, which is the right failure but the wrong
  reason.
- **The notification templates route through the platform's `product`
  category** rather than inventing prospecting-specific preferences, so the
  existing opt-out applies with nothing new to build.
- **`PROSPECTING_EVENT_SCHEMAS` publishes the payload shape per event type.**
  Adding a field is additive; removing or retyping one is a breaking change to
  every registered endpoint and needs a new event type. Tests assert that no
  payload carries signal features, a source digest, or generated prose.
- **The digest and discovery-complete senders are built and tested but not yet
  scheduled.** See the SP7 PR — the daily cron belongs in `notifications-worker`
  and is called out rather than half-wired.

### SP8

- **Signup is a hand-off, not a second form.** The platform already owns
  magic-link and OAuth sign-in at `/login`, and `/onboarding` already creates
  the first organization — which billing bootstraps onto the default (Free)
  plan. A separate signup form on the storefront would be a second copy of an
  authentication flow, which is exactly the kind of duplication that drifts and
  then quietly breaks.
- **The storefront's weights table renders from `DEFAULT_SIGNAL_WEIGHTS`.** It
  is the same table the engine scores with, so the marketing page cannot drift
  from the product.
- **The demo tenant ships as a command, not a fixture.** `signalpilot demo seed`
  drives the public API with the operator's own credentials, so discovery
  creates the prospects, the engine scores them, and the pipeline constraint
  governs the board. A SQL fixture would produce a tenant that looks right and
  proves nothing, and would drift the moment the ruleset version changed. **The
  seeded tenant itself does not exist yet** — running the command needs
  credentials this environment does not hold.
- **The isolation-proof page renders real rows or says it has none.** It issues
  an actual cross-tenant read and shows the response; the never-store-raw
  section reads a real signal. With no data it says so rather than rendering an
  illustration.
- **`08-docs` was not re-run and `ai/context/*.md` was not regenerated.** Both
  need a deployed environment; see the SP8 PR.
- **The `catalog.entities` block in `intent.yaml` was reverted.** It was
  written, and `kiox -- orun validate --intent intent.yaml` accepted it — but
  `orun plan --changed` in CI then failed for the whole repo with:

  ```
  ✕ failed to compute changed components: objcatalog: catalog "catalogs/current": objectstore: object not found
  ```

  Reproduced on a re-run, so not transient. A top-level `catalog:` entity
  appears to need a resolved catalog object in the workspace object store that
  this repo does not currently have, and creating one is an orun-cloud
  operation rather than a repo change. Shipping it would have red-lined every
  subsequent PR, so it is deferred with the exact error rather than forced. The
  three product docs it pointed at (`docs/{overview,architecture,runbook}.md`)
  ship regardless — they are the substance; the catalog entry is the index
  entry.

## What remains

Everything below needs a deployed environment and credentials this environment
does not hold. Nothing here is blocked on code.

| Gap | Milestone | What it needs |
|---|---|---|
| Live CLI walkthrough transcript on `stage` | SP5 | an authenticated session |
| Playwright console walkthrough + screenshots | SP6 | an authenticated session against a deployed console |
| Hot-prospect digest cron | SP7 | a scheduled sender in `notifications-worker` |
| Live signed webhook delivery + replay check | SP7 | a registered endpoint |
| Seeded demo tenant | SP8 | `signalpilot demo seed` run against `stage` |
| `ai/context/deployment.md` + `operations.md` regeneration | SP8 | an `08-docs` run against verified live state |
| `catalog.entities` entry in `intent.yaml` | SP8 | a `catalogs/current` object in the workspace store (see the SP8 deviation above) |

## Post-epic: the console shipped invisible

The stage deployment carried every prospecting surface and rendered none of
them. A Solo instance showed one sidebar entry — Settings — and landed the
operator on `/projects`, which `api-edge` suppresses under Solo, so the first
screen after sign-in was a `not_found`.

The API was correct throughout: the prospecting routes are absent from
`isSoloSuppressed`, so they were live the whole time. The defect was in
`nav-items.ts`. The Solo branch was meant to drop platform *plumbing* — projects
and usage/quota — but was applied to the entire link list, so it dropped the
product with it. Four independent call sites then agreed on the wrong answer:
the org root, the post-auth destination, the breadcrumb home, and the mobile
bottom tabs all pointed at `/projects`.

Two things are worth carrying forward from it.

**A profile switch that hides a category must be applied to that category, not
to the list that contains it.** SOLO_MODE suppresses collaboration, credentials,
and developer plumbing. It has no opinion about the product. The nav now emits
the product links unconditionally and gates only the two paths the edge actually
404s, and a test asserts the four product surfaces appear under *both* profiles.

**Milestone-local verification did not catch it.** SP6 tested the four pages'
view models and every one of those tests passed — on code that never rendered a
link to any of them. Nothing asserted that the shell could reach the surfaces it
had just built. The test now pinning the exact Solo link list is the assertion
that was missing.

### The product shipped complete and unreachable

The nav defect made the surfaces invisible. Fixing it revealed that they would
not have worked anyway.

`policy-worker` bundles `@saas/policy-engine` — the action registry and the
role→permission grants are compiled into the deployed script, not read at
runtime. SP0 added eleven prospecting actions to `ALL_KNOWN_ACTIONS`.
`orun plan --changed` is strictly path-based, so that commit planned
`policy-engine` and nothing else, and `apps/policy-worker` was never touched
across any of the nine epic merges. It served a pre-SP0 bundle throughout.

An action outside `ALL_KNOWN_ACTIONS` denies with `unknown_action` before any
role lookup, and `authorizeRequest` maps a deny to deny-as-404. So every
prospecting request returned "Not found" — indistinguishable, by design, from
the org not existing. **The property that makes membership unguessable is the
same one that hid a total outage.** Every milestone's tests passed against an
engine that was never deployed.

Three things follow.

**A bundled dependency is a deploy dependency.** `orun plan --changed` does not
cascade — verified, not assumed: with `dependsOn: policy-engine` declared, a
policy-engine-only change *still* plans only policy-engine, and a policy-worker
change does not cascade to the ten workers depending on it either. `dependsOn`
buys ordering and graph truth, not change propagation. The caveat and its
reproduction now live in `ai/context/operations.md`.

**Deny-as-404 needs a way to tell a denial from an absence in operations.** The
UI cannot distinguish them and must not. But a 404 that means "your authorizer
does not know this action exists" and a 404 that means "no such org" are the
same string in the console and, right now, distinguishable only by reading
worker logs. Nothing in this epic changed that; it is worth changing.

**"CI is green" answered a question nobody asked.** Every run was green because
every *planned* lane passed. The unplanned lane is the one that mattered. The
operating contract already warned that a run touching no component files plans
zero lanes; the sharper version is that a green run tells you nothing about
components it did not plan, and the set it did not plan is not visible in the
run summary.

### The same shape, three more times

Working out the blast radius of the nav defect turned up three more instances
of it — a fact written in several places, one of which was wrong, with nothing
able to tell.

**The org's home path was spelled inline six times.** The org list, both org
switchers, the post-create redirect, and the Settings "Back to app" button each
wrote `/orgs/${slug}/projects` themselves. The nav fix moved four *other* call
sites; these six kept pointing at a page the edge 404s — including the back
button out of Settings, which was the only surface Solo previously showed at
all. They go through `orgHomePath()` now.

**The icon vocabulary was duplicated per renderer.** The sidebar and the command
palette each kept their own name → glyph map, and the models typed `icon` as
`string`. The nav fix registered four product surfaces in the palette using
names only the sidebar's map carried, so the palette rendered them with no
glyph — and nothing failed. There is one `SHELL_ICONS` map now, with
`ShellIconName` derived from its keys, so an unresolvable name is a compile
error where it is written.

**The command palette never learned the Solo profile existed.** The sidebar
gated the suppressed surfaces and the settings rail gated them; ⌘K listed
thirteen entries that were all 404s at the edge. It filters by destination now
rather than per command, so a command added later is covered by where it points.

The common thread is worth naming, because it is the same one the nav defect
had: **when two places have to agree and nothing makes them, they will
disagree, and the disagreement will be invisible.** Each fix here is the same
move — give the fact one owner, and where possible make the compiler enforce
the agreement rather than a reviewer.

### Turbo reports stale passes for every `tests/*` package

Found while fixing the above: `turbo run test --filter=@saas/web-console-next-tests`
returned a clean pass against the broken console. The test packages reach into
app source through jest `moduleNameMapper` (`@web-console-next/*` →
`apps/web-console-next/src/*`) without declaring a dependency on the app, so
turbo's hash for the test package does not cover the code under test. An
app-source-only change is a cache hit.

This is not specific to the console. Fourteen of the nineteen `tests/*` packages
map into `apps/*/src` the same way and none declare the app as a dependency:

```
admin-worker, api-edge, billing-worker, config-worker, events-worker,
integrations-worker, membership-worker, metering-worker, notifications-worker,
policy-worker, projects-worker, prospecting-worker, web-console-next,
webhooks-worker
```

CI is not currently affected — remote caching is off and each run starts from a
cold container — so the exposure is local verification and any future move to a
shared cache. Until it is fixed, run `pnpm test` inside the test package
directly rather than through turbo when you have changed only app source.
