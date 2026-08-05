# SignalPilot

**A B2B prospecting system: it finds local businesses, records what is
measurably wrong with their web presence, scores the opportunity with a reason
attached to every point, drafts the outreach, and moves the result through a
pipeline.**

This is a product, not a platform demo. Read with fresh eyes, this page should
describe something you could sell to a web agency tomorrow — if it reads like
generic SaaS boilerplate, that is a defect worth filing.

## The problem

A web agency's hardest recurring job is finding the next client. The businesses
worth calling are the ones whose websites are visibly costing them money — no
HTTPS, six-second load times, no way to book an appointment — and there is no
efficient way to find them at scale, or to open the conversation with something
the prospect can verify in thirty seconds.

## What it does

Five verbs:

| Verb | What happens |
|---|---|
| **Discover** | Given a place and a trade, produce candidate businesses through provider-neutral source adapters. |
| **Observe** | For each candidate, derive objective, checkable weaknesses from a single bounded fetch: no valid HTTPS, slow load, no mobile viewport, no booking flow, no analytics, stale content, thin reviews. |
| **Score** | Turn those observations into a 0–100 number through a pure, versioned rules engine, storing the per-rule contribution and the reason for each point. |
| **Explain** | Write a prospect summary and a first-touch outreach email from the score and the observations, behind a guardrail that strips or blocks anything ungrounded. |
| **Work** | Assign, stage, note, and close, with the stage clock making "stuck for eleven days" a number rather than an impression. |

## The two commitments that make it defensible

**Every number is reproducible and attributable.** Scores are append-only rows
carrying the ruleset version, the weight-profile version, and a per-rule
contribution breakdown. The console renders that breakdown directly, so *"why
is this 82"* is a UI feature rather than a support ticket. The same evidence
always produces the same score — and a weight change never rewrites history,
because old scores keep the profile version that produced them.

**The model is on a short leash.** The LLM is given the business record, the
score, and the contributions — and nothing else. It cannot move the number, it
cannot cite a fact it was not given, and it cannot invent a person. Every
generation passes a guardrail before it is stored, the verdict is shown next to
the draft, and a blocked generation costs the tenant nothing. A model that
quietly hallucinates is a liability; a model whose edits are visible is a
feature.

## What it does not keep

Signals store derived values — a load time, whether a booking flow exists, how
old the content is — plus a SHA-256 of the document those values came from. The
document itself is read and dropped in the same request. The digest proves
*which* page produced the numbers without retaining the page.

The product handles business records only: no names, no personal email
addresses, no phone numbers. That is a deliberate exposure cap, not a missing
feature, and the `/isolation-proof` console page demonstrates both this and
tenant isolation against live data.

## Commercial shape

Discovery credits are the commercial model, so both expensive operations are
metered and gated from day one.

| Plan | Discoveries / mo | AI drafts / mo | Seats |
|---|---:|---:|---:|
| Free | 100 | 10 | 1 |
| Starter | 1,000 | 200 | 3 |
| Growth | 10,000 | 2,000 | 10 |

Exhaustion returns a typed `quota_exhausted` error carrying the meter, the
limit, and the reset date — enough for the console to render an upgrade prompt
without a second round trip.

## Surfaces

- **Console** — `discover`, `prospects` (with the score explainer),
  `pipeline`, `insights`, plus the platform's usage, billing, and audit pages,
  which pick up the product's meters and events with no page-specific code.
- **API** — every operation under `/v1/organizations/:orgId/`, through one
  public edge, with tenancy resolution, idempotency, and rate limiting applied.
- **SDK** — `sdk.prospecting.*`, typed from the shared contracts module.
- **CLI** — `signalpilot discover`, `prospects`, `insights`, `pipeline`.
- **Webhooks** — eight published event types with documented payload schemas.

## Where to read next

- `docs/architecture.md` — how it is built and why it is one worker.
- `docs/runbook.md` — how it deploys and what to do when something breaks.
- `specs/epics/prospecting/` — the charter, the design, and the as-built record.
