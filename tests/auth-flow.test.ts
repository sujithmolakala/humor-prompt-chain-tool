import { test } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { verifySuperadmin, type AuthSource } from "../lib/auth-core";
import { AppError } from "../lib/security";
import { POST as signOut } from "../app/auth/sign-out/route";
import { GET as callback } from "../app/auth/callback/route";
import { fixtureCookie, fixtureSession, fixtureAdmin } from "./auth-session";
import { isAdminAuthCookie, SIGN_OUT_TIMEOUT_MS } from "../lib/sign-out";
import { authFetch } from "../lib/supabase/fetch";
const unavailable = (e: unknown) => e instanceof AppError && e.status === 503;
const denied = (e: unknown) => e instanceof AppError && e.status === 403;
const unsigned = (e: unknown) => e instanceof AppError && e.status === 401;
const source = (): AuthSource => ({
  auth: {
    getUser: async () => ({
      data: { user: { id: fixtureAdmin } },
      error: null,
    }),
  },
  rpc: async () => ({ data: fixtureSession().user, error: null }),
});
test("authentication distinguishes unavailable services from expired sessions and genuine role denial", async () => {
  const client = source();
  for (const error of [
    new Error("network"),
    { status: 503 },
    { status: 0, name: "AuthRetryableFetchError" },
  ]) {
    client.auth.getUser = async () => ({ data: { user: null }, error });
    await assert.rejects(verifySuperadmin(client), unavailable);
  }
  for (const error of [
    { status: 401, code: "bad_jwt" },
    { status: 400, code: "refresh_token_not_found" },
    { name: "AuthSessionMissingError" },
  ]) {
    client.auth.getUser = async () => ({ data: { user: null }, error });
    await assert.rejects(verifySuperadmin(client), unsigned);
  }
  client.auth = source().auth;
  for (const error of [
    { code: "PGRST202" },
    { code: "42501", message: "permission denied for function admin_identity" },
    { status: 503 },
    { message: "database unavailable" },
  ]) {
    client.rpc = async () => ({ data: null, error });
    await assert.rejects(verifySuperadmin(client), unavailable);
  }
  client.rpc = async () => {
    throw new Error("network");
  };
  await assert.rejects(verifySuperadmin(client), unavailable);
  client.rpc = async () => ({
    data: null,
    error: { code: "42501", message: "Superadmin required" },
  });
  await assert.rejects(verifySuperadmin(client), denied);
  client.rpc = async () => ({
    data: { id: fixtureAdmin, is_superadmin: true },
    error: null,
  });
  assert.equal(
    (await verifySuperadmin(client)).id,
    fixtureAdmin,
    "next verification recovers without permission or cookie changes",
  );
  client.rpc = async () => ({
    data: null,
    error: { status: 401, code: "PGRST301" },
  });
  await assert.rejects(verifySuperadmin(client), unsigned);
});
async function transport(action: () => Promise<void>, fetcher: typeof fetch) {
  const previous = global.fetch;
  const vars = [
    "NEXT_PUBLIC_SUPABASE_URL",
    "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
    "APP_ORIGIN",
  ] as const;
  const saved = vars.map((k) => process.env[k]);
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://fixture.invalid";
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = "fixture-public-key";
  process.env.APP_ORIGIN = "https://admin.invalid";
  global.fetch = fetcher;
  try {
    await action();
  } finally {
    global.fetch = previous;
    vars.forEach((k, i) => {
      if (saved[i] === undefined) delete process.env[k];
      else process.env[k] = saved[i];
    });
  }
}
const logoutRequest = (origin = "https://admin.invalid") =>
  new NextRequest("https://admin.invalid/auth/sign-out", {
    method: "POST",
    headers: {
      origin,
      cookie: `humor-prompt-chain-auth=${fixtureCookie()}; humor-prompt-chain-auth-code-verifier=fixture; original-app-auth=untouched`,
    },
  });
