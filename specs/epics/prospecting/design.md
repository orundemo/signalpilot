# prospecting — Design

Status: Ready for implementation. This is the technical design for the
`prospecting` product bounded context.

## 1. The shape of the problem

The originating brief asks for a B2B SaaS that "helps web agencies and
freelancers discover potential customers by analysing business signals and
generating outreach suggestions", with auth, discovery, opportunity scoring,
AI-generated insights, and pipeline management.

Decomposed, that is five verbs — **discover, observe, score, explain, work** —
and exactly one of them is novel to this repository:

| Verb | Meaning | Owner |
|------|---------|-------|
| Discover | given a query (geography, industry, size), produce candidate businesses | **new** |
| Observe | for a candidate, derive objective, checkable weaknesses (no TLS, slow page, no booking flow) | **new** |
| Score | turn observations into a defensible number with a reason for each point | **new** |
| Explain | turn the score into prose a salesperson can send | **new** (thin — LLM behind guardrails) |
| Work | assign, stage, note, and close | **new** (thin — CRUD over the platform's tenancy) |
| *Everything else* | tenancy, identity, RBAC, entitlements, audit, billing, email, webhooks, console | **already live** |

The product's credibility rests on the middle three. A prospecting tool that
returns a list of businesses with a mystery number attached is indistinguishable
from a spreadsheet. One that says *"82 — no HTTPS (25), LCP 6.4s (20), no
booking flow (20), last content change 14 months ago (12), 9 reviews (5)"* is a
different product, and the difference is entirely in the data model.

So this design optimises for one property above all: **every number is
reproducible and attributable.** Scores are append-only, carry the version of
the rules and the version of the weights that produced them, and store their
per-rule contributions. Nothing recomputes silently.

## 2. Bounded context: `prospecting`

One new Cloudflare Worker, `apps/prospecting-worker`, owning one Postgres
schema (`prospecting`). It mirrors the `projects-worker` anatomy exactly:

```
apps/prospecting-worker/
  component.yaml            spec.type: cloudflare-worker-turbo
                            dependsOn: [membership-worker, policy-worker,
                                        billing-worker, metering-worker,
                                        events-worker, notifications-worker]
                            providesApis: [prospecting-api]
                            consumesApis: [membership-api, policy-api,
                                           billing-api, metering-api,
                                           events-api, notifications-api]
                            subscribe.environments: dev/stage/prod, profile: verify
                            profileRules: profile deploy when triggerRef github-push-main
  wrangler.template.jsonc
  wiring.fixture.json
  src/
    index.ts                entry
    router.ts               regex router: /v1/organizations/:orgId/<resource>
    env.ts  http.ts  ids.ts  pagination.ts
    membership-client.ts    org/member resolution
    policy-client.ts        deny-by-default action checks
    billing-client.ts       entitlement gate (mirrors projects-worker)
    metering-client.ts      usage records
    events-client.ts        domain event emission
    handlers/*.ts           one file per operation
    adapters/*.ts           discovery source adapters behind one interface
    engine/                 pure domain logic, no I/O — the testable core
      scoring.ts            rules, weights, band thresholds
      dedupe.ts             identity resolution keys
      guardrail.ts          insight validation
tests/prospecting-worker/   contract + verifier suites
```

**Why one worker and not two.** The brief's shape suggests a `discovery-worker`
and a `scoring-worker`. Rejected: discovery, signals, scores, insights, and
pipeline entries all hang off the *same* prospect aggregate. Splitting them
puts either a cross-worker join or a shared schema on the hot path, and shared
schema ownership violates the platform's bounded-context rule (one schema, one
owner). The internal seam that matters — pure engine vs I/O — is enforced by
the `engine/` directory, not by a second deployable.

Novel to this context is the **scoring engine**: pure, dependency-free,
exhaustively unit-tested without a database. It is the one piece of real domain
IP, so it is isolated from I/O in the same way `matchmaker`'s draft engine is
in the reference product.

## 3. Data model

