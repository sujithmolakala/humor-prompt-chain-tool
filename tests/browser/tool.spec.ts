import { test, expect, type BrowserContext } from "@playwright/test";
import { fixtureCookie, fixtureAdmin } from "../auth-session";
const member = "22222222-2222-4222-8222-222222222222",
  chain = "44444444-4444-4444-8444-000000000001";
async function login(context: BrowserContext, id = fixtureAdmin) {
  await context.addCookies([
    {
      name: "humor-prompt-chain-auth",
      value: fixtureCookie(id),
      url: "http://localhost:4318",
      sameSite: "Lax",
    },
  ]);
}
test("unauthenticated and non-superadmin pages and every protected API are denied", async ({
  page,
  context,
  request,
}) => {
  for (const path of [
    "/",
    "/chains",
    `/chains/${chain}`,
    "/execute",
    "/history",
    `/history/${chain}`,
    "/settings",
  ]) {
    await page.goto(path);
    await expect(page).toHaveURL(/sign-in/);
  }
  for (const path of [
    "/api/chains",
    "/api/history",
    `/api/history/${chain}/image`,
  ])
    expect((await request.get(path)).status()).toBe(401);
  await login(context, member);
  await page.goto("/chains");
  await expect(page).toHaveURL(/access-denied/);
  expect((await context.request.get("/api/chains")).status()).toBe(403);
  for (const path of ["/api/chains", "/api/duplicate", "/api/execute"]) {
    const r = await context.request.post(path, {
      headers: { origin: "http://localhost:4318" },
      data: {},
    });
    expect(r.status()).toBe(403);
  }
});
test("superadmin CRUD, duplicate, reorder across reload/session, safe deletion and responsive layout", async ({
  page,
  context,
  browser,
}) => {
  await login(context);
  await page.goto("/chains");
  await page.getByText("Create prompt chain", { exact: true }).click();
  await page.getByLabel("Name", { exact: true }).fill("Browser workflow");
  await page
    .getByLabel("Description", { exact: true })
    .fill("Created through real application routes and disposable SQL.");
  await page.getByRole("button", { name: "Create inactive chain" }).click();
  await expect(
    page.getByRole("link", { name: "Browser workflow" }),
  ).toBeVisible();
  await page.getByRole("link", { name: "Browser workflow" }).click();
  for (const prompt of [
    "First image description",
    "Second humorous observation",
    "Third caption generator",
  ]) {
    await page.getByText("Add workflow step", { exact: true }).click();
    const form = page
      .locator("details")
      .filter({ has: page.getByText("Add workflow step", { exact: true }) });
    await form.getByLabel("Prompt template").fill(prompt);
    await form.getByRole("button", { name: "Add step", exact: true }).click();
    await expect(page.getByText("Saved to Supabase.")).toBeVisible();
    await page.getByText("Add workflow step", { exact: true }).click();
  }
  await page
    .getByRole("button", { name: "Move step 3 up", exact: true })
    .click();
  await expect(page.getByText("Saved to Supabase.")).toBeVisible();
  await page.reload();
  await expect(
    page.locator(".step-card").nth(1).getByLabel("Prompt template"),
  ).toHaveValue("Third caption generator");
  const another = await browser.newContext();
  await login(another);
  const second = await another.newPage();
  await second.goto(page.url());
  await expect(
    second.locator(".step-card").nth(1).getByLabel("Prompt template"),
  ).toHaveValue("Third caption generator");
  await another.close();
  const handle = page.getByRole("button", {
    name: "Reorder step 2",
    exact: true,
  });
  await handle.focus();
  await handle.press("Alt+ArrowDown");
  await expect(page.getByText("Saved to Supabase.")).toBeVisible();
  await page.reload();
  await expect(
    page.locator(".step-card").nth(2).getByLabel("Prompt template"),
  ).toHaveValue("Third caption generator");
  await page
    .getByRole("button", { name: "Reorder step 3", exact: true })
    .dragTo(page.locator(".step-card").nth(1));
  await expect(page.getByText("Saved to Supabase.")).toBeVisible();
  await page.reload();
  await expect(
    page.locator(".step-card").nth(1).getByLabel("Prompt template"),
  ).toHaveValue("Third caption generator");
  await page
    .getByRole("button", { name: "Duplicate step 1", exact: true })
    .click();
  await expect(page.locator(".step-card")).toHaveCount(4);
  page.once("dialog", (d) => d.accept());
  await page
    .getByRole("button", { name: "Delete step 4", exact: true })
    .click();
  await expect(page.locator(".step-card")).toHaveCount(3);
  await page.getByText("Chain details and actions", { exact: true }).click();
  await page
    .getByLabel("Name", { exact: true })
    .fill("Browser workflow revised");
  await page.getByRole("button", { name: "Save details", exact: true }).click();
  await expect(page.getByText("Saved to Supabase.")).toBeVisible();
  await page
    .getByRole("button", { name: "Duplicate chain", exact: true })
    .click();
  await expect(page.getByText("Saved to Supabase.")).toBeVisible();
  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "Delete chain", exact: true }).click();
  await page.goto("/chains");
  await expect(
    page.getByRole("link", { name: "Browser workflow revised", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("link", {
      name: "Browser workflow revised (copy)",
      exact: true,
    }),
  ).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});
