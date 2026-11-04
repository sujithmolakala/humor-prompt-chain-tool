// Test preload only. Never imported by application code or used in deployments.
// Fail closed: even a mismatched test environment never reaches live Gemini.
const nativeFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const value =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url;
  if (value.startsWith("https://generativelanguage.googleapis.com/")) {
    if (
      process.env.GEMINI_API_KEY !== "fixture-provider-key" ||
      process.env.NEXT_PUBLIC_SUPABASE_URL !== "http://localhost:4319"
    )
      throw new Error("Fixture provider configuration mismatch");
    return nativeFetch("http://localhost:4319/__test/gemini", {
      ...init,
      headers: { "Content-Type": "application/json" },
    });
  }
  return nativeFetch(input, init);
};