Three migrations, schema `prospecting`. The repo's last platform migration is
`190_integrations_delivery_attribution`, so the product context starts at `200`.
Every table carries `org_id`; every query filters on it; no cross-context
foreign keys (`org_id` and `user_id` are opaque UUIDs owned by `membership`
and `identity`).

### `200_prospecting_core`

#### `prospecting.prospects` — the business record

| Column | Type | Notes |
|--------|------|-------|
| `id` | `UUID` PK | surfaced as `prs_<hex>` |
| `org_id` | `UUID NOT NULL` | tenant key |
| `name` | `TEXT NOT NULL` | business display name |
| `domain` | `TEXT` | normalised registrable domain, null when none found |
| `dedupe_key` | `TEXT NOT NULL` | derived identity key — see §4.3 |
| `industry` | `TEXT` | free text from the source, normalised |
| `locality` / `region` / `country` | `TEXT` | coarse location only |
| `size_band` | `TEXT` | `CHECK IN ('micro','small','medium','large','unknown')` |
| `source` | `TEXT NOT NULL` | adapter id that first produced this record |
| `source_ref` | `TEXT` | adapter-local identifier, for re-fetch |
| `status` | `TEXT NOT NULL DEFAULT 'active'` | `CHECK IN ('active','archived')` — soft delete |
| `first_seen_at` / `last_enriched_at` | `TIMESTAMPTZ` | |
| `created_at` / `updated_at` / `archived_at` | `TIMESTAMPTZ` | |

Unique: `(org_id, dedupe_key)`. Index `(org_id, created_at DESC, id DESC)`
partial `WHERE status='active'` for keyset pagination.

The uniqueness constraint is the dedupe mechanism: re-running a discovery that
overlaps a previous one is an upsert, not a duplicate. Prospects are **per
org** by design — two agencies discovering the same bakery each own their own
record, their own signals, and their own pipeline position. There is no shared
global business graph, and therefore no cross-tenant leakage surface.

#### `prospecting.signals` — observations about a prospect

| Column | Type | Notes |
|--------|------|-------|
| `id` | `UUID` PK | `sig_<hex>` |
| `org_id` | `UUID NOT NULL` | tenant key |
| `prospect_id` | `UUID NOT NULL` | in-context FK |
| `kind` | `TEXT NOT NULL` | one of the catalog in §5.1 |
| `severity` | `SMALLINT NOT NULL` | 1–5, adapter-assigned |
| `features` | `JSONB NOT NULL` | **derived** values only (`{"lcp_ms":6400,"bucket":"poor"}`) |
| `source_digest` | `TEXT NOT NULL` | sha256 of the payload the observation was derived from |
| `observed_at` | `TIMESTAMPTZ NOT NULL` | |
| `expires_at` | `TIMESTAMPTZ` | staleness horizon; a signal past it is ignored by scoring |

Unique: `(org_id, prospect_id, kind, observed_at)`. Index
`(org_id, prospect_id, observed_at DESC)`.

**The never-store-raw rule.** `features` holds numbers and enums the scoring
engine consumes. The fetched HTML, the provider JSON, and any contact details
are consumed in-request and dropped. `source_digest` proves *which* payload the
derivation came from without retaining it. This is a hard constraint, not a
preference: it caps the product's data-protection exposure to business records
that are already public, and it is a demonstrable claim (§10).

#### `prospecting.discovery_runs` — a unit of metered work

| Column | Type | Notes |
|--------|------|-------|
| `id` | `UUID` PK | `dsc_<hex>` |
| `org_id` | `UUID NOT NULL` | |
| `requested_by` | `UUID NOT NULL` | user id |
| `adapter` | `TEXT NOT NULL` | source adapter id |
| `query` | `JSONB NOT NULL` | the normalised query (location, industry, size, limit) |
| `status` | `TEXT NOT NULL DEFAULT 'running'` | `CHECK IN ('running','completed','failed','cancelled')` |
| `candidates_found` / `prospects_created` / `prospects_updated` / `signals_recorded` | `INT NOT NULL DEFAULT 0` | |
| `error_code` | `TEXT` | null on success |
| `started_at` / `finished_at` | `TIMESTAMPTZ` | |

