// Error contract types

export interface ErrorResponse {
  error: string;
  message: string;
  requestId?: string;
}

export interface ValidationErrorResponse extends ErrorResponse {
  error: "validation_failed";
  fields?: Record<string, string[]>;
}

export const ERROR_CODES = {
  BAD_REQUEST: "bad_request",
  UNAUTHENTICATED: "unauthenticated",
  FORBIDDEN: "forbidden",
  NOT_FOUND: "not_found",
  CONFLICT: "conflict",
  RATE_LIMITED: "rate_limited",
  VALIDATION_FAILED: "validation_failed",
  PRECONDITION_FAILED: "precondition_failed",
  // A metered allowance is spent. Carries `QuotaExhaustedDetails` (meter,
  // limit, reset date) so a client can render an upgrade prompt without a
  // second round trip. Returned with HTTP 402.
  QUOTA_EXHAUSTED: "quota_exhausted",
  UNSUPPORTED: "unsupported",
  INTERNAL_ERROR: "internal_error",
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];
