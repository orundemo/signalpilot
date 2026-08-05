-- 220_prospecting_pipeline
-- Prospecting pipeline — stages, entries, and the append-only activity timeline
-- Bounded context: prospecting

-- ── pipeline_stages ────────────────────────────────────────
-- Seeded on first use with new → contacted → replied → meeting → won / lost.
CREATE TABLE IF NOT EXISTS prospecting.pipeline_stages (
  id         UUID PRIMARY KEY,
  org_id     UUID NOT NULL,
  key        TEXT NOT NULL,
  label      TEXT NOT NULL,
  position   SMALLINT NOT NULL,
  outcome    TEXT NOT NULL DEFAULT 'open' CHECK (outcome IN ('open', 'won', 'lost')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE prospecting.pipeline_stages IS 'Per-org pipeline columns. Terminal stages (outcome != open) close the entry.';

CREATE UNIQUE INDEX IF NOT EXISTS pipeline_stages_org_key_idx
  ON prospecting.pipeline_stages (org_id, key);

CREATE UNIQUE INDEX IF NOT EXISTS pipeline_stages_org_position_idx
  ON prospecting.pipeline_stages (org_id, position);

-- Composite unique for the in-context FK target from entries.
CREATE UNIQUE INDEX IF NOT EXISTS pipeline_stages_org_id_id_idx
  ON prospecting.pipeline_stages (org_id, id);

-- ── pipeline_entries ───────────────────────────────────────
-- `entered_stage_at` resets on every move — that is what makes
-- "stuck in stage longer than N days" a single query.
CREATE TABLE IF NOT EXISTS prospecting.pipeline_entries (
  id               UUID PRIMARY KEY,
  org_id           UUID NOT NULL,
  prospect_id      UUID NOT NULL,
  stage_id         UUID NOT NULL,
  owner_user_id    UUID,
  value_cents      BIGINT CHECK (value_cents IS NULL OR value_cents >= 0),
  entered_stage_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at        TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (org_id, prospect_id) REFERENCES prospecting.prospects (org_id, id),
  FOREIGN KEY (org_id, stage_id) REFERENCES prospecting.pipeline_stages (org_id, id)
);

COMMENT ON TABLE prospecting.pipeline_entries IS 'A prospect''s position in the pipeline. At most one OPEN entry per prospect; a closed prospect can be re-entered.';
COMMENT ON COLUMN prospecting.pipeline_entries.entered_stage_at IS 'Reset on every stage move — the basis of stuck-in-stage highlighting.';

-- At most one open entry per prospect; closed entries are historical.
CREATE UNIQUE INDEX IF NOT EXISTS pipeline_entries_org_prospect_open_idx
  ON prospecting.pipeline_entries (org_id, prospect_id)
  WHERE closed_at IS NULL;

CREATE INDEX IF NOT EXISTS pipeline_entries_org_stage_entered_idx
  ON prospecting.pipeline_entries (org_id, stage_id, entered_stage_at);

-- ── activities ─────────────────────────────────────────────
-- Append-only timeline. System-generated rows (discovered, rescored,
-- insight_generated) have a null actor.
CREATE TABLE IF NOT EXISTS prospecting.activities (
  id             UUID PRIMARY KEY,
  org_id         UUID NOT NULL,
  prospect_id    UUID NOT NULL,
  kind           TEXT NOT NULL
                   CHECK (kind IN ('note', 'stage_change', 'owner_change',
                                   'insight_generated', 'rescored', 'discovered')),
  actor_user_id  UUID,
  body           TEXT,
  metadata       JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (org_id, prospect_id) REFERENCES prospecting.prospects (org_id, id)
);

COMMENT ON TABLE prospecting.activities IS 'Append-only per-prospect timeline. Never updated or deleted.';
COMMENT ON COLUMN prospecting.activities.actor_user_id IS 'Null for system-generated entries.';

CREATE INDEX IF NOT EXISTS activities_org_prospect_created_idx
  ON prospecting.activities (org_id, prospect_id, created_at DESC);
