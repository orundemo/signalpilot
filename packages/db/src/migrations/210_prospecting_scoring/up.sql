-- 210_prospecting_scoring
-- Prospecting scoring — per-org weight profiles, append-only explainable
-- scores, and guardrailed generated insights
-- Bounded context: prospecting

-- ── scoring_profiles ───────────────────────────────────────
-- Per-org weight overrides. Append-only: editing weights inserts a new
-- version and deactivates the previous one, so an old score remains
-- explainable after a weight change.
CREATE TABLE IF NOT EXISTS prospecting.scoring_profiles (
  id              UUID PRIMARY KEY,
  org_id          UUID NOT NULL,
  version         INT NOT NULL,
  ruleset_version INT NOT NULL,
  weights         JSONB NOT NULL DEFAULT '{}'::jsonb,
  is_active       BOOLEAN NOT NULL DEFAULT true,
  created_by      UUID,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE prospecting.scoring_profiles IS 'Per-org scoring weight overrides. Append-only — one active version per org.';
COMMENT ON COLUMN prospecting.scoring_profiles.weights IS 'Sparse {signal_kind: points} overrides on the code ruleset defaults.';
COMMENT ON COLUMN prospecting.scoring_profiles.ruleset_version IS 'The code ruleset version this profile targets.';

CREATE UNIQUE INDEX IF NOT EXISTS scoring_profiles_org_version_idx
  ON prospecting.scoring_profiles (org_id, version);

-- Exactly one active profile per org.
CREATE UNIQUE INDEX IF NOT EXISTS scoring_profiles_org_active_idx
  ON prospecting.scoring_profiles (org_id)
  WHERE is_active;

-- ── scores ─────────────────────────────────────────────────
-- Append-only and explainable. A rescore INSERTS a row; the current score is
-- the newest row per prospect. History is free, and "why did this drop from
-- 82 to 61" is answerable by diffing two rows.
CREATE TABLE IF NOT EXISTS prospecting.scores (
  id              UUID PRIMARY KEY,
  org_id          UUID NOT NULL,
  prospect_id     UUID NOT NULL,
  score           SMALLINT NOT NULL CHECK (score BETWEEN 0 AND 100),
  band            TEXT NOT NULL CHECK (band IN ('hot', 'warm', 'cold')),
  ruleset_version INT NOT NULL,
  profile_version INT NOT NULL,
  contributions   JSONB NOT NULL DEFAULT '[]'::jsonb,
  signal_ids      UUID[] NOT NULL DEFAULT '{}'::uuid[],
  computed_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (org_id, prospect_id) REFERENCES prospecting.prospects (org_id, id)
);

COMMENT ON TABLE prospecting.scores IS 'Append-only opportunity scores. Never updated — a rescore inserts a new row.';
COMMENT ON COLUMN prospecting.scores.contributions IS 'Ordered [{kind, points, reason, features}] — the per-rule breakdown the console renders.';
COMMENT ON COLUMN prospecting.scores.signal_ids IS 'Exactly the signals this score considered.';

CREATE INDEX IF NOT EXISTS scores_org_prospect_computed_idx
  ON prospecting.scores (org_id, prospect_id, computed_at DESC);

-- Prospects board: "hot first, highest score first".
CREATE INDEX IF NOT EXISTS scores_org_band_score_idx
  ON prospecting.scores (org_id, band, score DESC);

-- Composite unique for the in-context FK target from insights.
CREATE UNIQUE INDEX IF NOT EXISTS scores_org_id_id_idx
  ON prospecting.scores (org_id, id);

-- ── insights ───────────────────────────────────────────────
-- Generated prose about a score that already exists. The model never
-- produces a number. Every generation carries its guardrail verdict.
CREATE TABLE IF NOT EXISTS prospecting.insights (
  id                UUID PRIMARY KEY,
  org_id            UUID NOT NULL,
  prospect_id       UUID NOT NULL,
  score_id          UUID NOT NULL,
  kind              TEXT NOT NULL CHECK (kind IN ('prospect_summary', 'outreach_email')),
  content           TEXT NOT NULL,
  model             TEXT,
  prompt_version    INT,
  input_digest      TEXT NOT NULL CHECK (input_digest ~ '^[0-9a-f]{64}$'),
  guardrail_verdict TEXT NOT NULL CHECK (guardrail_verdict IN ('pass', 'revised', 'blocked')),
  guardrail_notes   JSONB NOT NULL DEFAULT '[]'::jsonb,
  generated_by      UUID,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (org_id, prospect_id) REFERENCES prospecting.prospects (org_id, id),
  FOREIGN KEY (org_id, score_id) REFERENCES prospecting.scores (org_id, id)
);

COMMENT ON TABLE prospecting.insights IS 'Guardrailed model output. A blocked verdict stores no row — only pass/revised are persisted.';
COMMENT ON COLUMN prospecting.insights.input_digest IS 'sha256(kind || prompt_version || score_id || contributions) — the cache key. A repeat request returns the cached row and is not metered.';

-- The cache key: one stored generation per distinct input.
CREATE UNIQUE INDEX IF NOT EXISTS insights_org_input_digest_idx
  ON prospecting.insights (org_id, input_digest);

CREATE INDEX IF NOT EXISTS insights_org_prospect_created_idx
  ON prospecting.insights (org_id, prospect_id, created_at DESC);
