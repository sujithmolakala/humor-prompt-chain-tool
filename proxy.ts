import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { cookieOptions } from "./lib/supabase/config";
import { safeNext, requestOrigin } from "./lib/security";
import { authFetch } from "./lib/supabase/fetch";
import { sessionError } from "./lib/auth-errors";
import { authDeadline } from "./lib/auth-deadline";
import { authTimed } from "./lib/auth-timing";
export async function proxy(request: NextRequest) {
  const path = request.nextUrl.pathname;
  const finish = (response: NextResponse) => {
    response.headers.set("Cache-Control", "private, no-store, max-age=0");
    response.headers.set("X-Content-Type-Options", "nosniff");
    response.headers.set("Referrer-Policy", "same-origin");
    response.headers.set("X-Frame-Options", "DENY");
    return response;
  };
  const origin = requestOrigin(request);
  if (process.env.APP_ORIGIN && request.nextUrl.origin !== origin) {
    // 307 retains method/body; never start OAuth or write cookies on an alias.
    return finish(
      NextResponse.redirect(new URL(path + request.nextUrl.search, origin)),
    );
  }
  if (
    ["/", "/sign-in"].includes(path) &&
    (request.nextUrl.searchParams.has("code") ||
      request.nextUrl.searchParams.has("error"))
  ) {
    const callback = new URL("/auth/callback", origin);
    for (const key of [
      "code",
      "error",
      "error_code",
      "error_description",
      "sb_flow_id",
    ]) {
      const v = request.nextUrl.searchParams.get(key);
      if (v) callback.searchParams.set(key, v);
    }
    callback.searchParams.set(
      "next",
      safeNext(request.nextUrl.searchParams.get("next")),
    );
    return finish(NextResponse.redirect(callback));
  }
  if (path === "/auth/callback") return finish(NextResponse.next());
  let response = NextResponse.next({ request });
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  const isPublic = [
    "/sign-in",
    "/access-denied",
    "/auth/error",
    "/auth/sign-in",
    "/auth/sign-out",
  ].includes(path);
  // Public auth screens and logout must not wait for user verification/refresh.
  if (isPublic) return finish(response);
  if (!url || !key)
    return finish(
      isPublic
        ? response
        : path.startsWith("/api/")
          ? NextResponse.json(
              { error: "Service is not configured." },
              { status: 503 },
            )
          : NextResponse.redirect(new URL("/sign-in?setup=1", origin)),
    );
  const controller = new AbortController();
  const client = createServerClient(url, key, {
    cookieOptions,
    global: {
      fetch: (input, init) =>
        authFetch(input, {
          ...init,
          signal: AbortSignal.any([
            controller.signal,
            ...(init?.signal ? [init.signal] : []),
          ]),
        }),
    },
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll: (entries) => {
        if (controller.signal.aborted) return;
        entries.forEach(({ name, value }) => request.cookies.set(name, value));
        response = NextResponse.next({ request });
        entries.forEach(({ name, value, options }) =>
          response.cookies.set(name, value, options),
        );
      },
    },
  });
  let signedIn = false;
  try {
    // Refresh cookies here, but NEVER authorize from this untrusted session.
    // Every protected page/API independently calls getUser + admin_identity.
    const { data, error } = await authTimed("refresh-session", () =>
      authDeadline(() => client.auth.getSession(), controller),
    );
    if (error) throw error;
    signedIn = !!data.session;
  } catch (error) {
    if (sessionError(error).status === 503) {
      const unavailable = path.startsWith("/api/")
        ? NextResponse.json(
            {
              error: "Authentication is temporarily unavailable. Please retry.",
            },
            { status: 503 },
          )
        : NextResponse.redirect(new URL("/auth/error?temporary=1", origin));
      response.cookies.getAll().forEach((c) => unavailable.cookies.set(c));
      return finish(unavailable);
    }
  }
  if (!signedIn && !isPublic) {
    const blocked = path.startsWith("/api/")
      ? NextResponse.json({ error: "Please sign in." }, { status: 401 })
      : NextResponse.redirect(
          new URL(
            `/sign-in?next=${encodeURIComponent(path + request.nextUrl.search)}`,
            origin,
          ),
        );
    response.cookies.getAll().forEach((c) => blocked.cookies.set(c));
    return finish(blocked);
  }
  return finish(response);
}
export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|webp)$).*)",
  ],
};
