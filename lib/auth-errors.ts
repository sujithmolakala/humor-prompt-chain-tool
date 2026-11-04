import { AppError } from "./security";

function field(error: unknown, key: string): unknown {
  return error && typeof error === "object" && key in error
    ? (error as Record<string, unknown>)[key]
    : undefined;
}
export function sessionError(error: unknown): AppError {
  const status = field(error, "status");
  const code = field(error, "code");
  if (
    status === 401 ||
    status === 403 ||
    (status === 400 && field(error, "name") === "AuthApiError") ||
    field(error, "name") === "AuthSessionMissingError" ||
    [
      "bad_jwt",
      "session_not_found",
      "refresh_token_not_found",
      "refresh_token_already_used",
      "user_not_found",
      "jwt_expired",
    ].includes(String(code))
  )
    return new AppError("Please sign in to continue.", 401);
  return new AppError(
    "Sign-in verification is temporarily unavailable. Please try again.",
    503,
  );
}
export function identityError(error: unknown): AppError {
  if (
    field(error, "code") === "42501" &&
    field(error, "message") === "Superadmin required"
  )
    return new AppError("Superadmin access is required.", 403);
  if (
    field(error, "code") === "42501" &&
    field(error, "message") === "Authentication required"
  )
    return new AppError("Please sign in to continue.", 401);
  if (field(error, "status") === 401 || field(error, "code") === "PGRST301")
    return new AppError("Please sign in to continue.", 401);
  return new AppError(
    "Account access could not be verified right now. Please try again.",
    503,
  );
}