test("logout revokes the local session, expires only admin cookies, and preserves CSRF and private headers", async () => {
  let calls = 0;
  await transport(
    async () => {
      const blocked = await signOut(logoutRequest("https://evil.invalid"));
      assert.equal(blocked.status, 403);
      assert.equal(calls, 0);
      const response = await signOut(logoutRequest());
      assert.equal(response.status, 303);
      assert.equal(response.headers.get("location"), "/sign-in");
      assert.equal(calls, 1);
      assert.match(response.headers.get("cache-control")!, /no-store/);
      assert.match(response.headers.get("server-timing")!, /sign_out/);
      const set = response.headers.getSetCookie().join(";");
      assert.match(set, /humor-prompt-chain-auth=;/);
      assert.match(set, /Max-Age=0/);
      assert.match(set, /humor-prompt-chain-auth-code-verifier=;/);
      assert.doesNotMatch(set, /original-app-auth/);
    },
    async (input) => {
      calls++;
      assert.match(String(input), /\/logout\?scope=local$/);
      return new Response(null, { status: 204 });
    },
  );
  assert.equal(isAdminAuthCookie("humor-prompt-chain-auth.0"), true);
  assert.equal(
    isAdminAuthCookie("humor-prompt-chain-auth-code-verifier-flow.1"),
    true,
  );
  assert.equal(isAdminAuthCookie("original-app-auth"), false);
});
test("unreachable logout is bounded and still clears the browser session", async () => {
  await transport(
    async () => {
      const start = performance.now();
      const response = await signOut(logoutRequest());
      assert.ok(performance.now() - start < SIGN_OUT_TIMEOUT_MS + 700);
      assert.equal(response.status, 303);
      assert.equal(response.headers.get("location"), "/sign-in?logout=local");
      assert.match(response.headers.getSetCookie().join(";"), /Max-Age=0/);
    },
    async (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("Aborted", "AbortError")),
          { once: true },
        );
      }),
  );
});
test("callback commits the new session on its redirect without premature authorization or an extra auth hop", async () => {
  let calls = 0;
  await transport(
    async () => {
      const response = await callback(
        new NextRequest(
          "https://admin.invalid/auth/callback?code=fixture-code&next=/chains",
          {
            headers: {
              cookie:
                'humor-prompt-chain-auth-code-verifier="fixture-verifier"',
            },
          },
        ),
      );
      assert.equal(response.status, 307);
      assert.equal(
        response.headers.get("location"),
        "https://admin.invalid/chains",
      );
      assert.match(
        response.headers.getSetCookie().join(";"),
        /humor-prompt-chain-auth=base64-/,
      );
      assert.match(response.headers.get("cache-control")!, /no-store/);
      assert.equal(calls, 1);
    },
    async (input) => {
      calls++;
      assert.match(String(input), /\/token\?grant_type=pkce$/);
      return Response.json(fixtureSession());
    },
  );
});
test("identity transport explicitly avoids caching and retains abort signals", async () => {
  const controller = new AbortController();
  await transport(
    async () => {
      await authFetch("https://fixture.invalid/auth/v1/user", {
        signal: controller.signal,
      });
    },
    async (_input, init) => {
      assert.equal(init?.cache, "no-store");
      assert.ok(init?.signal);
      controller.abort();
      assert.equal(init.signal.aborted, true);
      return Response.json({});
    },
  );
});

test("refresh retry deadlines return a temporary failure without waiting for SDK backoff", async () => {
  const { authDeadline } = await import("../lib/auth-deadline");
  const controller = new AbortController();
  const start = performance.now();
  await assert.rejects(
    authDeadline(() => new Promise(() => {}), controller, 20),
    (e) => e instanceof DOMException && e.name === "TimeoutError",
  );
  assert.equal(controller.signal.aborted, true);
  assert.ok(performance.now() - start < 500);
});
test("enhanced logout returns a local destination with cookie expiry and the native fallback remains available", async () => {
  await transport(
    async () => {
      const request = logoutRequest();
      request.headers.set("accept", "application/json");
      const response = await signOut(request);
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { redirect: "/sign-in" });
      assert.match(response.headers.getSetCookie().join(";"), /Max-Age=0/);
    },
    async () => new Response(null, { status: 204 }),
  );
});

