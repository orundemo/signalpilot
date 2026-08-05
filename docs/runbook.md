# SignalPilot — runbook

## How it deploys

Merges to `main` converge automatically. CI plans changed components
(`orun plan --changed`) and runs each component's lane via
`orun run --remote-state` with credential-free OIDC auth. **The convergence run
is the deployment** — there is no separate deploy step, and no hand-run
`wrangler deploy` or `terraform apply`. A hand deploy is drift the next plan
will fight.

Schema changes ship through the `db-migrate` component: plan on the PR, apply
on merge. The runner refuses a migration whose checksum does not match the
manifest, so an edited-in-place migration fails loudly rather than silently
diverging environments.

Failed lanes resume with `gh run rerun --failed`.

## Configuration this product needs

| Binding | Where it comes from | Absent means |
|---|---|---|
| `PLATFORM_DB` | Hyperdrive wiring, per environment | every route 503s |
| `MEMBERSHIP_WORKER` / `POLICY_WORKER` | service bindings | every route 503s |
| `BILLING_WORKER` | service binding | discovery and insights 503 (fail closed) |
| `METERING_WORKER` | service binding | usage is not recorded; product still works |
| `MODEL_API_KEY` | environment secret | insights fall back to the deterministic template writer |

The model credential is deliberately optional. An environment without one still
has a working insights surface; the stored row records `model: "template"`, so
nothing is misrepresented as a model generation.

## Verifying a deployment

The CLI walkthrough is the verification, not a convenience:

```bash
signalpilot discover run --location Leeds --industry plumbing --limit 25
signalpilot discover status dsc_…      # poll to a terminal status
signalpilot prospects list --band hot
signalpilot prospects signals prs_…    # derived features + digest
signalpilot prospects explain prs_…    # the full score derivation
signalpilot insights generate prs_… --kind outreach_email
signalpilot pipeline add prs_… && signalpilot pipeline move pen_… --stage contacted
```

If `prospects explain` prints a score with its per-rule breakdown and the
ruleset and profile versions, the whole chain is working.

## Seeding a demo tenant

```bash
signalpilot demo seed --prospects 200 --pipeline 40
```

It goes through the public API with your own credentials, so discovery creates
the prospects, the engine scores them, and the pipeline constraint governs the
board. Idempotent: discovery converges on the dedupe key, and a prospect
already on the board is a 409 the seed treats as "already there".

## Common failures

| Symptom | Cause | What to do |
|---|---|---|
| `402 quota_exhausted` | the plan's monthly allowance is spent | expected — the payload carries the meter, limit, and reset date |
| `404` on a route the caller expects to work | deny-as-404: the policy check denied | check the actor's org role against `design.md` §8 |
| `412 guardrail_blocked` | the generation invented a contact or a claim | expected — nothing was stored and nothing was billed; regenerate |
| `412 no_score` on an insight | the prospect has never been scored | run a rescore first; a draft explains a score that exists |
| discovery run stuck in `running` | the background pass died after the 202 | re-run the same query — discovery is idempotent by dedupe key and converges |
| `503` from every route | `PLATFORM_DB` unbound | check the Hyperdrive wiring for that environment |
| insights suddenly say `model: "template"` | `MODEL_API_KEY` is missing or rotated out | re-bind the secret; the surface keeps working meanwhile |

## Rolling back

Revert the offending commit on `main`; the next convergence applies the
previous desired state.

Scores are append-only, so a bad ruleset deploy does not corrupt history — the
previous rows are still there with the ruleset version that produced them.
Reverting the code and running `signalpilot prospects rescore` (or the bulk
action) restores the board.

Scoring profiles are append-only too: a weight change that turned out wrong is
undone by writing the previous weights as a new version, then bulk rescoring.
The old scores were never modified.

## Cost controls

Two operations cost real money downstream: a discovery run fans out to fetches,
and an insight generation calls a model. Both are gated on a plan entitlement
before the work starts, both are metered on what they actually produced, and
both sit in a stricter edge rate-limit class than the rest of the API. An
insight is cached by input digest, so a repeat request for an unchanged
prospect calls neither the model nor the meter.
