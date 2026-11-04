// Only for isolated HTTP fixtures; never imported by application code.
export const fixtureAdmin = "11111111-1111-4111-8111-111111111111";
export function fixtureSession(id = fixtureAdmin) {
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const access_token = [
    Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString(
      "base64url",
    ),
    Buffer.from(
      JSON.stringify({
        sub: id,
        role: "authenticated",
        aud: "authenticated",
        exp,
      }),
    ).toString("base64url"),
    "fixture",
  ].join(".");
  return {
    access_token,
    refresh_token: "fixture-refresh",
    token_type: "bearer",
    expires_in: 3600,
    expires_at: exp,
    user: { id, aud: "authenticated", app_metadata: {}, user_metadata: {} },
  };
}
export function fixtureCookie(id = fixtureAdmin) {
  return (
    "base64-" +
    Buffer.from(JSON.stringify(fixtureSession(id))).toString("base64url")
  );
}
