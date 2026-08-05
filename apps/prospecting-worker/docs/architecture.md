# prospecting-worker — architecture

A `cloudflare-worker-turbo` component: TypeScript Worker built by the turbo
pipeline from `apps/prospecting-worker`, deployed per environment by its CI
lane.

## Bindings and wiring

- **Service bindings** → `membership-worker`, `policy-worker`,
  `billing-worker`, `metering-worker` — in-process RPC to sibling Workers; no
  public hops between contexts.
- **Hyperdrive** → `PLATFORM_DB`, pooled Postgres for the `prospecting` schema.
- **Wired configuration** (resolved at deploy time from job-output secrets
  published by the infrastructure terraform; names only):
  `WIRING_CLOUDFLARE_HYPERDRIVE_PROD`, `WIRING_CLOUDFLARE_HYPERDRIVE_STAGE`.

## Internal seam

```
src/
  index.ts       entry
  router.ts      regex router: /v1/organizations/:orgId/<resource>
  env.ts  http.ts  ids.ts  pagination.ts
  handlers/      one file per operation — I/O, authorization, persistence
  adapters/      discovery source adapters behind one interface
  engine/        pure domain logic, no I/O — the testable core
```

`engine/` is the seam that matters. Scoring, dedupe, and the insight guardrail
are pure functions over plain data: no clock, no randomness, no network, no
database. They are unit-tested exhaustively without any infrastructure, which
is what makes "the engine decided, not the rep" an auditable claim rather than
a slogan.

## Why one worker and not two

Discovery, signals, scores, insights, and pipeline entries all hang off the
same prospect aggregate. Splitting discovery and scoring into separate
deployables would put either a cross-worker join or a shared schema on the hot
path, and shared schema ownership violates the platform's bounded-context rule
(one schema, one owner).

## Boundaries

This Worker owns its bounded context: its data, its invariants, its API surface
(exposed to the fleet through the edge). Cross-context calls go over service
bindings; nothing else may reach into its storage. `org_id` and `user_id` are
opaque UUIDs owned by `membership` and `identity` — there are no cross-context
foreign keys.