test("real streaming route with explicit mocked Gemini: sequential output, original image, five captions and saved history", async ({
  page,
  context,
  request,
}) => {
  await request.post("http://localhost:4319/__test/generation", {
    data: { mode: "success" },
  });
  await login(context);
  await page.goto(`/execute?chain=${chain}`);
  const image = await request.get("http://localhost:4319/__test/image");
  await page.getByLabel("Upload input image").setInputFiles({
    name: "input.webp",
    mimeType: "image/webp",
    buffer: await image.body(),
  });
  await page.getByRole("button", { name: "Run chain →", exact: true }).click();
  await expect(
    page.getByText("Execution completed", { exact: true }),
  ).toBeVisible();
  await expect(page.locator(".caption")).toHaveCount(5);
  const counts = await (
    await request.get("http://localhost:4319/__test/generation")
  ).json();
  expect(counts).toEqual({ calls: 3, imageReceived: true });
  await page.getByRole("link", { name: "Inspect saved execution" }).click();
  await expect(
    page.getByRole("heading", { name: "Execution trace" }),
  ).toBeVisible();
  await expect(page.locator(".caption")).toHaveCount(5);
  await page.getByRole("link", { name: "Chain history", exact: true }).click();
  await expect(page.locator(".history-row")).toHaveCount(1);
});
test("model failure persists and CSRF/invalid uploads fail without provider calls", async ({
  page,
  context,
  request,
}) => {
  await request.post("http://localhost:4319/__test/generation", {
    data: { mode: "failure" },
  });
  await login(context);
  expect(
    (
      await context.request.post("/api/chains", {
        headers: { origin: "https://evil.invalid" },
        data: {},
      })
    ).status(),
  ).toBe(403);
  const invalid = await context.request.post("/api/execute", {
    headers: { origin: "http://localhost:4318" },
    multipart: {
      chainId: chain,
      requestId: crypto.randomUUID(),
      image: {
        name: "bad.png",
        mimeType: "image/png",
        buffer: Buffer.from("invalid"),
      },
    },
  });
  expect(invalid.status()).toBe(400);
  await page.goto(`/execute?chain=${chain}`);
  const image = await request.get("http://localhost:4319/__test/image");
  await page.getByLabel("Upload input image").setInputFiles({
    name: "input.webp",
    mimeType: "image/webp",
    buffer: await image.body(),
  });
  await page.getByRole("button", { name: "Run chain →", exact: true }).click();
  await expect(page.locator(".notice[role=alert]")).toContainText("rate limit");
  await page.getByRole("link", { name: "Inspect saved execution" }).click();
  await expect(page.getByText("failed", { exact: true })).toBeVisible();
  expect(
    (
      await (
        await request.get("http://localhost:4319/__test/generation")
      ).json()
    ).calls,
  ).toBe(1);
});
test("light, dark and system themes persist and follow OS changes", async ({
  page,
  context,
}) => {
  await login(context);
  await page.goto("/");
  const theme = page.getByLabel("Theme preference");
  await theme.selectOption("dark");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.reload();
  await expect(theme).toHaveValue("dark");
  await theme.selectOption("light");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await theme.selectOption("system");
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.emulateMedia({ colorScheme: "light" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await login(context);
  await page.goto("/settings");
  await expect(page.getByLabel("Theme preference").first()).toHaveValue(
    "system",
  );
});

test("desktop and mobile workspace renders without horizontal overflow", async ({
  page,
  context,
}) => {
  await login(context);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Your next great caption starts here." }),
  ).toBeVisible();
  await page.screenshot({
    path: "docs/previews/overview-desktop.png",
    fullPage: true,
  });
  await page.getByLabel("Theme preference").selectOption("dark");
  await page.screenshot({
    path: "docs/previews/overview-dark.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/chains");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "docs/previews/chains-mobile.png",
    fullPage: true,
  });
});

