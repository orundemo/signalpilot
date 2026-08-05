import type {
  ArchiveProspectResponse,
  CreateActivityRequest,
  CreateActivityResponse,
  CreateDiscoveryRequest,
  CreateDiscoveryResponse,
  CreatePipelineEntryRequest,
  CreateProspectRequest,
  CreateProspectResponse,
  GenerateInsightRequest,
  GenerateInsightResponse,
  GetDiscoveryResponse,
  GetPipelineResponse,
  GetProspectResponse,
  GetScoringProfileResponse,
  ListActivitiesResponse,
  ListDiscoveriesResponse,
  ListInsightsResponse,
  ListPipelineStagesResponse,
  ListProspectsQuery,
  ListProspectsResponse,
  ListScoresResponse,
  ListSignalsResponse,
  PipelineEntryResponse,
  PutPipelineStagesRequest,
  PutPipelineStagesResponse,
  PutScoringProfileRequest,
  PutScoringProfileResponse,
  RescoreResponse,
  UpdatePipelineEntryRequest,
  UpdateProspectRequest,
} from "@saas/contracts/prospecting";

import type { Transport, RequestOptions } from "./transport.js";

/** Cursor/limit shared by the paginated list methods. */
export interface PageQuery {
  limit?: number;
  cursor?: string;
}

export interface BulkRescoreResponse {
  rescored: number;
  failed: number;
  truncated: boolean;
  limit: number;
}

function query(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") search.set(key, String(value));
  }
  const encoded = search.toString();
  return encoded.length > 0 ? `?${encoded}` : "";
}

/**
 * Prospecting resource client — discovery, prospects, scoring, insights, and
 * pipeline.
 *
 * Org-scoped: every method takes `orgId` first. Maps to
 * `apps/prospecting-worker` through the api-edge `prospecting-facade`.
 *
 * Every request and response type is imported from `@saas/contracts/prospecting`
 * rather than declared here. That is the point: there is no hand-written shape
 * in this file that could drift from what the worker actually returns.
 */
export class ProspectingClient {
  constructor(private readonly transport: Transport) {}

  private org(orgId: string): string {
    return `/v1/organizations/${encodeURIComponent(orgId)}`;
  }

  // ── Discovery ────────────────────────────────────────────

  /** POST /discoveries — 202; poll `getDiscovery` for completion. */
  runDiscovery(orgId: string, body: CreateDiscoveryRequest = {}, opts: RequestOptions = {}): Promise<CreateDiscoveryResponse> {
    return this.transport.request<CreateDiscoveryResponse>(
      { method: "POST", path: `${this.org(orgId)}/discoveries`, body },
      opts,
    );
  }

  /** GET /discoveries */
  listDiscoveries(orgId: string, page: PageQuery = {}, opts: RequestOptions = {}): Promise<ListDiscoveriesResponse> {
    return this.transport.request<ListDiscoveriesResponse>(
      { method: "GET", path: `${this.org(orgId)}/discoveries${query({ ...page })}` },
      opts,
    );
  }

  /** GET /discoveries/:id */
  getDiscovery(orgId: string, discoveryId: string, opts: RequestOptions = {}): Promise<GetDiscoveryResponse> {
    return this.transport.request<GetDiscoveryResponse>(
      { method: "GET", path: `${this.org(orgId)}/discoveries/${encodeURIComponent(discoveryId)}` },
      opts,
    );
  }

  // ── Prospects ────────────────────────────────────────────

  /** GET /prospects */
  listProspects(
    orgId: string,
    filters: ListProspectsQuery & PageQuery = {},
    opts: RequestOptions = {},
  ): Promise<ListProspectsResponse> {
    return this.transport.request<ListProspectsResponse>(
      { method: "GET", path: `${this.org(orgId)}/prospects${query({ ...filters })}` },
      opts,
    );
  }

  /** GET /prospects/:id */
  getProspect(orgId: string, prospectId: string, opts: RequestOptions = {}): Promise<GetProspectResponse> {
    return this.transport.request<GetProspectResponse>(
      { method: "GET", path: `${this.org(orgId)}/prospects/${encodeURIComponent(prospectId)}` },
      opts,
    );
  }

  /** POST /prospects — manual add; converges on the dedupe key. */
  createProspect(orgId: string, body: CreateProspectRequest, opts: RequestOptions = {}): Promise<CreateProspectResponse> {
    return this.transport.request<CreateProspectResponse>(
      { method: "POST", path: `${this.org(orgId)}/prospects`, body },
      opts,
    );
  }

  /** PATCH /prospects/:id */
  updateProspect(
    orgId: string,
    prospectId: string,
    body: UpdateProspectRequest,
    opts: RequestOptions = {},
  ): Promise<CreateProspectResponse> {
    return this.transport.request<CreateProspectResponse>(
      { method: "PATCH", path: `${this.org(orgId)}/prospects/${encodeURIComponent(prospectId)}`, body },
      opts,
    );
  }

  /** POST /prospects/:id/archive — soft delete; signals and scores are kept. */
  archiveProspect(orgId: string, prospectId: string, opts: RequestOptions = {}): Promise<ArchiveProspectResponse> {
    return this.transport.request<ArchiveProspectResponse>(
      { method: "POST", path: `${this.org(orgId)}/prospects/${encodeURIComponent(prospectId)}/archive` },
      opts,
    );
  }

  /** GET /prospects/:id/signals */
  listSignals(orgId: string, prospectId: string, opts: RequestOptions = {}): Promise<ListSignalsResponse> {
    return this.transport.request<ListSignalsResponse>(
      { method: "GET", path: `${this.org(orgId)}/prospects/${encodeURIComponent(prospectId)}/signals` },
      opts,
    );
  }

