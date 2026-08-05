# prospecting-worker-tests

Verification suite for `prospecting-worker` and the prospecting contract and
persistence layers.

A verify-only component: its lane runs this suite against
its target component on every plan that
includes it. Nothing deploys from here — a red lane blocks the
convergence, which is the point.

## Gates

- The worker answers its health route and returns the platform 404 envelope
  for everything else.
- The contract module's validators hold the two data-protection invariants:
  `features` is a flat map of scalars, and `source_digest` is a 64-char hex
  sha256 — a raw payload cannot pass either.
- Repository queries are tenant-scoped: every statement filters on `org_id`.
- Scoring, dedupe, and guardrail engines are exercised with no database and no
  network.
