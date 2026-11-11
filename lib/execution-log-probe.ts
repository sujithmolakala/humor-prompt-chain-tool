import "server-only";
import {
  executionTrace,
  executionBuildInfo,
  safeFailureDiagnostic,
} from "./execution-diagnostics";
import { apiError, json } from "./http";
export async function executionLogProbe(authorize: () => Promise<unknown>) {
  const trace = executionTrace();
  trace.event("logging_probe_received", {
    method: "GET",
    route: "/api/execute",
    billableDispatch: false,
  });
  let response: Response;
  try {
    await trace.measure("logging_probe_authorization", authorize);
    trace.event("logging_probe_confirmed", { billableDispatch: false });
    response = json({
      ...executionBuildInfo(),
      invocationId: trace.invocationId,
      operation: "logging_probe",
      billableDispatch: false,
    });
  } catch (error) {
    trace.event(
      "logging_probe_rejected",
      { ...safeFailureDiagnostic(error), billableDispatch: false },
      "warn",
    );
    response = apiError(error);
  }
  response.headers.set("X-HSS-Diagnostic-Id", trace.invocationId);
  return response;
}