  // ── Scoring ──────────────────────────────────────────────

  /** POST /prospects/:id/rescore — appends a score row. */
  rescore(orgId: string, prospectId: string, opts: RequestOptions = {}): Promise<RescoreResponse> {
    return this.transport.request<RescoreResponse>(
      { method: "POST", path: `${this.org(orgId)}/prospects/${encodeURIComponent(prospectId)}/rescore` },
      opts,
    );
  }

  /** GET /prospects/:id/scores — the append-only history, newest first. */
  listScores(orgId: string, prospectId: string, opts: RequestOptions = {}): Promise<ListScoresResponse> {
    return this.transport.request<ListScoresResponse>(
      { method: "GET", path: `${this.org(orgId)}/prospects/${encodeURIComponent(prospectId)}/scores` },
      opts,
    );
  }

  /** POST /prospects/rescore — the explicit bulk action after a weight change. */
  bulkRescore(orgId: string, opts: RequestOptions = {}): Promise<BulkRescoreResponse> {
    return this.transport.request<BulkRescoreResponse>(
      { method: "POST", path: `${this.org(orgId)}/prospects/rescore` },
      opts,
    );
  }

  /** GET /scoring-profile */
  getScoringProfile(orgId: string, opts: RequestOptions = {}): Promise<GetScoringProfileResponse> {
    return this.transport.request<GetScoringProfileResponse>(
      { method: "GET", path: `${this.org(orgId)}/scoring-profile` },
      opts,
    );
  }

  /** PUT /scoring-profile — inserts a new version; does not rescore. */
  putScoringProfile(
    orgId: string,
    body: PutScoringProfileRequest,
    opts: RequestOptions = {},
  ): Promise<PutScoringProfileResponse> {
    return this.transport.request<PutScoringProfileResponse>(
      { method: "PUT", path: `${this.org(orgId)}/scoring-profile`, body },
      opts,
    );
  }

  // ── Insights ─────────────────────────────────────────────

  /** POST /prospects/:id/insights — cached by input digest; metered. */
  generateInsight(
    orgId: string,
    prospectId: string,
    body: GenerateInsightRequest,
    opts: RequestOptions = {},
  ): Promise<GenerateInsightResponse> {
    return this.transport.request<GenerateInsightResponse>(
      { method: "POST", path: `${this.org(orgId)}/prospects/${encodeURIComponent(prospectId)}/insights`, body },
      opts,
    );
  }

  /** GET /prospects/:id/insights */
  listInsights(orgId: string, prospectId: string, opts: RequestOptions = {}): Promise<ListInsightsResponse> {
    return this.transport.request<ListInsightsResponse>(
      { method: "GET", path: `${this.org(orgId)}/prospects/${encodeURIComponent(prospectId)}/insights` },
      opts,
    );
  }

  // ── Pipeline ─────────────────────────────────────────────

  /** GET /pipeline — stages plus open entries with stuck-in-stage counts. */
  getPipeline(orgId: string, opts: RequestOptions = {}): Promise<GetPipelineResponse> {
    return this.transport.request<GetPipelineResponse>({ method: "GET", path: `${this.org(orgId)}/pipeline` }, opts);
  }

  /** GET /pipeline/stages */
  listStages(orgId: string, opts: RequestOptions = {}): Promise<ListPipelineStagesResponse> {
    return this.transport.request<ListPipelineStagesResponse>(
      { method: "GET", path: `${this.org(orgId)}/pipeline/stages` },
      opts,
    );
  }

  /** PUT /pipeline/stages */
  putStages(
    orgId: string,
    body: PutPipelineStagesRequest,
    opts: RequestOptions = {},
  ): Promise<PutPipelineStagesResponse> {
    return this.transport.request<PutPipelineStagesResponse>(
      { method: "PUT", path: `${this.org(orgId)}/pipeline/stages`, body },
      opts,
    );
  }

  /** POST /pipeline/entries */
  createEntry(
    orgId: string,
    body: CreatePipelineEntryRequest,
    opts: RequestOptions = {},
  ): Promise<PipelineEntryResponse> {
    return this.transport.request<PipelineEntryResponse>(
      { method: "POST", path: `${this.org(orgId)}/pipeline/entries`, body },
      opts,
    );
  }

  /** PATCH /pipeline/entries/:id — a stage change resets the stage clock. */
  updateEntry(
    orgId: string,
    entryId: string,
    body: UpdatePipelineEntryRequest,
    opts: RequestOptions = {},
  ): Promise<PipelineEntryResponse> {
    return this.transport.request<PipelineEntryResponse>(
      { method: "PATCH", path: `${this.org(orgId)}/pipeline/entries/${encodeURIComponent(entryId)}`, body },
      opts,
    );
  }

  // ── Activities ───────────────────────────────────────────

  /** GET /prospects/:id/activities */
  listActivities(orgId: string, prospectId: string, opts: RequestOptions = {}): Promise<ListActivitiesResponse> {
    return this.transport.request<ListActivitiesResponse>(
      { method: "GET", path: `${this.org(orgId)}/prospects/${encodeURIComponent(prospectId)}/activities` },
      opts,
    );
  }

  /** POST /prospects/:id/activities — a manual note; other kinds are system-written. */
  createActivity(
    orgId: string,
    prospectId: string,
    body: CreateActivityRequest,
    opts: RequestOptions = {},
  ): Promise<CreateActivityResponse> {
    return this.transport.request<CreateActivityResponse>(
      { method: "POST", path: `${this.org(orgId)}/prospects/${encodeURIComponent(prospectId)}/activities`, body },
      opts,
    );
  }
}
