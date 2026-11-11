export type ErrorCode =
  | "INPUT"
  | "FORMAT"
  | "FFMPEG_MISSING"
  | "MEDIA"
  | "CONFIG"
  | "AUTH"
  | "RATE_LIMIT"
  | "TIMEOUT"
  | "NETWORK"
  | "MALFORMED"
  | "EXHAUSTED"
  | "MODEL_MISSING"
  | "INSTALL"
  | "CANCELLED"
  | "BUDGET"
  | "SECURITY";
/** Deliberately excludes raw provider bodies, URLs, headers and subprocess stderr. */
export class VIEError extends Error {
  constructor(
    public code: ErrorCode,
    message: string,
    public retryable = false,
    public retryAfterMs?: number,
  ) {
    super(message);
    this.name = "VIEError";
  }
}
export function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw new VIEError("CANCELLED", "Operation cancelled");
}
export function safeError(error: unknown): VIEError {
  return error instanceof VIEError
    ? error
    : new VIEError(
        "NETWORK",
        "Operation failed; check provider configuration or runtime availability",
        true,
      );
}
