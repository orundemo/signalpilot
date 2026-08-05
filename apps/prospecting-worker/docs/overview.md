# prospecting-worker

Cloudflare Worker for the **prospecting** product bounded context — the one
context that turns the platform baseline into a product.

It owns five verbs and one Postgres schema (`prospecting`):

- **discover** — given a query, produce candidate businesses through
  provider-neutral source adapters
- **observe** — derive objective, checkable weaknesses about a candidate
  (no valid HTTPS, slow page, no booking flow) as *derived features only*
- **score** — turn observations into a defensible number with a reason for
  every point, through a pure, versioned rules engine
- **explain** — turn the score into prose, behind a guardrail pass
- **work** — assign, stage, note, and close

Part of the signalpilot runtime: a Cloudflare Worker deployed per environment
(`stage`, `prod`; `dev` is verify-only). Not publicly routable — reached only
through `api-edge` service bindings.

## Depends on

- **membership-worker** — organization and member resolution
- **policy-worker** — deny-by-default action checks
- **billing-worker** — the entitlement gate on discovery and insight generation
- **metering-worker** — usage recording for the two product meters

## Invariants

- Every row carries `org_id`; every query filters on it. Prospects are
  per-org — there is no shared global business graph.
- Signals store derived features plus a `source_digest`. The fetched document
  is consumed in-request and dropped.
- Scores are append-only and carry the ruleset version, the profile version,
  and a per-rule contribution breakdown.
- The model never produces a number. It writes prose about a score that
  already exists.
