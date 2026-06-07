// All failure modes return RelayError - never plain strings (RELY-01)

export type ErrorCode =
  | "TIMEOUT"
  | "AUTH_FAILURE"
  | "BINARY_NOT_FOUND"
  | "VERSION_TOO_OLD"
  | "WORKDIR_NOT_FOUND"
  | "WORKDIR_OUTSIDE_ALLOWED_ROOTS"
  | "WORKDIR_DENIED"
  | "SSRF_BLOCKED"
  | "CODEX_ERROR"
  | "INVALID_ARGS"
  | "PROVIDER_ERROR"
  | "PROVIDER_NOT_CONFIGURED"
  | "ADAPTER_PROTOCOL_ERROR"
  | "SNAPSHOT_FAILED"
  | "INPUT_TOO_LARGE"
  | "UNSUPPORTED"
  | "DISPATCH_REJECTED"
  | "BUDGET_EXCEEDED"
  | "RUN_NOT_FOUND"
  | "SIGN_OFF_EXISTS"
  | "VALIDATION_SELF_APPROVAL"
  | "CRITICAL_FINDING_BLOCKS_SIGN_OFF"
  | "AUTH_FAILED"
  | "CONFIG_ERROR"
  | "CREDENTIAL_DECRYPT_FAILED"
  | "APPROVAL_REQUIRED"
  | "LOCK_TIMEOUT"
  | "HOOK_ABORT"
  | "MEMORY_WRITE_RATE_EXCEEDED"
  | "MEMORY_WORKDIR_FORBIDDEN"
  // Phase 8 — universal control layer (broker policy + adapter registry).
  | "CONTROL_SESSION_NOT_FOUND"
  | "CONTROL_DELIVERY_UNSUPPORTED"
  | "CONTROL_GRANT_REQUIRED"
  | "CONTROL_GRANT_EXPIRED"
  | "CONTROL_BUDGET_EXHAUSTED"
  | "CONTROL_SELF_SEND_BLOCKED"
  | "CONTROL_LOOP_DETECTED"
  | "CONTROL_ADAPTER_DUPLICATE"
  | "UNKNOWN";

export interface RelayError {
  code: ErrorCode;
  message: string;
  retryable: boolean;
  feature?: string;
}

export type RelayException = Error & RelayError;

/**
 * Factory for structured errors. The `retryable` flag guides CC on whether
 * to re-invoke the delegate tool automatically.
 */
export function makeError(
  code: ErrorCode,
  message: string,
  retryable: boolean,
  feature?: string
): RelayError {
  return { code, message, retryable, ...(feature ? { feature } : {}) };
}

export function toRelayException(error: RelayError): RelayException {
  return Object.assign(new Error(error.message), error);
}

export class RelayError implements RelayError {
  constructor(
    public code: ErrorCode,
    public message: string,
    public retryable: boolean,
    public feature?: string
  ) {}

  static notFound(resource: string): RelayError {
    return new RelayError('RUN_NOT_FOUND', `${resource} not found`, false);
  }
}

export const RELAY_ERROR_CODES: readonly ErrorCode[] = [
  "TIMEOUT",
  "AUTH_FAILURE",
  "BINARY_NOT_FOUND",
  "VERSION_TOO_OLD",
  "WORKDIR_NOT_FOUND",
  "WORKDIR_OUTSIDE_ALLOWED_ROOTS",
  "WORKDIR_DENIED",
  "SSRF_BLOCKED",
  "CODEX_ERROR",
  "INVALID_ARGS",
  "PROVIDER_ERROR",
  "PROVIDER_NOT_CONFIGURED",
  "ADAPTER_PROTOCOL_ERROR",
  "SNAPSHOT_FAILED",
  "INPUT_TOO_LARGE",
  "UNSUPPORTED",
  "DISPATCH_REJECTED",
  "BUDGET_EXCEEDED",
  "RUN_NOT_FOUND",
  "SIGN_OFF_EXISTS",
  "VALIDATION_SELF_APPROVAL",
  "CRITICAL_FINDING_BLOCKS_SIGN_OFF",
  "AUTH_FAILED",
  "CONFIG_ERROR",
  "CREDENTIAL_DECRYPT_FAILED",
  "APPROVAL_REQUIRED",
  "LOCK_TIMEOUT",
  "HOOK_ABORT",
  "MEMORY_WRITE_RATE_EXCEEDED",
  "MEMORY_WORKDIR_FORBIDDEN",
  "CONTROL_SESSION_NOT_FOUND",
  "CONTROL_DELIVERY_UNSUPPORTED",
  "CONTROL_GRANT_REQUIRED",
  "CONTROL_GRANT_EXPIRED",
  "CONTROL_BUDGET_EXHAUSTED",
  "CONTROL_SELF_SEND_BLOCKED",
  "CONTROL_LOOP_DETECTED",
  "CONTROL_ADAPTER_DUPLICATE",
  "UNKNOWN",
] as const;
