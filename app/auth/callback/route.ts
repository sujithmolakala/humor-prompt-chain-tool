import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { cookieOptions, publicConfig } from "@/lib/supabase/config";
import { safeNext, privateHeaders, requestOrigin } from "@/lib/security";
import { authFetch } from "@/lib/supabase/fetch";
import { authTimed } from "@/lib/auth-timing";
import {
  oauthContextName,
  oauthContextOptions,
  readOAuthContext,
} from "@/lib/oauth-context";
import { logOAuthFailure } from "@/lib/oauth-diagnostics";
export async function GET(request: NextRequest) {
  const origin = requestOrigin(request);
  // A code/verifier belongs to the initiating host. Never exchange it on an alias.
  if (request.nextUrl.origin !== origin) {
    return NextResponse.redirect(new URL("/sign-in?oauth=expired", origin), {
      headers: privateHeaders,
    });
  }
  const context = readOAuthContext(
    request.cookies.get(oauthContextName)?.value,
  );
  const queryFlowId = request.nextUrl.searchParams.get("sb_flow_id");
  const useContext =
    context && (!queryFlowId || queryFlowId === context.flowId);
  const flowId = queryFlowId || (useContext ? context.flowId : undefined);
  const verifierKey = flowId
    ? `${cookieOptions.name}-flow-${flowId}-code-verifier`
    : `${cookieOptions.name}-code-verifier`;
  const verifierPresent = request.cookies
    .getAll()
    .some(
      ({ name, value }) =>
        value.length > 0 &&
        (name === verifierKey || name.startsWith(`${verifierKey}.`)),
    );
  let reason = "configuration_missing";
  const response = NextResponse.redirect(
    new URL(
      safeNext(
        request.nextUrl.searchParams.get("next") ??
          (useContext ? context.next : null),
      ),
      origin,
    ),
  );
  // Remove short-lived app state on both successful and failed completion.
  response.cookies.set(oauthContextName, "", {
    ...oauthContextOptions,
    maxAge: 0,
  });
  Object.entries(privateHeaders).forEach(([k, v]) =>
    response.headers.set(k, v),
  );
  try {
    const { url, key } = publicConfig();
    reason = "callback_input_missing";
    const code = request.nextUrl.searchParams.get("code");
    if (request.nextUrl.searchParams.has("error")) {
      reason = "provider_callback_error";
      throw { code: request.nextUrl.searchParams.get("error_code") };
    }
    if (!code) throw new Error();
    const client = createServerClient(url, key, {
      cookieOptions,
      global: { fetch: authFetch },
      cookies: {
        getAll: () => request.cookies.getAll(),
        setAll: (entries) =>
          entries.forEach(({ name, value, options }) => {
            request.cookies.set(name, value);
            response.cookies.set(name, value, options);
          }),
      },
    });
    reason = "code_exchange_failed";
    const start = performance.now();
    const { data, error } = await authTimed("oauth-exchange", () =>
      client.auth.exchangeCodeForSession(code, flowId ? { flowId } : undefined),
    );
    response.headers.set(
      "Server-Timing",
      `oauth_exchange;dur=${Math.round(performance.now() - start)}`,
    );
    if (error) throw error;
    reason = "session_missing_after_exchange";
    if (!data.user || !data.session) throw new Error();
    // Commit all session cookies on this redirect before protected navigation.
    // The destination performs live admin verification; never prefetch it here.
    return response;
  } catch (error) {
    logOAuthFailure(
      "callback",
      reason === "code_exchange_failed" && !verifierPresent
        ? "pkce_verifier_missing"
        : reason,
      error,
      { verifierPresent, flowIdPresent: !!flowId },
    );
    const temporary =
      error &&
      typeof error === "object" &&
      (("status" in error &&
        typeof error.status === "number" &&
        error.status >= 500) ||
        ("name" in error &&
          ["AuthRetryableFetchError", "AbortError", "TimeoutError"].includes(
            String(error.name),
          )));
    const outcome = temporary
      ? "unavailable"
      : reason === "provider_callback_error"
        ? request.nextUrl.searchParams.get("error") === "access_denied"
          ? "cancelled"
          : "provider"
        : reason === "session_missing_after_exchange"
          ? "session"
          : reason === "configuration_missing"
            ? "unavailable"
            : "expired";
    const failure = NextResponse.redirect(
      new URL(`/sign-in?oauth=${outcome}`, origin),
    );
    response.cookies.getAll().forEach((c) => failure.cookies.set(c));
    Object.entries(privateHeaders).forEach(([k, v]) =>
      failure.headers.set(k, v),
    );
    return failure;
  }
}
