import "server-only";
import { randomUUID } from "node:crypto";
import { AppError } from "./security";
export const EXECUTION_DIAGNOSTICS_VERSION = "2026-11-11.1";
export type ExecutionLogLevel = "info" | "warn" | "error";
export function executionBuildInfo() {
  return {
    diagnosticsVersion: EXECUTION_DIAGNOSTICS_VERSION,
    sourceSha: /^[a-f0-9]{40}$/.test(process.env.VERCEL_GIT_COMMIT_SHA ?? "")
      ? process.env.VERCEL_GIT_COMMIT_SHA
      : undefined,
    deploymentId: /^dpl_[A-Za-z0-9]+$/.test(
      process.env.VERCEL_DEPLOYMENT_ID ?? "",
    )
      ? process.env.VERCEL_DEPLOYMENT_ID
      : undefined,
    environment: ["production", "preview", "development"].includes(
      process.env.VERCEL_ENV ?? "",
    )
      ? process.env.VERCEL_ENV
      : "unknown",
  };
}
export function writeExecutionLog(
  record: Record<string, unknown>,
  level: ExecutionLogLevel = "info",
) {
  try {
    console[level](
      JSON.stringify({
        ...record,
        service: "humor-study-studio",
        ...executionBuildInfo(),
        level,
      }),
    );
  } catch {
    /* Logging cannot change dispatch, billing or checkpoint outcomes. */
  }
}
export function executionTrace() {
  const invocationId = randomUUID(),
    started = performance.now();
  let runId: string | undefined;
  const event = (
    stage: string,
    details: Record<string, unknown> = {},
    level: ExecutionLogLevel = "info",
  ) => {
    writeExecutionLog(
      {
        event: "execution_lifecycle",
        invocationId,
        runId,
        stage,
        elapsedMs: Math.round(performance.now() - started),
        configuredFunctionBudgetMs: 120000,
        configuredExecutionBudgetMs: 95000,
        ...details,
      },
      level,
    );
  };
  return {
    invocationId,
    remainingMs: () => Math.max(0, 110000 - (performance.now() - started)),
    event,
    identify: (id: string) => {
      runId = id;
    },
    async measure<T>(stage: string, operation: () => Promise<T>) {
      const start = performance.now();
      event(stage, { state: "started" });
      try {
        const result = await operation();
        event(stage, {
          state: "acknowledged",
          operationMs: Math.round(performance.now() - start),
        });
        return result;
      } catch (error) {
        event(
          stage,
          {
            state: "unconfirmed",
            operationMs: Math.round(performance.now() - start),
            httpStatus: error instanceof AppError ? error.status : undefined,
            ...safeFailureDiagnostic(error),
          },
          "error",
        );
        throw error;
      }
    },
  };
}

const diagnosticCodes = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ETIMEDOUT",
  "EPIPE",
  "ABORT_ERR",
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_ABORTED",
  "CERT_HAS_EXPIRED",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "42501",
  "40001",
  "55000",
  "23503",
  "23505",
  "23514",
  "22023",
  "P0001",
  "P0002",
  "PGRST202",
  "42883",
  "42P01",
  "57014",
  "55P03",
]);
export function safeErrorCode(code: unknown) {
  return typeof code === "string" && diagnosticCodes.has(code)
    ? code
    : undefined;
}
// Error messages, stacks, URLs and nested payloads may contain credentials.
// Preserve only fixed exception categories and allowlisted machine codes.
export function safeFailureDiagnostic(error: unknown): Record<string, unknown> {
  try {
    const value =
      error && typeof error === "object"
        ? (error as {
            name?: unknown;
            code?: unknown;
            databaseCode?: unknown;
            cause?: { code?: unknown };
          })
        : {};
    return {
      errorType:
        typeof value.name === "string" &&
        [
          "Error",
          "TypeError",
          "SyntaxError",
          "AbortError",
          "TimeoutError",
          "AuthApiError",
          "AuthRetryableFetchError",
        ].includes(value.name)
          ? value.name
          : "other",
      errorCode: safeErrorCode(value.code),
      causeCode: safeErrorCode(value.cause?.code),
      databaseCode: safeErrorCode(value.databaseCode),
    };
  } catch {
    return { errorType: "unavailable" };
  }
}