Index `(org_id, started_at DESC, id DESC)`.

### `210_prospecting_scoring`

#### `prospecting.scoring_profiles` — per-org weights

| Column | Type | Notes |
|--------|------|-------|
| `id` | `UUID` PK | `spf_<hex>` |
| `org_id` | `UUID NOT NULL` | |
| `version` | `INT NOT NULL` | monotonic per org |
| `ruleset_version` | `INT NOT NULL` | the code ruleset this profile targets |
| `weights` | `JSONB NOT NULL` | `{signal_kind: points}` overrides |
| `is_active` | `BOOLEAN NOT NULL DEFAULT true` | one active row per org |
| `created_by` / `created_at` | | |

Partial unique: `(org_id) WHERE is_active`. Editing weights inserts a new
version and deactivates the previous one — profiles are append-only so an old
score remains explainable after a weight change.

#### `prospecting.scores` — append-only, explainable

| Column | Type | Notes |
|--------|------|-------|
| `id` | `UUID` PK | `scr_<hex>` |
| `org_id` | `UUID NOT NULL` | |
| `prospect_id` | `UUID NOT NULL` | |
| `score` | `SMALLINT NOT NULL` | 0–100 |
| `band` | `TEXT NOT NULL` | `CHECK IN ('hot','warm','cold')` |
| `ruleset_version` | `INT NOT NULL` | code version |
| `profile_version` | `INT NOT NULL` | weights version |
| `contributions` | `JSONB NOT NULL` | ordered `[{kind, points, reason, features}]` |
| `signal_ids` | `UUID[] NOT NULL` | exactly the signals considered |
| `computed_at` | `TIMESTAMPTZ NOT NULL` | |

Index `(org_id, prospect_id, computed_at DESC)`; index
`(org_id, band, score DESC)` for the prospects board.

**Never updated.** A rescore inserts a row. The current score is the newest row
per prospect; history is free, and "why did this drop from 82 to 61" is
answerable by diffing two rows.

#### `prospecting.insights` — generated prose

| Column | Type | Notes |
|--------|------|-------|
| `id` | `UUID` PK | `ins_<hex>` |
| `org_id` | `UUID NOT NULL` | |
| `prospect_id` | `UUID NOT NULL` | |
| `score_id` | `UUID NOT NULL` | the score this explains |
| `kind` | `TEXT NOT NULL` | `CHECK IN ('prospect_summary','outreach_email')` |
| `content` | `TEXT NOT NULL` | the generated text |
| `model` / `prompt_version` | `TEXT` / `INT` | provenance |
| `input_digest` | `TEXT NOT NULL` | sha256 cache key — see §6.2 |
| `guardrail_verdict` | `TEXT NOT NULL` | `CHECK IN ('pass','revised','blocked')` |
| `guardrail_notes` | `JSONB` | which checks fired |
| `generated_by` / `created_at` | | |

Unique: `(org_id, input_digest)`. Index `(org_id, prospect_id, created_at DESC)`.

### `220_prospecting_pipeline`

#### `prospecting.pipeline_stages`

| Column | Type | Notes |
|--------|------|-------|
| `id` | `UUID` PK | `stg_<hex>` |
| `org_id` | `UUID NOT NULL` | |
| `key` | `TEXT NOT NULL` | stable slug |
| `label` | `TEXT NOT NULL` | |
| `position` | `SMALLINT NOT NULL` | ordering |
| `outcome` | `TEXT NOT NULL DEFAULT 'open'` | `CHECK IN ('open','won','lost')` |

Unique `(org_id, key)` and `(org_id, position)`. Seeded on first use with
`new → contacted → replied → meeting → won / lost`.

#### `prospecting.pipeline_entries`

