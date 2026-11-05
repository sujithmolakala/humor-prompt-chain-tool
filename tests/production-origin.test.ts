import { test } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { configuredAppOrigin, productionOrigin } from "../lib/security";
import { proxy } from "../proxy";
import nextConfig from "../next.config";

test("production login redirects remain on the canonical studio domain and invalid origins fail closed", async () => {
  const previous = {
    APP_ORIGIN: process.env.APP_ORIGIN,
    VERCEL_ENV: process.env.VERCEL_ENV,
  };
  process.env.VERCEL_ENV = "production";
  try {
    process.env.APP_ORIGIN = productionOrigin;
    assert.equal(configuredAppOrigin(), productionOrigin);
    const rules = await nextConfig.redirects!();
    const login = rules.find((rule) => rule.source === "/login")!;
    assert.equal(
      new URL(login.destination, productionOrigin).href,
      `${productionOrigin}/sign-in`,
    );
    const page = await proxy(new NextRequest(`${productionOrigin}/sign-in`));
    assert.equal(page.headers.get("location"), null);
    assert.equal(page.status, 200);
    const alias = await proxy(
      new NextRequest("https://preview.invalid/sign-in?next=/chains"),
    );
    assert.equal(alias.status, 307);
    assert.equal(
      alias.headers.get("location"),
      `${productionOrigin}/sign-in?next=/chains`,
    );
    for (const invalid of [
      undefined,
      "",
      "not a URL",
      "https://humor-prompt-chain-tool.vercel.app",
      "https://unrelated.invalid",
      `${productionOrigin}/path`,
      `${productionOrigin}?next=other`,
      "https://user:password@example.org",
    ]) {
      if (invalid === undefined) delete process.env.APP_ORIGIN;
      else process.env.APP_ORIGIN = invalid;
      assert.throws(configuredAppOrigin);
      for (const path of [
        "/sign-in",
        "/auth/sign-in",
        "/auth/callback",
        "/chains",
      ]) {
        const response = await proxy(
          new NextRequest(`${productionOrigin}${path}`),
        );
        assert.equal(response.status, 503);
        assert.equal(response.headers.get("location"), null);
        assert.match(response.headers.get("cache-control")!, /no-store/);
      }
    }
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
