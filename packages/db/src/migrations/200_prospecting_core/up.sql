-- 200_prospecting_core
-- Prospecting persistence foundation — prospects, signals, discovery runs
-- Bounded context: prospecting

CREATE SCHEMA IF NOT EXISTS prospecting;

COMMENT ON SCHEMA prospecting IS 'Prospecting bounded context — owns prospect, signal, score, insight, and pipeline persistence.';

-- ── prospects ──────────────────────────────────────────────
-- The business record. Per-org by design: two agencies discovering the same
-- bakery each own their own row, their own signals, and their own pipeline
-- position. There is no shared global business graph, and therefore no
-- cross-tenant leakage surface.
CREATE TABLE IF NOT EXISTS prospecting.prospects (
  id               UUID PRIMARY KEY,
  org_id           UUID NOT NULL,
  name             TEXT NOT NULL,
  domain           TEXT,
  dedupe_key       TEXT NOT NULL,
  industry         TEXT,
  locality         TEXT,
  region           TEXT,
  country          TEXT,
  size_band        TEXT NOT NULL DEFAULT 'unknown'
                     CHECK (size_band IN ('micro', 'small', 'medium', 'large', 'unknown')),
  source           TEXT NOT NULL,
  source_ref       TEXT,
  status           TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  first_seen_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_enriched_at TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  archived_at      TIMESTAMPTZ
);

COMMENT ON TABLE prospecting.prospects IS 'Candidate businesses within an organization. Every query must scope by org_id.';
COMMENT ON COLUMN prospecting.prospects.org_id IS 'Owning organization — opaque reference, no cross-context FK.';
COMMENT ON COLUMN prospecting.prospects.dedupe_key IS 'Derived identity key (d:<domain> or n:<slug>|<country>|<locality>). The uniqueness constraint IS the dedupe mechanism.';
COMMENT ON COLUMN prospecting.prospects.source IS 'Discovery adapter id that first produced this record.';

-- The dedupe mechanism: a re-run of an overlapping discovery is an upsert.
CREATE UNIQUE INDEX IF NOT EXISTS prospects_org_dedupe_key_idx
  ON prospecting.prospects (org_id, dedupe_key);

-- Composite unique for in-context FK targets (signals, scores, pipeline).
CREATE UNIQUE INDEX IF NOT EXISTS prospects_org_id_id_idx
  ON prospecting.prospects (org_id, id);

-- Keyset pagination over the active board.
CREATE INDEX IF NOT EXISTS prospects_org_created_active_idx
  ON prospecting.prospects (org_id, created_at DESC, id DESC)
  WHERE status = 'active';

-- ── signals ────────────────────────────────────────────────
-- Observations about a prospect. `features` holds DERIVED values only:
-- the fetched HTML, the provider JSON, and any contact details are consumed
-- in-request and dropped. `source_digest` proves WHICH payload the derivation
-- came from without retaining it. This is a hard constraint, not a preference.
CREATE TABLE IF NOT EXISTS prospecting.signals (
  id            UUID PRIMARY KEY,
  org_id        UUID NOT NULL,
  prospect_id   UUID NOT NULL,
  kind          TEXT NOT NULL,
  severity      SMALLINT NOT NULL CHECK (severity BETWEEN 1 AND 5),
  features      JSONB NOT NULL DEFAULT '{}'::jsonb,
  source        TEXT NOT NULL,
  source_digest TEXT NOT NULL CHECK (source_digest ~ '^[0-9a-f]{64}$'),
  observed_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at    TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (org_id, prospect_id) REFERENCES prospecting.prospects (org_id, id)
);

COMMENT ON TABLE prospecting.signals IS 'Derived observations about a prospect. Never stores a raw provider payload.';
COMMENT ON COLUMN prospecting.signals.features IS 'Derived scalars/enums the scoring engine consumes (e.g. {"lcp_ms":6400,"bucket":"poor"}). Never a raw payload.';
COMMENT ON COLUMN prospecting.signals.source_digest IS 'sha256 of the payload this observation was derived from — provenance without retention.';
COMMENT ON COLUMN prospecting.signals.expires_at IS 'Staleness horizon; a signal past it is ignored by scoring.';

CREATE UNIQUE INDEX IF NOT EXISTS signals_org_prospect_kind_observed_idx
  ON prospecting.signals (org_id, prospect_id, kind, observed_at);

CREATE INDEX IF NOT EXISTS signals_org_prospect_observed_idx
  ON prospecting.signals (org_id, prospect_id, observed_at DESC);

-- ── discovery_runs ─────────────────────────────────────────
-- A unit of metered work. Partial failure is a first-class outcome: a run
-- that produced 60 of 100 candidates before an adapter error completes with
-- status='failed', the counters it did achieve, and an error_code.
CREATE TABLE IF NOT EXISTS prospecting.discovery_runs (
  id                UUID PRIMARY KEY,
  org_id            UUID NOT NULL,
  requested_by      UUID NOT NULL,
  adapter           TEXT NOT NULL,
  query             JSONB NOT NULL DEFAULT '{}'::jsonb,
  status            TEXT NOT NULL DEFAULT 'running'
                      CHECK (status IN ('running', 'completed', 'failed', 'cancelled')),
  candidates_found  INT NOT NULL DEFAULT 0,
  prospects_created INT NOT NULL DEFAULT 0,
  prospects_updated INT NOT NULL DEFAULT 0,
  signals_recorded  INT NOT NULL DEFAULT 0,
  error_code        TEXT,
  started_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at       TIMESTAMPTZ
);

COMMENT ON TABLE prospecting.discovery_runs IS 'One metered discovery execution. Counters are advanced as the run progresses so a partial failure is still legible.';
COMMENT ON COLUMN prospecting.discovery_runs.query IS 'The normalised query (location, industry, size, limit) — no credentials.';

CREATE INDEX IF NOT EXISTS discovery_runs_org_started_idx
  ON prospecting.discovery_runs (org_id, started_at DESC, id DESC);
