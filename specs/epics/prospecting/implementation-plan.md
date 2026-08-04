# prospecting — Implementation plan

Milestones SP0–SP8. Each is independently shippable and independently
verifiable on `stage`. "Done when" is the acceptance bar; a milestone that
cannot be demonstrated on a deployed environment is not done.

Two estimate columns are given. **Demo** is the flagship demo build (seeded
data, one tenant, enough depth to survive a click-through). **Client** is a
delivered engagement with real providers, real data volumes, and handover
documentation.

| ID | Milestone | Demo | Client |
|----|-----------|------|--------|
| SP0 | Contract + data model | 3 h | 1–2 d |
| SP1 | Discovery | 5 h | 2.5 d |
| SP2 | Scoring | 4 h | 2 d |
| SP3 | Insights | 4 h | 2 d |
| SP4 | Pipeline | 3 h | 1.5 d |
| SP5 | Edge + SDK + CLI | 2 h | 1 d |
| SP6 | Console | 8 h | 4 d |
| SP7 | Commercial | 2 h | 1.5 d |
| SP8 | Storefront + evidence | 3 h | 1.5 d |
| | **Total** | **~4 working days** | **~17 working days** |

---

## SP0 — Contract and data model

**Lands:** `packages/contracts/src/prospecting.ts` (types + validators for
prospects, signals, scores, insights, pipeline, activities, discovery runs,
and the query shape); migrations `200_prospecting_core`,
`210_prospecting_scoring`, `220_prospecting_pipeline` with `up.sql` per
directory; three `packages/db/src/manifest.ts` entries with sha256 checksums;
`packages/db/src/prospecting/` repositories and types; the eleven new actions
registered in `@saas/contracts/policy` and `@saas/policy-engine`; the
`apps/prospecting-worker` component skeleton (`component.yaml`,
`wrangler.template.jsonc`, `wiring.fixture.json`, health route only).

**Done when:**

- `kiox -- orun validate --intent intent.yaml` passes with the new component
  discovered.
- `db-migrate` plans cleanly on the PR and applies on merge; the runner
  accepts all three manifest entries.
- `tests/policy-engine` proves every new action resolves for the role matrix in
  `design.md` §8, and that an unregistered action denies with `unknown_action`.
- The worker deploys to `stage` and answers its health route.
- No existing component's behaviour changes.

---

## SP1 — Discovery

**Lands:** the `DiscoveryAdapter` interface; the `synthetic` and `web-signals`
adapters; `engine/dedupe.ts`; `POST /discoveries` (202 + background
completion), `GET /discoveries`, `GET /discoveries/:id`, `GET /prospects`,
`GET /prospects/:id`, `POST /prospects`, `PATCH /prospects/:id`,
`POST /prospects/:id/archive`, `GET /prospects/:id/signals`; the metering call
on created prospects; `prospecting.discovery.completed` and
`prospecting.prospect.created` events.

**Done when:**

- A discovery run against `synthetic` on `stage` creates prospects with signals
  and returns accurate counters.
- Re-running the same query creates **zero** duplicates and increments
  `prospects_updated` instead.
- `web-signals` derives at least six of the eight catalog kinds against a live
  domain, and a fetch failure yields a *missing* signal rather than a
  fabricated one.
- No raw payload appears in any row: a fixture asserts `features` contains only
  scalars/enums and `source_digest` is a 64-char hex.
- An adapter error mid-run leaves `status='failed'` with the partial counters
  and the prospects already written intact.
- `tests/prospecting-worker` covers deny-as-404 for every route.

---

## SP2 — Scoring

**Lands:** `engine/scoring.ts`; `prospecting.scoring_profiles` read/write
(`GET`/`PUT /scoring-profile`); automatic scoring at the end of a discovery
run; `POST /prospects/:id/rescore`; `GET /prospects/:id/scores`; the bulk
rescore action; `prospecting.prospect.scored` events.

**Done when:**

- The engine is unit-tested with no database and no network: weight overrides,
  severity mapping, band boundaries at 39/40 and 69/70, expiry filtering, and
  the "most recent signal per kind" rule.
- The same corpus scored twice produces byte-identical `contributions`.
- A score row carries `ruleset_version`, `profile_version`, `signal_ids`, and a
  contribution per counted signal.
- Editing weights inserts a new profile version, deactivates the old one, and
  leaves existing scores untouched until a bulk rescore is explicitly run.
- The CLI can print a score with its full explanation.

---

## SP3 — Insights

**Lands:** the model adapter; `engine/guardrail.ts`;
`POST /prospects/:id/insights`, `GET /prospects/:id/insights`; digest caching;
the entitlement gate; `prospecting.insight.generated`.

**Done when:**

- Guardrail unit tests kill an adversarial generation for each of the four
  checks in `design.md` §6.1.
- A `blocked` verdict stores no content, returns a typed error, and is **not**
  metered.
- A repeat request for an unchanged prospect returns the cached row and does
  not call the model or the meter.
- A rescore changes `input_digest`, so regeneration is a genuine new generation.
- The stored row carries `model`, `prompt_version`, `guardrail_verdict`, and
  `guardrail_notes`.