test("Humor Study Studio login contains exactly the requested text and unrestricted Google sign-in", async ({
  page,
}) => {
  await page.goto("/login");
  await expect(page).toHaveURL(/\/sign-in$/);
  await expect(page).toHaveTitle("Sign in · Humor Study Studio");
  const button = page.getByRole("button", {
    name: "Sign in with Google",
    exact: true,
  });
  await expect(button).toBeEnabled();
  expect(
    (await page.locator("main").innerText())
      .split("\n")
      .filter((s) => s.trim()),
  ).toEqual([
    "Humor Study Studio",
    "Authorized superadmins only",
    "Sign in with Google",
  ]);
  await expect(page.locator("main")).not.toContainText(
    /columbia|matrix|flavor/i,
  );
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({ path: "docs/previews/login-desktop.png" });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({ path: "docs/previews/login-mobile.png" });
  await page.route("http://localhost:4319/auth/v1/authorize**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/plain",
      body: "Explicit OAuth fixture destination",
    }),
  );
  const authorization = page.waitForRequest((r) =>
    r.url().startsWith("http://localhost:4319/auth/v1/authorize"),
  );
  await button.click();
  const destination = new URL((await authorization).url());
  expect(destination.searchParams.get("provider")).toBe("google");
  expect(destination.searchParams.get("redirect_to")).toBe(
    "http://localhost:4318/auth/callback",
  );
  for (const key of ["hd", "domain", "login_hint", "organization"])
    expect(destination.searchParams.has(key)).toBe(false);
});

test("chain status switches save, survive refresh, handle errors, and keep editor links usable", async ({
  page,
  context,
}) => {
  await login(context);
  await page.goto("/chains");
  const first = page.getByRole("switch", {
    name: "Active status for Chain 1",
    exact: true,
  });
  const second = page.getByRole("switch", {
    name: "Active status for Chain 2",
    exact: true,
  });
  await expect(first).toHaveAttribute("aria-checked", "false");
  await first.focus();
  await first.press("Space");
  await expect(first).toHaveAttribute("aria-checked", "true");
  await expect(first.locator("..").locator(".tag")).toHaveText("Active");
  await page.reload();
  await expect(first).toHaveAttribute("aria-checked", "true");
  await second.click();
  await expect(second).toHaveAttribute("aria-checked", "true");
  await first.click();
  await expect(first).toHaveAttribute("aria-checked", "false");
  await page.reload();
  await expect(first).toHaveAttribute("aria-checked", "false");
  // Save elsewhere after this tab loaded: its next toggle must fail with 409.
  const state = await (await context.request.get("/api/chains")).json();
  const elsewhere = await context.request.post("/api/chains", {
    headers: { origin: "http://localhost:4318" },
    data: {
      operation: "set_chain_active",
      payload: { id: chain, enabled: true },
      revision: state.settings.revision,
    },
  });
  expect(elsewhere.status()).toBe(200);
  await second.click();
  await expect(page.getByRole("alert")).toContainText(
    "changed in another session",
  );
  await expect(second).toHaveAttribute("aria-checked", "true");
  await page.reload();
  await page.route("**/api/chains", async (route) => {
    if (route.request().method() === "POST") {
      await route.fulfill({
        status: 503,
        json: { error: "Saving is temporarily unavailable. Try again." },
      });
    } else await route.continue();
  });
  await first.click();
  await expect(page.getByRole("alert")).toContainText(
    "temporarily unavailable",
  );
  await expect(first).toHaveAttribute("aria-checked", "true");
  await page.unroute("**/api/chains");
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(first).toBeVisible();
  const card = first.locator("xpath=ancestor::section");
  await card.getByRole("link", { name: "Open editor" }).click();
  await expect(page).toHaveURL(new RegExp(`/chains/${chain}$`));
  await expect(page.getByRole("switch")).toHaveCount(0);
});
