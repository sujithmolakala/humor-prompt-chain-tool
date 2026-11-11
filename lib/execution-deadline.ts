import "server-only";
export const EXECUTION_BUDGET_MS = 95000;
export const STANDALONE_PROVIDER_BUDGET_MS = 20000;
export class ExecutionDeadlineError extends Error {
  readonly name = "TimeoutError";
  constructor(
    public readonly source:
      "execution_deadline" | "standalone_provider_deadline",
  ) {
    super(source);
  }
}
export function executionDeadline(
  ms = EXECUTION_BUDGET_MS,
  source: ExecutionDeadlineError["source"] = "execution_deadline",
) {
  const controller = new AbortController();
  const expiresAt = Date.now() + ms;
  const timer = setTimeout(
    () => controller.abort(new ExecutionDeadlineError(source)),
    ms,
  );
  timer.unref?.();
  return {
    signal: controller.signal,
    remainingMs: () => Math.max(0, expiresAt - Date.now()),
    dispose: () => clearTimeout(timer),
  };
}
