import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { NextRequest } from "next/server";
import { verifySuperadmin, type AuthSource } from "../lib/auth-core";
import { GET as start } from "../app/auth/sign-in/route";
import { AppError } from "../lib/security";
import {
  runtimeFixture,
  runtimeAdmin,
  runtimeUser,
} from "./helpers/prompt-hardening";

test("Google identity domain never grants or denies superadmin access", async () => {
  const id = "11111111-1111-4111-8111-111111111111";
  for (const email of [
    "personal@gmail.com",
    "professor@columbia.edu",
    "owner@example.org",
  ]) {
    const client: AuthSource = {
      auth: {
        getUser: async () => ({ data: { user: { id, email } }, error: null }),
      },
      rpc: async () => ({ data: { id, is_superadmin: true }, error: null }),
    };
    assert.equal((await verifySuperadmin(client)).id, id);
    client.rpc = async () => ({
      data: { id, is_superadmin: false },
      error: null,
    });
    await assert.rejects(
      verifySuperadmin(client),
      (e) => e instanceof AppError && e.status === 403,
    );
    client.auth.getUser = async () => ({ data: { user: null }, error: null });
    await assert.rejects(
      verifySuperadmin(client),
      (e) => e instanceof AppError && e.status === 401,
    );
  }
});

test("real admin_identity SQL authorizes existing personal and university superadmins only", async () => {
  const { db } = await runtimeFixture();
  try {
    for (const email of ["personal@gmail.com", "professor@columbia.edu"]) {
      await db.query("update profiles set email=$1 where id=$2", [
        email,
        runtimeAdmin,
      ]);
      await db.exec("set role authenticated");
      await db.query("select set_config('request.jwt.claim.sub',$1,false)", [
        runtimeAdmin,
      ]);
      const identity = (
        await db.query<{ data: { id: string; is_superadmin: boolean } }>(
          "select admin_identity() data",
        )
      ).rows[0].data;
      assert.equal(identity.id, runtimeAdmin);
      assert.equal(identity.is_superadmin, true);
      await db.query("select set_config('request.jwt.claim.sub',$1,false)", [
        runtimeUser,
      ]);
      await assert.rejects(db.query("select admin_identity()"));
      await db.exec("reset role");
    }
  } finally {
    await db.close();
  }
});

test("OAuth uses shared Google provider, exact production callback and no domain or membership hints", async () => {
  const names = [
    "APP_ORIGIN",
    "NEXT_PUBLIC_SUPABASE_URL",
    "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
  ] as const;
  const previous = names.map((k) => process.env[k]);
  process.env.APP_ORIGIN = "https://humor-prompt-chain-tool-ashy.vercel.app";
  process.env.NEXT_PUBLIC_SUPABASE_URL =
    "https://shared-humor-study.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = "fixture-public-key";
  try {
    const response = await start(
      new NextRequest(
        "https://humor-prompt-chain-tool-ashy.vercel.app/auth/sign-in",
      ),
    );
    const destination = new URL(response.headers.get("location")!);
    assert.equal(destination.hostname, "shared-humor-study.supabase.co");
    assert.equal(destination.searchParams.get("provider"), "google");
    assert.equal(
      destination.searchParams.get("redirect_to"),
      "https://humor-prompt-chain-tool-ashy.vercel.app/auth/callback",
    );
    for (const key of ["hd", "domain", "login_hint", "organization"])
      assert.equal(destination.searchParams.has(key), false);
  } finally {
    names.forEach((key, i) => {
      if (previous[i] === undefined) delete process.env[key];
      else process.env[key] = previous[i];
    });
  }
});

test("application source uses Humor Study Studio branding and role-based shared authentication", async () => {
  const login = await readFile("app/sign-in/page.tsx", "utf8");
  assert.match(login, /<h1>Humor Study Studio<\/h1>/);
  assert.match(login, /Authorized superadmins only/);
  assert.doesNotMatch(
    login,
    /eyebrow|login-flow|<Theme|Columbia|Matrix|Flavor/i,
  );
  assert.match(
    await readFile("components/Login.tsx", "utf8"),
    /Sign in with Google/,
  );
  for (const file of [
    "app/layout.tsx",
    "components/Navigation.tsx",
    "app/(tool)/layout.tsx",
  ])
    assert.match(await readFile(file, "utf8"), /Humor Study/);
  for (const file of [
    "lib/auth-core.ts",
    "lib/auth.ts",
    "app/auth/sign-in/route.ts",
    "proxy.ts",
  ])
    assert.doesNotMatch(
      await readFile(file, "utf8"),
      /matrix|columbia|email\.endsWith|allowed_domains/i,
    );
});