| Column | Type | Notes |
|--------|------|-------|
| `id` | `UUID` PK | `pen_<hex>` |
| `org_id` | `UUID NOT NULL` | |
| `prospect_id` | `UUID NOT NULL` | |
| `stage_id` | `UUID NOT NULL` | |
| `owner_user_id` | `UUID` | assignee, nullable |
| `value_cents` | `BIGINT` | estimated deal value, single currency in v1 |
| `entered_stage_at` | `TIMESTAMPTZ NOT NULL` | reset on every move — this is what makes "stuck in stage" a query |
| `closed_at` | `TIMESTAMPTZ` | set when the stage outcome is terminal |

Partial unique `(org_id, prospect_id) WHERE closed_at IS NULL`. Index
`(org_id, stage_id, entered_stage_at)`.

#### `prospecting.activities` — append-only timeline

| Column | Type | Notes |
|--------|------|-------|
| `id` | `UUID` PK | `act_<hex>` |
| `org_id` | `UUID NOT NULL` | |
| `prospect_id` | `UUID NOT NULL` | |
| `kind` | `TEXT NOT NULL` | `note`, `stage_change`, `owner_change`, `insight_generated`, `rescored`, `discovered` |
| `actor_user_id` | `UUID` | null for system-generated |
| `body` | `TEXT` | free text for `note` |
| `metadata` | `JSONB` | typed payload per kind |
| `created_at` | `TIMESTAMPTZ NOT NULL` | |

Index `(org_id, prospect_id, created_at DESC)`.

Each migration adds one entry to `packages/db/src/manifest.ts` (id, context
`prospecting`, path, sha256, description). The runner refuses an unlisted or
drifted file — the checksum is not optional.

## 4. Discovery

### 4.1 The adapter interface

```ts
export interface DiscoveryAdapter {
  readonly id: string;
  readonly requiresConnection: boolean;
  search(query: NormalisedQuery, ctx: AdapterContext): AsyncIterable<Candidate>;
  observe(candidate: Candidate, ctx: AdapterContext): Promise<SignalDraft[]>;
}
```

`Candidate` is a business record; `SignalDraft` is `{kind, severity, features,
sourceDigest}`. An adapter never returns raw payloads across this boundary —
the drop happens inside the adapter, which is where the fetch happened.

v1 ships two adapters, both credential-free:

- **`synthetic`** — deterministic generated businesses from a seeded corpus.
  Powers the demo tenant and every test; produces a realistic signal mix.
- **`web-signals`** — takes a domain and derives observations from a single
  bounded fetch (TLS validity, response timing bucket, viewport meta, presence
  of booking/analytics markers, last-modified age). Rate-limited, batched, and
  respectful of `robots.txt`; a fetch failure is a *missing* signal, never a
  fabricated one.

Credentialed providers (business-directory and firmographic APIs) are a named
follow-on: they bind through `integrations-worker` connections so tokens are
brokered per-run rather than held by this worker. `requiresConnection` exists
in the interface from day one so that landing is additive.

### 4.2 The run

`POST /v1/organizations/:orgId/discoveries` is the only expensive endpoint in
the product, and the only one that writes on behalf of a batch. Sequence:

1. `fetchAuthorizationContext` → membership context
2. `authorizeViaPolicy('organization.discovery.run')` → deny-as-404
3. `billing-client.checkEntitlement('prospecting.discovery')` → 402 with a
   typed `quota_exhausted` error when the plan's monthly allowance is spent
4. insert `discovery_runs` row (`status='running'`), return `202` with the run id
5. adapter `search` → for each candidate: dedupe → upsert prospect → `observe`
   → insert signals → score (§5) → update run counters
6. record usage to `metering-worker` (`prospecting.prospects.discovered`,
   quantity = prospects created)
7. `status='completed'`, emit `prospecting.discovery.completed`

Steps 5–7 run in `ctx.waitUntil` past the 202; the console polls the run.
Partial failure is a first-class outcome: a run that produced 60 of 100
candidates before an adapter error completes with `status='failed'`, the
counters it did achieve, and an `error_code`. Prospects already written are
kept — discovery is idempotent by dedupe key, so a retry converges.