- The entitlement check happens **before** the model call — verified by driving
  a tenant to its limit and asserting no provider request is made.

---

## SP4 — Pipeline

**Lands:** stage seeding; `GET /pipeline`, `GET`/`PUT /pipeline/stages`,
`POST /pipeline/entries`, `PATCH /pipeline/entries/:id`;
`GET`/`POST /prospects/:id/activities`;
`prospecting.pipeline.stage_changed` events; activity rows written for stage
and owner changes, rescores, insight generations, and discoveries.

**Done when:**

- A prospect can be added to the pipeline, assigned, moved, and closed; the
  partial unique constraint prevents a second open entry for the same prospect.
- `entered_stage_at` resets on every move, and "in stage longer than N days" is
  a single query.
- Terminal stages set `closed_at`; a closed prospect can be re-entered.
- The activity timeline reads back in order with typed metadata per kind.

---

## SP5 — Edge, SDK, CLI

**Lands:** `apps/api-edge/src/prospecting-facade.ts` wired into the dispatch
chain and `rate-limit.ts` (stricter class for `POST /discoveries` and
`POST /insights`); `PROSPECTING_WORKER` service binding; `packages/sdk`
`prospecting.*` methods; `packages/cli` `prospects` / `discover` / `pipeline` /
`insights` command groups.

**Done when:**

- Every route in `design.md` §7 is reachable through the public edge with
  tenancy resolution, idempotency, and rate limiting applied.
- The SDK surface is generated against the contracts module — no hand-written
  types that can drift.
- A single authenticated CLI walkthrough on `stage` performs: discover →
  inspect signals → explain score → generate insight → move through pipeline.
  That transcript is the milestone evidence.
- The facade stays under ~100 LOC; anything larger means logic leaked into the
  edge.

---

## SP6 — Console

**Lands:** `(app)/orgs/[orgSlug]/{discover,prospects,pipeline,insights}` on the
existing design system, over the live API via the SDK: query builder with live
run status and remaining quota; prospects table with band/signal/stage/owner
filters and a detail drawer built around the score explainer; kanban with drag,
owner, value, and stuck-in-stage highlighting; insights list with guardrail
verdict badges, copy, and regenerate.

**Done when:**

- Every surface has empty, loading, error, and quota-exhausted states — the
  quota state links to billing.
- The score explainer renders each contribution with its points and reason
  string, plus the ruleset and profile versions that produced it.
- An authenticated Playwright walkthrough passes on `stage` and the screenshots
  are attached to the milestone.
- No console route calls a worker directly; everything goes through the edge.

---

## SP7 — Commercial

**Lands:** the three Polar plans with their allowances; entitlement definitions
for `prospecting.discovery` and `prospecting.insight`; quota enforcement paths
end to end; `prospecting.quota.exhausted`; the two notification templates with
preference wiring; the eight webhook event types published with schemas.

**Done when:**

- A Free tenant driven past 100 discoveries receives the typed
  `quota_exhausted` error carrying meter, limit, and reset date; the console
  renders the upgrade prompt from that payload alone.
- Upgrading the plan restores service without a redeploy.
- The hot-prospect digest sends to a subscribed member and respects an
  unsubscribe.
- A registered webhook endpoint receives a signed `prospecting.prospect.scored`
  delivery and it appears in the delivery log with replay available.
- `usage` and `billing` console pages show the two meters with no page-specific
  code.

---

## SP8 — Storefront and evidence

**Lands:** `src/app/signalpilot/` public marketing route group and self-serve
signup into Free; the seeded demo tenant (~200 synthetic businesses across a
realistic signal mix, scored, ~40 in pipeline across stages, at least one
`hot` prospect with a generated outreach draft); the isolation-proof page;
`docs/{overview,architecture,runbook}.md`; `catalog.entities` enrichment in
`intent.yaml`; an `08-docs` re-run.

**Done when:**

- `https://signalpilot.orun.dev` serves the storefront, and self-serve signup
  produces a working Free tenant.
- The demo login lands on a board that is immediately legible: hot prospects
  visible above the fold, one score explainer worth reading, one outreach draft
  worth sending.
- The isolation-proof page shows a denied cross-tenant read in the audit trail
  and one signal's stored derived features next to what was dropped.
- `ai/context/deployment.md` and `ai/context/operations.md` are regenerated
  against verified live state.
- **`docs/overview.md` is read with fresh eyes and describes *this* product** —
  the known failure mode is docs that were rebranded independently of the
  domain, and shipping that to a buyer costs exactly the credibility the docs
  were meant to buy.

---

## Sequencing notes

- SP0 blocks everything. SP1→SP2→SP3 is a hard chain (signals feed scores feed
  insights). SP4 is independent of SP2/SP3 and can run in parallel.
- SP5 can start once SP1 lands and grows with each subsequent milestone; do not
  defer it to the end, because the CLI walkthrough is the verification
  mechanism for SP1–SP4.
- SP6 needs SP5's SDK surface.
- SP7 and SP8 are the last two and are where a rushed build shows: quota
  behaviour and seeded data are what a buyer clicks first.
- **Never** hand-deploy. A `wrangler deploy` or `terraform apply` by hand is
  drift the next plan will fight.
