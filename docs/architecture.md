# SignalPilot — architecture

## Shape

One new bounded context on an existing multi-tenant platform. Identity,
organizations, RBAC, audit, entitlements, metering, billing, notifications,
webhooks, the console shell, CI/CD, IaC, and migrations were already live; the
product is one worker, three migrations, one contracts module, one edge facade,
four console routes, and a test package.

```
                    ┌──────────────┐
   browser  ───────▶│   api-edge   │  auth, idempotency, rate limits
                    └──────┬───────┘
                           │ service bindings
        ┌──────────────────┼──────────────────┐
        ▼                  ▼                  ▼
 prospecting-worker   membership/policy   billing/metering
        │
        ▼
  Postgres schema `prospecting` (via Hyperdrive)
```

## Why one worker, not two

The obvious split is a discovery worker and a scoring worker. Rejected:
discovery, signals, scores, insights, and pipeline entries all hang off the
same prospect aggregate. Splitting them puts either a cross-worker join or a
shared schema on the hot path, and shared schema ownership violates the
platform's bounded-context rule — one schema, one owner.

The seam that matters is not a deployable boundary. It is `engine/`.

## The `engine/` seam

```
src/
  handlers/    I/O, authorization, persistence
  adapters/    discovery sources behind one interface
  model/       the LLM adapter behind one interface
  engine/      pure domain logic — no clock, no network, no database
    scoring.ts     rules, weights, band thresholds
    dedupe.ts      identity resolution
    guardrail.ts   insight validation
    discovery-run.ts  the orchestration of a run
```

Scoring, dedupe, and the guardrail are pure functions over plain data. The
reference time is a parameter, not `new Date()`. That is not stylistic: the
moment scoring reads a clock or a database, *"the engine decided, not the rep"*
stops being auditable. All three are exhaustively unit-tested with no
infrastructure at all.

## Data model

Three migrations, schema `prospecting`, every table carrying `org_id`, no
cross-context foreign keys (`org_id` and `user_id` are opaque UUIDs owned by
`membership` and `identity`).

| Table | The constraint that carries the design |
|---|---|
| `prospects` | `UNIQUE (org_id, dedupe_key)` — the uniqueness constraint *is* the dedupe mechanism, so a re-run is an upsert |
| `signals` | `source_digest` is `CHECK (~ '^[0-9a-f]{64}$')` — a payload cannot be stored there |
| `discovery_runs` | per-counter partial-failure state, so a run that died at 60 of 100 is still legible |
| `scoring_profiles` | partial unique on `(org_id) WHERE is_active` — append-only, one active version |
| `scores` | append-only; carries `ruleset_version`, `profile_version`, `contributions`, `signal_ids` |
| `insights` | `UNIQUE (org_id, input_digest)` — the cache key, so a replay is free |
| `pipeline_entries` | partial unique on `(org_id, prospect_id) WHERE closed_at IS NULL` — one open entry per prospect |
| `activities` | append-only timeline |

## Two adapter interfaces

**`DiscoveryAdapter`** — `search()` yields candidates, `observe()` yields signal
drafts. `requiresConnection` is on the interface from day one so a credentialed
provider brokered through `integrations-worker` lands additively. v1 ships
`synthetic` (a deterministic corpus) and `web-signals` (one bounded, timed-out,
size-capped fetch per candidate).

The payload is dropped *inside* `observe()`, where the fetch happened. Nothing
downstream has to remember to discard it, because nothing downstream sees it —
and the persistence boundary re-checks the contract's invariants anyway, so a
third-party adapter that ignores the interface has its signals rejected.

**`ModelAdapter`** — one method, `generate()`. `anthropic.ts` calls the Claude
Messages API when a credential is configured; `template.ts` is a deterministic
writer used in tests and in environments with no key. Swapping providers is a
binding change, not a code change.

## The order that makes insights safe

```
read score → digest → cache lookup → entitlement gate → model call
           → guardrail → store → meter
```

The cache lookup precedes the gate: replaying a generation the tenant already
paid for must not consume a second credit. The gate precedes the model call: a
tenant at their limit never triggers a provider request. The meter comes last:
only a generation that survived the guardrail and reached the database is
billable.

## Boundaries

Cross-context calls go over service bindings. `prospecting-worker` reads
membership and policy for every request (deny-as-404), checks entitlements
through `billing-worker`'s internal seam, and records usage through a
service-binding-only route on `metering-worker`. Domain events are written to
the `events` schema in the same transaction as the mutation that caused them,
so the audit trail is a consequence of the write rather than a side channel
that can fall behind.