Metering is recorded on **created prospects, not candidates examined**, so the
number the client is billed for is the number they can see in the UI. Anything
else invites a support argument.

### 4.3 Identity resolution

`dedupe_key` is computed by the pure `engine/dedupe.ts`:

1. if a registrable domain is present → `d:<normalised-domain>`
2. else → `n:<slug(name)>|<country>|<locality>`

Conservative on purpose. Merging two distinct businesses is worse than showing
two rows for one business: a false merge silently destroys pipeline state, a
false split is a visible annoyance the user can archive. A manual merge
endpoint is a named follow-on, not a v1 heuristic.

## 5. Scoring

### 5.1 The signal catalog (ruleset v1)

| Kind | What it means | Default points |
|------|---------------|----------------|
| `site_missing` | no working website found | 30 |
| `tls_missing` | no valid HTTPS | 25 |
| `perf_poor` | slow largest-contentful-paint bucket | 20 |
| `mobile_unfriendly` | no viewport meta / fixed-width layout | 18 |
| `booking_absent` | no booking, scheduling, or contact-form flow | 20 |
| `analytics_absent` | no analytics or tag manager present | 8 |
| `content_stale` | last content change older than 12 months | 12 |
| `reviews_thin` | public review count below the industry floor | 5 |

Points are the *default weights*; an org's active `scoring_profile` may
override any of them. The catalog itself is code — adding a kind is a ruleset
version bump, which is a code change with a migration-free deploy.

### 5.2 The engine

`engine/scoring.ts` is pure: `(signals, profile) => ScoreResult`. No clock, no
randomness, no I/O.

1. drop signals past `expires_at`
2. for each remaining kind, take the most recent signal
3. `points = weight(kind) × severityFactor(severity)` where `severityFactor`
   maps 1–5 onto `0.4 … 1.0`
4. `raw = Σ points`; `score = min(100, round(raw))`
5. `band = score ≥ 70 ? 'hot' : score ≥ 40 ? 'warm' : 'cold'`
6. emit a `contributions` entry per kind with the points, the human reason
   string, and the features that produced it

Deterministic by construction: the same signals and the same profile always
produce the same score, which is what makes "the engine decided, not the rep"
an auditable claim rather than a slogan.

Scoring runs automatically at the end of discovery and on demand via
`POST /prospects/:id/rescore`. A weight-profile change does **not** silently
rescore the corpus — it offers a bulk rescore action, so a manager cannot
accidentally rewrite every number on the board mid-quarter.

## 6. Insights

### 6.1 The guardrail

The LLM writes two things: a short prospect summary, and a first-touch outreach
email. It is given the business record, the current score, and the
contributions — and nothing else. Every generation passes through
`engine/guardrail.ts` before it is stored:

| Check | Rule |
|-------|------|
| Grounding | every factual claim maps to a signal kind present in the input; unmapped claims are stripped |
| No score talk | the generated text may not assert a different number than the score row |
| No fabricated contacts | no names, emails, or phone numbers may appear that were not in the input |
| Bounds | length, tone, and a banned-phrase list (no fake urgency, no invented client references) |

Verdict is stored: `pass` (unchanged), `revised` (checks stripped content), or
`blocked` (unsalvageable — no content stored, the request returns a typed
error and is **not** billed). The verdict is visible in the console next to the
draft. A model that quietly hallucinates is a liability; a model whose edits
are shown is a feature.

### 6.2 Caching and metering

`input_digest = sha256(kind ‖ prompt_version ‖ score_id ‖ contributions)`. A
repeat request for an unchanged prospect returns the cached row and is **not**
metered. Regeneration after a rescore is a genuine new generation, and is
metered. `POST /prospects/:id/insights` gates on
`billing-client.checkEntitlement('prospecting.insight')` before the model call,
never after.

The model provider sits behind a single adapter with the credential resolved
from environment configuration, so swapping providers is a binding change, not
a code change.

