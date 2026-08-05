# prospecting-worker — runbook

## How it deploys

Merges to `main` converge automatically: CI plans changed components
(`orun plan --changed`) and runs this component's lane via
`orun run --remote-state` with credential-free OIDC auth. The convergence run
is the deployment; the DAG orders this component after everything it depends
on. Failed lanes resume with `gh run rerun --failed`.

Schema changes ship through the `db-migrate` component (plan on PRs, apply on
merge to `main`) — never by hand, and never from this Worker.

## Rollback

Revert the offending commit on `main`; the next convergence applies the
previous desired state. There is no out-of-band mutation to undo — the repo is
the source of truth.

Scores are append-only, so a bad ruleset deploy does not corrupt history: the
previous score rows are still there with the ruleset version that produced
them. Reverting the code and running a bulk rescore restores the board.

## Verify

The deploy lane's own verify/smoke is the gate. End-to-end behavior is
exercised through `api-edge` (this Worker has no public URL) — the
authenticated CLI walkthrough is the stage verification:

```
signalpilot discover run --location "…" --industry "…"
signalpilot prospects list --band hot
signalpilot prospects explain <id>
signalpilot insights generate <id> --kind outreach_email
signalpilot pipeline move <id> --stage contacted
```

## Common failures

| Symptom | Cause | Action |
|---------|-------|--------|
| `402 quota_exhausted` on discovery | the org's plan allowance is spent | expected — the payload carries the meter, limit, and reset date |
| `404` on a route the caller expects to work | deny-as-404: the policy check denied | check the actor's org role against `design.md` §8 |
| discovery run stuck in `running` | the background pass died after the 202 | the run is idempotent by dedupe key — re-run the same query; it converges |
| `503` from every route | `PLATFORM_DB` unbound | check the Hyperdrive wiring for the environment |