test("server OAuth start commits verifier before redirect and callback establishes the same admin session", async () => {
  const { GET: start } = await import("../app/auth/sign-in/route");
  await transport(
    async () => {
      const response = await start(
        new NextRequest("https://admin.invalid/auth/sign-in?next=/chains"),
      );
      const authorization = new URL(response.headers.get("location")!);
      assert.equal(authorization.origin, "https://fixture.invalid");
      assert.equal(authorization.searchParams.get("provider"), "google");
      assert.ok(authorization.searchParams.get("code_challenge"));
      const destination = new URL(
        authorization.searchParams.get("redirect_to")!,
      );
      assert.equal(destination.origin, "https://admin.invalid");
      assert.equal(destination.pathname, "/auth/callback");
      assert.equal(destination.search, "");
      const cookies = response.headers.getSetCookie();
      assert.ok(
        cookies.some(
          (value) =>
            value.startsWith("humor-prompt-chain-auth") &&
            value.includes("code-verifier"),
        ),
      );
      for (const cookie of cookies) {
        assert.doesNotMatch(cookie, /Domain=/i);
        assert.match(cookie, /SameSite=Lax/i);
        assert.match(cookie, /Path=\//);
      }
      destination.searchParams.set("code", "test-authorization-code");
      const completed = await callback(
        new NextRequest(destination, {
          headers: { cookie: cookies.map((c) => c.split(";")[0]).join("; ") },
        }),
      );
      assert.equal(
        completed.headers.get("location"),
        "https://admin.invalid/chains",
      );
      assert.match(
        completed.headers.getSetCookie().join(";"),
        /humor-prompt-chain-auth=base64-/,
      );
      const authorized = source();
      authorized.rpc = async () => ({
        data: { id: fixtureAdmin, is_superadmin: true },
        error: null,
      });
      assert.equal((await verifySuperadmin(authorized)).id, fixtureAdmin);
    },
    async (input, init) => {
      assert.match(String(input), /\/token\?grant_type=pkce$/);
      const body = JSON.parse(String(init?.body));
      assert.ok(body.code_verifier);
      return Response.json(fixtureSession());
    },
  );
});

test("noncanonical OAuth starts and proxy redirects reach canonical host before any verifier is created", async () => {
  const { GET: start } = await import("../app/auth/sign-in/route");
  const { proxy } = await import("../proxy");
  await transport(
    async () => {
      const response = await start(
        new NextRequest("https://preview.invalid/auth/sign-in?next=/chains"),
      );
      assert.equal(
        response.headers.get("location"),
        "https://admin.invalid/auth/sign-in?next=/chains",
      );
      assert.equal(response.headers.getSetCookie().length, 0);
      for (const path of [
        "/sign-in",
        "/auth/error",
        "/auth/callback?code=private-code",
      ]) {
        const result = await proxy(
          new NextRequest(`https://preview.invalid${path}`),
        );
        assert.equal(
          result.headers.get("location"),
          `https://admin.invalid${path}`,
        );
      }
      const result = await start(
        new NextRequest(
          "https://admin.invalid/auth/sign-in?next=https://original.invalid",
        ),
      );
      const redirect = new URL(
        new URL(result.headers.get("location")!).searchParams.get(
          "redirect_to",
        )!,
      );
      assert.equal(redirect.search, "");
    },
    async () => {
      throw new Error("No provider request expected");
    },
  );
});

test("callback reports missing verifier and failed exchange without logging codes, cookies or SDK messages", async () => {
  const logs: string[] = [];
  const saved = console.warn;
  console.warn = (entry: unknown) => {
    logs.push(String(entry));
  };
  try {
    let calls = 0;
    await transport(
      async () => {
        const missing = await callback(
          new NextRequest(
            "https://admin.invalid/auth/callback?code=private-code&next=https://original.invalid",
          ),
        );
        assert.equal(
          missing.headers.get("location"),
          "https://admin.invalid/sign-in?oauth=expired",
        );
        assert.equal(calls, 0);
        const failed = await callback(
          new NextRequest(
            "https://admin.invalid/auth/callback?code=private-code",
            {
              headers: {
                cookie:
                  'humor-prompt-chain-auth-code-verifier="private-verifier"',
              },
            },
          ),
        );
        assert.equal(
          failed.headers.get("location"),
          "https://admin.invalid/sign-in?oauth=expired",
        );
        assert.equal(calls, 1);
      },
      async () => {
        calls++;
        return Response.json(
          {
            code: "flow_state_expired",
            error_code: "flow_state_expired",
            msg: "private-provider-message private-code private-verifier",
          },
          { status: 400 },
        );
      },
    );
    assert.ok(
      logs.some((line) => JSON.parse(line).reason === "pkce_verifier_missing"),
    );
    assert.ok(
      logs.some((line) => JSON.parse(line).code === "flow_state_expired"),
    );
    assert.doesNotMatch(
      logs.join("\n"),
      /private-code|private-verifier|private-provider-message|fixture-refresh/,
    );
  } finally {
    console.warn = saved;
  }
});

test("expired sessions return to canonical sign-in and never authorize from stale cookies", async () => {
  const { proxy } = await import("../proxy");
  const session = { ...fixtureSession(), expires_at: 1 };
  await transport(
    async () => {
      const response = await proxy(
        new NextRequest("https://admin.invalid/chains", {
          headers: {
            cookie: `humor-prompt-chain-auth=base64-${Buffer.from(JSON.stringify(session)).toString("base64url")}`,
          },
        }),
      );
      assert.equal(
        response.headers.get("location"),
        "https://admin.invalid/sign-in?next=%2Fchains",
      );
      assert.match(response.headers.getSetCookie().join(";"), /Max-Age=0/);
    },
    async () =>
      Response.json(
        { code: "refresh_token_not_found", msg: "Expired session" },
        { status: 400 },
      ),
  );
});

test("error-page sign-in link is an explicit canonical navigation, independent of next or the shared Site URL", async () => {
  const { default: AuthError } = await import("../app/auth/error/page");
  await transport(
    async () => {
      const page = await AuthError({
        searchParams: Promise.resolve({ next: "https://original.invalid" }),
      });
      const children = page.props.children.props.children as {
        type: unknown;
        props: { href?: string };
      }[];
      const link = children.find(
        (child) =>
          child?.type === "a" &&
          child.props.href === "https://admin.invalid/sign-in",
      );
      assert.ok(link);
    },
    async () => {
      throw new Error("No network expected");
    },
  );
});

test("exact production and localhost callback URLs survive a strict Supabase allowlist without Site URL fallback", async () => {
  const { GET: start } = await import("../app/auth/sign-in/route");
  const { oauthContextName, readOAuthContext } =
    await import("../lib/oauth-context");
  await transport(
    async () => {
      for (const origin of [
        "https://humor-prompt-chain-tool-ashy.vercel.app",
        "http://localhost:3002",
      ]) {
        process.env.APP_ORIGIN = origin;
        const response = await start(
          new NextRequest(`${origin}/auth/sign-in?next=/chains`),
        );
        const authorize = new URL(response.headers.get("location")!);
        assert.equal(authorize.pathname, "/auth/v1/authorize");
        const redirectTo = authorize.searchParams.get("redirect_to");
        const exactAllowed = `${origin}/auth/callback`;
        assert.equal(redirectTo, exactAllowed);
        assert.equal(new URL(redirectTo!).search, "");
        assert.equal(new URL(redirectTo!).hash, "");
        // Reproduce full-URL exact-entry matching; the old next query fails it.
        const allowlist = new Set([exactAllowed]);
        const resolve = (value: string) =>
          allowlist.has(value)
            ? value
            : "https://hello-world-nextjs-five-mu.vercel.app/auth/callback";
        assert.equal(resolve(redirectTo!), exactAllowed);
        assert.notEqual(
          resolve(`${exactAllowed}?next=%2Fchains`),
          exactAllowed,
        );
        const context = response.cookies.get(oauthContextName);
        assert.ok(context);
        const decoded = readOAuthContext(context.value);
        assert.equal(decoded?.next, "/chains");
        assert.ok(decoded?.flowId);
        const contextHeader = response.headers
          .getSetCookie()
          .find((c) => c.startsWith(oauthContextName + "="))!;
        assert.match(contextHeader, /HttpOnly/);
        assert.match(contextHeader, /Max-Age=600/);
        assert.doesNotMatch(contextHeader, /Domain=/i);
        const callbackRequest = new URL(redirectTo!);
        callbackRequest.searchParams.set("code", "fixture-code");
        const completed = await callback(
          new NextRequest(callbackRequest, {
            headers: {
              cookie: response.headers
                .getSetCookie()
                .map((c) => c.split(";")[0])
                .join("; "),
            },
          }),
        );
        assert.equal(completed.headers.get("location"), `${origin}/chains`);
        assert.equal(completed.cookies.get(oauthContextName)?.maxAge, 0);
        assert.ok(
          completed.cookies
            .get("humor-prompt-chain-auth")
            ?.value.startsWith("base64-"),
        );
      }
    },
    async (input, init) => {
      assert.match(String(input), /\/token\?grant_type=pkce$/);
      assert.ok(JSON.parse(String(init?.body)).code_verifier);
      return Response.json(fixtureSession());
    },
  );
});

test("OAuth context rejects malformed state and sanitizes external return destinations", async () => {
  const { encodeOAuthContext, readOAuthContext } =
    await import("../lib/oauth-context");
  assert.equal(readOAuthContext("not-json"), null);
  assert.equal(readOAuthContext("x".repeat(4097)), null);
  assert.equal(
    readOAuthContext(
      Buffer.from(
        JSON.stringify({ next: "/chains", flowId: "invalid" }),
      ).toString("base64url"),
    ),
    null,
  );
  assert.equal(
    readOAuthContext(
      encodeOAuthContext("https://hello-world-nextjs-five-mu.vercel.app"),
    )?.next,
    "/",
  );
});

test("provider failure, cancellation, invalid code and wrong callback host stay in Studio for production and localhost", async () => {
  await transport(
    async () => {
      for (const origin of [
        "https://humor-prompt-chain-tool-ashy.vercel.app",
        "http://localhost:3002",
      ]) {
        process.env.APP_ORIGIN = origin;
        for (const [query, outcome] of [
          [
            "error=access_denied&error_description=https://public.invalid",
            "cancelled",
          ],
          ["error=server_error&next=https://public.invalid", "provider"],
          ["code=expired&next=//public.invalid", "expired"],
          ["", "expired"],
        ]) {
          const response = await callback(
            new NextRequest(`${origin}/auth/callback?${query}`),
          );
          assert.equal(
            response.headers.get("location"),
            `${origin}/sign-in?oauth=${outcome}`,
          );
          assert.match(response.headers.get("cache-control")!, /no-store/);
          assert.equal(
            response.cookies.get("humor-prompt-chain-oauth-context")?.maxAge ??
              0,
            0,
          );
        }
        const wrong = await callback(
          new NextRequest(
            "https://public.invalid/auth/callback?code=private-code",
          ),
        );
        assert.equal(
          wrong.headers.get("location"),
          `${origin}/sign-in?oauth=expired`,
        );
      }
    },
    async () => {
      throw new Error("No exchange without the host's verifier");
    },
  );
});

test("OAuth startup failure stays on Studio sign-in with a fixed message", async () => {
  const { GET: start } = await import("../app/auth/sign-in/route");
  await transport(
    async () => {
      process.env.NEXT_PUBLIC_SUPABASE_URL = "invalid-url";
      const response = await start(
        new NextRequest(
          "https://admin.invalid/auth/sign-in?next=https://public.invalid",
        ),
      );
      assert.equal(
        response.headers.get("location"),
        "https://admin.invalid/sign-in?oauth=unavailable",
      );
    },
    async () => {
      throw new Error("No network expected");
    },
  );
});