## 7. API surface

All routes under `/v1/organizations/:orgId/`, all behind the standard
three-step gate (`fetchAuthorizationContext` → `authorizeViaPolicy` → read/write)
with the platform's **deny-as-404** convention.

| Method | Path | Action |
|--------|------|--------|
| `POST` | `/discoveries` | `organization.discovery.run` |
| `GET` | `/discoveries`, `/discoveries/:id` | `organization.discovery.read` |
| `GET` | `/prospects`, `/prospects/:id` | `organization.prospect.read` |
| `POST` | `/prospects` | `organization.prospect.write` (manual add) |
| `PATCH` | `/prospects/:id` | `organization.prospect.write` |
| `POST` | `/prospects/:id/archive` | `organization.prospect.archive` |
| `GET` | `/prospects/:id/signals` | `organization.prospect.read` |
| `POST` | `/prospects/:id/rescore` | `organization.prospect.write` |
| `GET` | `/prospects/:id/scores` | `organization.prospect.read` |
| `POST` | `/prospects/:id/insights` | `organization.insight.generate` |
| `GET` | `/prospects/:id/insights` | `organization.insight.read` |
| `GET` | `/prospects/:id/activities`, `POST` same | `organization.prospect.read` / `.write` |
| `GET` | `/pipeline`, `/pipeline/stages` | `organization.pipeline.read` |
| `PUT` | `/pipeline/stages` | `organization.pipeline.write` |
| `POST` | `/pipeline/entries`, `PATCH /pipeline/entries/:id` | `organization.pipeline.write` |
| `GET` | `/scoring-profile`, `PUT` same | `organization.scoring_profile.read` / `.write` |

List endpoints use the platform's keyset pagination. Mutating endpoints accept
the platform idempotency key at the edge.

**Edge.** One new facade, `apps/api-edge/src/prospecting-facade.ts`
(`isProspectingRoute` + `handleProspectingRoute`), registered in the `fetch`
dispatch chain and bound to `PROSPECTING_WORKER`. It follows
`project-facade.ts` to the letter, and adds a stricter rate-limit class for
`POST /discoveries` and `POST /insights` in `rate-limit.ts` — the two endpoints
with real downstream cost.

**SDK and CLI.** `packages/sdk` gains `prospecting.*` methods generated against
the contracts module; `packages/cli` gains `signalpilot prospects`,
`signalpilot discover`, `signalpilot pipeline`, and `signalpilot insights`
command groups. Parity with the API is a completion criterion, not a follow-up:
the CLI walkthrough *is* the stage verification.

## 8. RBAC

New actions registered in `@saas/contracts/policy` (`ORGANIZATION_ACTIONS`) and
`@saas/policy-engine`. An unregistered action denies with `unknown_action`, so
registration is mandatory.

| Action | owner | admin | builder | viewer |
|--------|:-----:|:-----:|:-------:|:------:|
| `organization.prospect.read` | ✓ | ✓ | ✓ | ✓ |
| `organization.prospect.write` | ✓ | ✓ | ✓ | — |
| `organization.prospect.archive` | ✓ | ✓ | ✓ | — |
| `organization.discovery.read` | ✓ | ✓ | ✓ | ✓ |
| `organization.discovery.run` | ✓ | ✓ | ✓ | — |
| `organization.insight.read` | ✓ | ✓ | ✓ | ✓ |
| `organization.insight.generate` | ✓ | ✓ | ✓ | — |
| `organization.pipeline.read` | ✓ | ✓ | ✓ | ✓ |
| `organization.pipeline.write` | ✓ | ✓ | ✓ | — |
| `organization.scoring_profile.read` | ✓ | ✓ | ✓ | ✓ |
| `organization.scoring_profile.write` | ✓ | ✓ | — | — |

Weight tuning is admin-only on purpose: it changes what every number in the
org means.

## 9. Commercial surface

### Meters (`metering-worker`)

