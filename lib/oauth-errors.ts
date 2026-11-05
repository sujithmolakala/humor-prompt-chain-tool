// Only fixed messages are rendered; provider descriptions and URLs are untrusted.
export const oauthMessages = {
  cancelled: "Google sign-in was cancelled. Please try again.",
  provider: "Google sign-in failed. Please try again.",
  expired: "Your sign-in link expired or is invalid. Please sign in again.",
  session: "No sign-in session was created. Please try again.",
  unavailable: "Sign-in is temporarily unavailable. Please try again.",
} as const;
export function oauthMessage(value: unknown) {
  return typeof value === "string" && Object.hasOwn(oauthMessages, value)
    ? oauthMessages[value as keyof typeof oauthMessages]
    : undefined;
}

export function fragmentOAuthOutcome(hash: string) {
  const error = new URLSearchParams(hash.replace(/^#/, "")).get("error");
  return error
    ? error === "access_denied"
      ? "cancelled"
      : "provider"
    : undefined;
}
