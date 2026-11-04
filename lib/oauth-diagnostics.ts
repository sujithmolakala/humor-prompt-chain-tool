// Never serialize SDK errors: messages can contain URLs or credentials.
const codes = new Set([
  "bad_code_verifier",
  "flow_state_not_found",
  "flow_state_expired",
  "validation_failed",
  "invalid_grant",
  "unexpected_failure",
  "provider_disabled",
  "oauth_provider_not_supported",
  "access_denied",
]);
export function logOAuthFailure(
  stage: "start" | "callback",
  reason: string,
  error: unknown,
  context: { verifierPresent?: boolean; flowIdPresent?: boolean } = {},
) {
  const info =
    error && typeof error === "object"
      ? (error as { code?: unknown; status?: unknown })
      : {};
  console.warn(
    JSON.stringify({
      event: "admin-oauth-failure",
      stage,
      reason,
      code:
        typeof info.code === "string" && codes.has(info.code)
          ? info.code
          : "unclassified",
      status:
        typeof info.status === "number" &&
        Number.isInteger(info.status) &&
        info.status >= 0 &&
        info.status <= 599
          ? info.status
          : undefined,
      ...context,
    }),
  );
}