| Meter | Unit | Recorded when |
|-------|------|---------------|
| `prospecting.prospects.discovered` | count | a discovery run creates a prospect |
| `prospecting.insights.generated` | count | a generation passes the guardrail and is stored |

### Plans (`billing-worker`, Polar)

| Plan | Discoveries / mo | Insights / mo | Seats |
|------|------------------|---------------|-------|
| Free | 100 | 10 | 1 |
| Starter | 1,000 | 200 | 3 |
| Growth | 10,000 | 2,000 | 10 |

Enforcement is at request time via `billing-client`, mirroring
`projects-worker`. Exhaustion returns a typed `quota_exhausted` error carrying
the meter, the limit, and the reset date — enough for the console to render an
upgrade prompt without a second round trip — and emits
`prospecting.quota.exhausted`.

### Events (`events-worker` audit + `webhooks-worker` delivery)

`prospecting.prospect.created` · `.enriched` · `.scored` · `.archived` ·
`prospecting.discovery.completed` · `prospecting.insight.generated` ·
`prospecting.pipeline.stage_changed` · `prospecting.quota.exhausted`

### Notifications (`notifications-worker`)

- **Hot prospect digest** — daily, per org, listing prospects that entered the
  `hot` band since the last send. Preference-controlled like every other
  template.
- **Discovery complete** — for runs above a size threshold.

## 10. Console

Authed surfaces under `(app)/orgs/[orgSlug]/`, on the existing design system:

| Route | What it is |
|-------|-----------|
| `discover` | query builder (location, industry, size, limit), adapter picker, live run status, remaining quota |
| `prospects` | filterable table (band, signal kind, stage, owner) with a detail drawer whose centrepiece is the **score explainer**: every contribution as a labelled bar with its reason string |
| `pipeline` | kanban across stages, drag to move, owner and value inline, "stuck in stage" highlighting from `entered_stage_at` |
| `insights` | generated summaries and outreach drafts, guardrail verdict badge, copy and regenerate, quota counter |

The existing `usage` and `billing` pages pick up the two new meters with no
change. The existing `audit` page picks up `prospecting.*` events with no
change — that is the payoff of emitting from day one.

**The isolation proof.** The demo tenant ships a short page showing a
cross-tenant read attempt denied and recorded in the audit trail, plus the
stored `features`/`source_digest` pair for one signal next to the statement of
what was dropped. Both claims in this design that a buyer would otherwise have
to take on trust — tenant isolation and never-store-raw — are made clickable.

**Storefront.** A public route group (`src/app/signalpilot/`) with the
marketing surface and self-serve signup into the Free plan, mirroring the
reference product's storefront pattern. It is the only unauthenticated ingress.

## 11. Non-goals (v1)

- **Sending** outreach email, sequences, cadences, or reply detection.
- Two-way CRM sync.
- Contact-level personal data (people, emails, phone numbers) — business
  records only. This is a deliberate exposure cap, not a missing feature.
- Cross-tenant benchmarking or a shared business graph.
- Multi-currency deal values.
- Large-scale crawling; v1 observation is bounded, batched, and per-candidate.
- Automatic bulk rescore on weight change (offered as an explicit action).

## 12. Verification bar

| Layer | How it is verified |
|-------|--------------------|
| `engine/scoring.ts` | unit tests, no DB, no network — including weight-profile overrides, severity mapping, band edges, and expiry filtering |
| `engine/dedupe.ts` | unit tests over a fixture corpus with near-miss names and domain variants |
| `engine/guardrail.ts` | unit tests with adversarial generations (fabricated contact, contradicted score, invented client reference) |
| Worker routes | contract suite in `tests/prospecting-worker`, including deny-as-404 for every action and the 402 quota contract |
| Stage | authenticated CLI walkthrough end to end: discover → inspect signals → explain score → generate insight → move through pipeline → hit the quota |
| Console | authenticated Playwright walkthrough with screenshots |
| Prod | smoke check after promotion |

"Implemented locally" is not a completion state.
