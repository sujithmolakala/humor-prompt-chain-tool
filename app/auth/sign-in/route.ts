import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { cookieOptions, publicConfig } from "@/lib/supabase/config";
import { requestOrigin, safeNext, privateHeaders } from "@/lib/security";
import { authFetch } from "@/lib/supabase/fetch";
import {
  oauthContextName,
  oauthContextOptions,
  encodeOAuthContext,
} from "@/lib/oauth-context";
import { logOAuthFailure } from "@/lib/oauth-diagnostics";
export async function GET(request: NextRequest) {
  const origin = requestOrigin(request);
  // Canonicalize BEFORE creating a host-only verifier cookie.
  if (request.nextUrl.origin !== origin) {
    return NextResponse.redirect(
      new URL(request.nextUrl.pathname + request.nextUrl.search, origin),
    );
  }
  const response = NextResponse.redirect(new URL("/sign-in", origin));
  Object.entries(privateHeaders).forEach(([key, value]) =>
    response.headers.set(key, value),
  );
  try {
    const { url, key } = publicConfig();
    const client = createServerClient(url, key, {
      cookieOptions,
      auth: { experimental: { appendPkceFlowIdToRedirects: false } },
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
    const callback = new URL("/auth/callback", origin);
    const { data, error } = await client.auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo: callback.toString(),
        skipBrowserRedirect: true,
        queryParams: { prompt: "select_account" },
      },
    });
    if (error) throw error;
    if (!data.url) throw new Error("Missing provider redirect");
    // Supabase matches the entire redirect URL against its allowlist. Keep it
    // exactly /auth/callback; carry app state and flow correlation in a cookie.
    const authorization = new URL(data.url);
    if (authorization.searchParams.get("redirect_to") !== callback.toString())
      throw new Error("Unexpected OAuth callback destination");
    response.cookies.set(
      oauthContextName,
      encodeOAuthContext(
        safeNext(request.nextUrl.searchParams.get("next")),
        data.flowId,
      ),
      oauthContextOptions,
    );
    // Set-Cookie and provider redirect are delivered together, before navigation.
    response.headers.set("Location", data.url);
    return response;
  } catch (error) {
    logOAuthFailure("start", "provider_start_failed", error);
    response.headers.set(
      "Location",
      new URL("/sign-in?oauth=unavailable", origin).toString(),
    );
    return response;
  }
}
