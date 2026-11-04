import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { cookieOptions, publicConfig } from "@/lib/supabase/config";
import { checkOrigin, privateHeaders } from "@/lib/security";
import { apiError } from "@/lib/http";
import { isAdminAuthCookie, SIGN_OUT_TIMEOUT_MS } from "@/lib/sign-out";

export async function POST(request: NextRequest) {
  try {
    checkOrigin(request);
  } catch (error) {
    return apiError(error);
  }
  const start = performance.now();
  const response = new NextResponse(null, {
    status: 303,
    headers: {
      ...privateHeaders,
      Location: "/sign-in",
      "Clear-Site-Data": '"cache"',
    },
  });
  const controller = new AbortController();
  let acceptWrites = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let revoked = false;
  try {
    const { url, key } = publicConfig();
    const client = createServerClient(url, key, {
      cookieOptions,
      global: {
        fetch: (input, init) =>
          fetch(input, {
            ...init,
            cache: "no-store",
            signal: AbortSignal.any([
              controller.signal,
              ...(init?.signal ? [init.signal] : []),
            ]),
          }),
      },
      cookies: {
        getAll: () => request.cookies.getAll(),
        setAll: (entries) => {
          if (acceptWrites)
            entries.forEach(({ name, value, options }) =>
              response.cookies.set(name, value, options),
            );
        },
      },
    });
    // Revoke the current refresh session when reachable, without making local
    // logout depend on a refresh retry/network outage. Late writes are ignored.
    revoked = await Promise.race([
      client.auth
        .signOut({ scope: "local" })
        .then(({ error }) => !error)
        .catch(() => false),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => {
          controller.abort();
          resolve(false);
        }, SIGN_OUT_TIMEOUT_MS);
      }),
    ]);
  } catch {
    /* Local cookie removal also works during configuration outages. */
  } finally {
    if (timer) clearTimeout(timer);
    acceptWrites = false;
    controller.abort();
    for (const { name } of [
      ...request.cookies.getAll(),
      ...response.cookies.getAll(),
    ]) {
      if (isAdminAuthCookie(name))
        response.cookies.set(name, "", {
          path: cookieOptions.path,
          sameSite: cookieOptions.sameSite,
          secure: cookieOptions.secure,
          maxAge: 0,
        });
    }
  }
  if (!revoked) response.headers.set("Location", "/sign-in?logout=local");
  response.headers.set(
    "Server-Timing",
    `sign_out;dur=${Math.round(performance.now() - start)}`,
  );
  // Enhanced forms avoid fetching the redirect page twice. Native forms keep
  // the 303 fallback when JavaScript is unavailable.
  if (request.headers.get("accept") === "application/json") {
    const destination = response.headers.get("Location");
    response.headers.delete("Location");
    response.headers.set("Content-Type", "application/json");
    return new NextResponse(JSON.stringify({ redirect: destination }), {
      status: 200,
      headers: response.headers,
    });
  }
  return response;
}
