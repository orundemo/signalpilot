import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { manifest, BOUNDED_CONTEXTS } from "@saas/db";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_ROOT = resolve(__dirname, "../../..", "packages/db/src/migrations");

const IDS = ["200_prospecting_core", "210_prospecting_scoring", "220_prospecting_pipeline"] as const;

function sqlFor(id: string): string {
  const entry = manifest.migrations.find((m) => m.id === id)!;
  return readFileSync(resolve(MIGRATIONS_ROOT, entry.path), "utf-8");
}

/** The column definitions of each CREATE TABLE, without the surrounding prose. */
function tableBodies(sql: string): string[] {
  return sql
    .split("CREATE TABLE IF NOT EXISTS ")
    .slice(1)
    .map((chunk) => chunk.slice(0, chunk.indexOf("\n);")));
}

describe("Prospecting Migration Verification", () => {
  const prospectingMigrations = manifest.migrations.filter((m) => m.context === "prospecting");

  it("registers 'prospecting' as a bounded context", () => {
    expect(BOUNDED_CONTEXTS).toContain("prospecting");
  });

  it("registers all three prospecting migrations", () => {
    expect(prospectingMigrations.map((m) => m.id)).toEqual([...IDS]);
  });

  it("orders them consecutively", () => {
    const ids = manifest.migrations.map((m) => m.id);
    const first = ids.indexOf(IDS[0]);
    expect(first).toBeGreaterThan(-1);
    expect(ids.slice(first, first + 3)).toEqual([...IDS]);
  });

  it("manifest checksums match the on-disk up.sql files", () => {
    for (const id of IDS) {
      const entry = manifest.migrations.find((m) => m.id === id)!;
      const content = readFileSync(resolve(MIGRATIONS_ROOT, entry.path));
      expect(entry.checksum).toBe(createHash("sha256").update(content).digest("hex"));
    }
  });

  it("is idempotent — every CREATE is guarded", () => {
    for (const id of IDS) {
      const sql = sqlFor(id);
      const creates = sql.match(/^CREATE (TABLE|SCHEMA|INDEX|UNIQUE INDEX)/gm) ?? [];
      const guarded = sql.match(/^CREATE (?:TABLE|SCHEMA|INDEX|UNIQUE INDEX) IF NOT EXISTS/gm) ?? [];
      expect(guarded.length).toBe(creates.length);
    }
  });

  describe("200_prospecting_core", () => {
    const sql = sqlFor("200_prospecting_core");

    it("creates the prospecting schema and the three core tables", () => {
      expect(sql).toContain("CREATE SCHEMA IF NOT EXISTS prospecting");
      expect(sql).toContain("prospecting.prospects");
      expect(sql).toContain("prospecting.signals");
      expect(sql).toContain("prospecting.discovery_runs");
    });

    it("makes the dedupe key the uniqueness mechanism", () => {
      expect(sql).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS prospects_org_dedupe_key_idx\s*\n\s*ON prospecting\.prospects \(org_id, dedupe_key\)/);
    });

    it("constrains source_digest to a 64-char hex sha256 — a payload cannot be stored there", () => {
      expect(sql).toContain("source_digest ~ '^[0-9a-f]{64}$'");
    });

    it("bounds severity to 1–5", () => {
      expect(sql).toContain("severity BETWEEN 1 AND 5");
    });

    it("scopes every table by org_id", () => {
      const tables = sql.split(/CREATE TABLE IF NOT EXISTS /).slice(1);
      expect(tables.length).toBe(3);
      for (const table of tables) {
        expect(table).toMatch(/org_id\s+UUID NOT NULL/);
      }
    });

    it("has no column that could hold a raw payload or a personal contact", () => {
      // v1 handles business records only; the fetched document is dropped
      // in-request. A column named for any of these is the failure mode.
      // Only the CREATE TABLE bodies are inspected — the COMMENT prose
      // explains the rule and would otherwise trip it.
      for (const body of tableBodies(sql)) {
        for (const forbidden of [/\braw_/i, /\bpayload\b/i, /\bhtml\b/i, /\bemail\b/i, /\bphone\b/i, /contact_name/i]) {
          expect(body).not.toMatch(forbidden);
        }
      }
    });

    it("keeps the partial-failure counters on the run", () => {
      for (const counter of ["candidates_found", "prospects_created", "prospects_updated", "signals_recorded", "error_code"]) {
        expect(sql).toContain(counter);
      }
    });
  });

  describe("210_prospecting_scoring", () => {
    const sql = sqlFor("210_prospecting_scoring");

    it("allows exactly one active scoring profile per org", () => {
      expect(sql).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS scoring_profiles_org_active_idx[\s\S]*?WHERE is_active/);
    });

    it("stores the provenance a score needs to stay explainable", () => {
      for (const column of ["ruleset_version", "profile_version", "contributions", "signal_ids"]) {
        expect(sql).toContain(column);
      }
    });

    it("bounds the score and the band", () => {
      expect(sql).toContain("score BETWEEN 0 AND 100");
      expect(sql).toContain("band IN ('hot', 'warm', 'cold')");
    });

    it("makes input_digest the insight cache key", () => {
      expect(sql).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS insights_org_input_digest_idx\s*\n\s*ON prospecting\.insights \(org_id, input_digest\)/);
    });

    it("records the guardrail verdict on every stored generation", () => {
      expect(sql).toContain("guardrail_verdict IN ('pass', 'revised', 'blocked')");
    });
  });

  describe("220_prospecting_pipeline", () => {
    const sql = sqlFor("220_prospecting_pipeline");

    it("permits at most one open entry per prospect", () => {
      expect(sql).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS pipeline_entries_org_prospect_open_idx[\s\S]*?WHERE closed_at IS NULL/);
    });

    it("indexes the stuck-in-stage query", () => {
      expect(sql).toMatch(/ON prospecting\.pipeline_entries \(org_id, stage_id, entered_stage_at\)/);
    });

    it("keeps stage keys and positions unique per org", () => {
      expect(sql).toContain("pipeline_stages_org_key_idx");
      expect(sql).toContain("pipeline_stages_org_position_idx");
    });

    it("constrains activity kinds to the timeline vocabulary", () => {
      for (const kind of ["note", "stage_change", "owner_change", "insight_generated", "rescored", "discovered"]) {
        expect(sql).toContain(`'${kind}'`);
      }
    });
  });

  it("declares no cross-context foreign key", () => {
    // org_id and user_id are opaque UUIDs owned by membership and identity.
    for (const id of IDS) {
      const references = sqlFor(id).match(/REFERENCES\s+([a-z_]+)\./g) ?? [];
      for (const ref of references) {
        expect(ref).toMatch(/REFERENCES\s+prospecting\./);
      }
    }
  });
});
