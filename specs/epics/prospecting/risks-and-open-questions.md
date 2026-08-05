# prospecting — Risks and open questions

## Risks

### Product and technical

**A false merge destroys pipeline state.** Identity resolution is the one place
where being clever loses. If `dedupe.ts` merges two distinct businesses, the
pipeline entry, activities, and score history of one silently attach to the
other, and there is no way for the user to notice. *Mitigation:* the v1 key is
deliberately conservative (exact normalised domain, or name+country+locality);
no fuzzy matching; a manual merge endpoint is a follow-on where the user
supplies the judgement.

**Silent rescoring erodes trust.** If a weight change rewrites every number on
the board, a manager loses the ability to reason about their own pipeline.
*Mitigation:* profiles are append-only and versioned; a weight change never
implicitly rescores; bulk rescore is an explicit, audited action.

**LLM cost is unbounded by default.** A generation endpoint with no cache and
no gate is an open tap. *Mitigation:* entitlement check before the provider
call, digest caching, blocked generations not metered, a stricter edge
rate-limit class on the two expensive endpoints.

**Hallucinated outreach is a reputational liability for the *client's*
client.** An email that invents a case study and gets sent to a real business
is worse than no feature. *Mitigation:* the guardrail's grounding and
fabricated-contact checks, the stored verdict, and the v1 decision to draft but
never send — a human is always in the loop.

**Observation at scale looks like scraping.** The `web-signals` adapter fetches
third-party sites. *Mitigation:* bounded single fetch per candidate,
`robots.txt` respected, rate-limited and batched, no content retained, a clear
user agent. Credentialed providers are preferred as volume grows.

**Discovery is the only long-running write path.** A 202-plus-background-work
shape can strand runs in `running` if the worker dies mid-flight.
*Mitigation:* a staleness sweep that fails runs past a horizon; idempotent
upserts so a retry converges; partial counters preserved.

**Quota enforcement races.** Concurrent discovery runs can both pass the
entitlement check. *Mitigation:* accept small overage as a design choice
(recording on created prospects, checking before the run), and make the
overage visible rather than pretending it cannot happen. Hard reservation
semantics are a follow-on if a plan ever prices per unit rather than per tier.

### Delivery and commercial

**The client is a new account with no hire history.** *Mitigation:* milestone
escrow, a small funded first milestone, no work before funding.

**Fixed-price scope creep.** The brief is a paragraph; the build is seventeen
days. *Mitigation:* quote Phase 1 fixed with the SP milestone list as the
scope-of-work, later phases estimated; get the locked scope in writing.

**IP and lock-in anxiety.** The brief explicitly retains source and
infrastructure ownership. This must have a straight answer ready, because a
fumbled one loses the job at contract stage. *Mitigation:* the repo is the
client's from commit one, in their GitHub org; Cloudflare and Supabase accounts
are theirs, provisioned into their account; runtime is standard and portable
(Workers, Postgres, Terraform, SQL, TypeScript) with the delivery pipeline a
separable concern. Ship an `EXIT.md` unprompted covering the plain
`wrangler`/`terraform` equivalents, the generated-workflow escape hatch, and how
to run migrations without the pipeline component. Volunteering the exit plan is
the fastest way to kill the objection. Settle the baseline licence position in
the proposal, not in contract negotiation.

**Contradictory docs.** The known failure mode from the reference product:
`docs/overview.md` described one domain while the code implemented another,
because docs were rebranded independently. Shipping that to a buyer costs the
exact credibility the docs were meant to buy. *Mitigation:* SP8 re-runs
`08-docs` after the domain lands, and the overview is read with fresh eyes
before any workspace link is shared.

**Repo hygiene.** `.orun/` is generated and gitignored and can reach hundreds
of megabytes — it must never enter a client clone. Composition contracts stay
**pinned** as an OCI tag (`stack-tectonic:0.18.2`) rather than vendored, so
upgrades are a one-line bump.

**Credential-blocked tails.** Production OAuth/magic-link, Stripe, and
Cloudflare Email Service (Workers Paid plus a verified sending domain with
DKIM/SPF) need human-supplied credentials and account setup. Budget a day and
say so in the proposal rather than discovering it in week four.

## Open questions

| # | Question | Owner | Needed by |
|---|----------|-------|-----------|
| 1 | Which model provider backs insights — a Workers-native binding or an external API with the key in environment configuration? Affects latency, cost per generation, and the exit story. | eng | SP3 |
| 2 | Are pipeline stages org-configurable in v1, or fixed to the seeded five? The schema supports configurable; the console cost is a stage editor. | product | SP4 |
| 3 | Which credentialed discovery provider is first, and does it bind through `integrations-worker` connections or plain configuration? | product | SP1 follow-on |
| 4 | Is `reviews_thin` derivable without a paid source? If not, drop it from ruleset v1 rather than shipping a signal that is always absent. | eng | SP2 |
| 5 | Does the demo tenant seed with `synthetic` only, or with a handful of real domains for credibility? Real domains make a better demo and a worse reproducibility story. | product | SP8 |
| 6 | Single currency for `value_cents` — which one, and is it org-configurable later? | product | SP4 |
| 7 | Signal expiry horizon: how stale is too stale before a signal stops counting toward the score? | product | SP2 |
| 8 | Does self-serve signup create an org immediately, or land in the existing onboarding flow? | product | SP8 |
