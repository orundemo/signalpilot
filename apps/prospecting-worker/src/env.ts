export interface Env {
  PLATFORM_DB?: Hyperdrive;
  MEMBERSHIP_WORKER?: Fetcher;
  POLICY_WORKER?: Fetcher;
  BILLING_WORKER?: Fetcher;
  METERING_WORKER?: Fetcher;
  ENVIRONMENT: string;
  /**
   * Model provider credential, resolved from environment configuration so
   * swapping providers is a binding change rather than a code change. Absent
   * on environments without a key — the insights surface then falls back to
   * the deterministic template writer rather than failing.
   */
  MODEL_API_KEY?: string;
  /** Overrides the adapter's default model id. */
  MODEL_ID?: string;
}
