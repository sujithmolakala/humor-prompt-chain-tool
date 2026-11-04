# Humor Study Studio

Independent Next.js application for designing, executing, and reviewing image-to-humor prompt workflows. Shares the existing Humor Study Supabase backend. Access requires Google sign-in and a live `profiles.is_superadmin === true` check.

**Readiness:** implementation and local validation are separate from hosted rollout. Hosted SQL and authentication settings are never applied automatically. See [SUBMISSION.md](SUBMISSION.md) for verified deployment evidence and pending steps.

## Features

- Responsive sidebar workspace, actual database counts, recent chains and generations.
- Search/filter, chain metadata CRUD, atomic duplication, direct editor links.
- Step prompt/model/purpose CRUD, duplication, draggable handles, up/down buttons, keyboard Alt+arrow ordering.
- Optimistic concurrency through the shared runtime revision; all step IDs must occur exactly once in a transactional reorder. Errors reload authoritative ordering. Unsaved edits warn on navigation and browser unload.
- Real sequential Gemini execution with uploaded JPEG/PNG/WebP image, intermediate output propagation, original image at every step, streamed status, five final captions.
- Private input media, immutable snapshots, paginated chain-specific execution history, individual traces and existing public runtime telemetry.
- Light, dark, and operating-system themes, persistent browser preference, early theme initialization.
- Google PKCE OAuth, separate cookie namespace, server and SQL authorization, same-origin mutations, private no-store responses, bounded inputs, safe errors, rate limits, idempotent reservation and no automatic provider retry.

## Architecture

Next.js App Router / strict TypeScript / React / Tailwind CSS / Supabase SSR. Server pages and each API independently verify the live user and superadmin identity. Every database mutation RPC additionally calls `admin_assert()`. No service-role credential is needed. Gemini key is used only on the server.

`lib/chain-execution.ts` adapts the existing structured engine. `app/api/execute` normalizes an image with Sharp, writes private storage, reserves `pct_start`, streams each operation, records each validated output, and confirms completion only after durable persistence. `lib/provider.ts` sends real requests to the database-selected Gemini model. It never substitutes mock content. Test mocks exist exclusively in explicit Playwright preload/fixture scripts outside the application bundle.

See [docs/DISCOVERY.md](docs/DISCOVERY.md) for actual table mapping and reused code.

## Local setup

```sh
cd /Users/sm/IdeaProjects/humor-prompt-chain-tool
npm ci
cp .env.example .env.local
# Edit .env.local securely with values from the existing Supabase project.
npm run dev
```

Open http://localhost:3002. The other apps can keep their existing ports. Use Node 22+ (validated with Node 24) and npm. The committed lockfile pins compatible versions. Default dev uses Webpack to match the validated production build.

| Variable | Visibility | Purpose |
| --- | --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | Public | Same project URL as the other apps |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Public | Publishable/anon client configuration; access still requires auth and RLS |
| `GEMINI_API_KEY` | Secret, server only | Actual model generation and explicit capability probe |
| `APP_ORIGIN` | Server configuration | Exact canonical origin, local `http://localhost:3002` or own Vercel production domain |

`GEMINI_MODEL` is not required for execution: each step resolves the existing database model/default, including temperature and max_tokens. Never set server secrets with a `NEXT_PUBLIC_` prefix. Never commit `.env.local`, tokens, `.vercel`, `.next` or screenshots containing private production data. `.env.example` has placeholders only.

## Authentication

Humor Study Studio uses the same Supabase project and existing superadmin profiles as `ai-rating-admin`. Any Google account domain is eligible to authenticate; only `profiles.is_superadmin === true` grants access. There is no domain filter, separate administrator membership, or second user database. See [the branding and authentication review](docs/BRANDING-AUTH-REVIEW.md) for the production deployment discrepancy and callback configuration.

Reuse existing Google provider configuration. The host-only cookie namespace is `humor-prompt-chain-auth`; existing app sessions are unaffected. Login uses a verifier cookie and an exact callback, with return context in a separate short-lived HttpOnly cookie. Callback handles expired/missing verifiers and does not bypass subsequent authorization. Logout clears only this app's cookies and attempts revocation. Authentication outages fail closed.

**Owner-approved Supabase redirect allowlist additions:**

- `http://localhost:3002/auth/callback`
- `https://humor-prompt-chain-tool.vercel.app/auth/callback` (currently missing from the shared allowlist; owner approval is required before adding it)

Keep existing Site URL, Google provider settings and existing redirects unchanged. No additional Google authorized redirect URI is normally needed because Google already redirects to the shared Supabase `/auth/v1/callback`. Inspect actual hosted configuration before making any change. A new Vercel domain alone does not establish working OAuth.

## Database dependencies and safe migration review

Do not run a blanket `supabase db push` against the shared project.

1. Inspect hosted schema with the read-only `supabase/scripts/preflight-prompt-runtime.sql`. Confirm the original rating-app and admin migrations are already installed. Resolve drift before proceeding.
2. Existing admin catalog prerequisite: `202610280001_admin_catalog_management.sql`; runtime prerequisite: `202611010001_prompt_execution.sql`. The latter is copied from the admin and was documented there as pending hosted approval. If absent, review its complete dependencies and obtain approval before applying. Do not replay the older catalog migration after the runtime upgrade.
3. Review the new `202611030001_chain_tool.sql`: adds only `pct_runs`, `pct_run_references`, checked execution/history RPCs, private storage bucket and bucket-scoped RLS fences. FK restrict actions protect chains/steps/models referenced by tool executions. Existing data is not rewritten. It is a once-only migration, intentionally failing rather than silently adopting existing objects.
4. Review `202611030002_chain_duplication.sql`: adds a superadmin-only duplication RPC using the same configuration revision lock. New chains are inactive, and steps keep original settings and get fresh IDs.
5. Obtain explicit owner approval, then install only the missing reviewed migrations in order. This repository does not connect a migration runner to hosted Supabase. Signup hook/configuration is unnecessary and excluded.
6. Verify role denials and private storage with separate hosted test identities before live generation. Approve an existing image-capable Gemini model through Settings (explicitly labeled real billable probe).

RLS is enabled with no direct table grants for `pct_*` journals. Only checked functions are executable by authenticated clients. Storage restrictive policies constrain just the new bucket, even if legacy permissive policies exist. Images cannot be overwritten/deleted through ordinary API clients. Shared chain editing intentionally changes future configurations; the application does not activate or change the existing public mix or public runtime feature flag.

## Execution and template contract

Select a chain with 1–4 approved, enabled model steps in persisted order. Upload a non-animated JPEG, PNG, or WebP up to 3 MB / 20 megapixels. The server verifies actual file content, strips metadata, rotates and normalizes WebP to bounded dimensions.

Example new workflow (create explicitly; never seeded into hosted data):

1. `image_analysis`: Describe important visual details accurately and concisely.
2. `ideation`: Using the image description, generate a funny original observation.
3. `caption_generation`: Generate five short, funny, distinct captions from the previous observation and original image.

Each step receives the original normalized image and previous structured output automatically. Templates may use `{{avoid}}` and `{{previous}}` after the first step. Unknown/malformed variables fail before model calls. Intermediate output is bounded JSON with `observations` / `ideas` arrays and/or three-caption candidate arrays for compatibility with the existing engine. The **final output is five distinct caption strings**, each at most 280 characters. Existing public three-caption execution remains unchanged in its own repository.

The final step must use `auto`, `caption_generation`, or `refinement`. Model settings are resolved from actual `llm_models` and the configured default. No arbitrary model name is silently substituted. Model-parameter edits invalidate existing adapter approval.

One run per administrator can be active within three minutes; maximum 30 new starts/hour. Each provider call has a 20-second timeout, the workflow has a 95-second budget, and Vercel route duration is 120 seconds. Select a plan supporting that duration. Supabase reservation is serialized per administrator and carries immutable attribution. Reusing the same request ID does not issue another model call. No automatic resume or provider retry is claimed; transport uncertainty can mean a charge occurred. Inspect history before explicitly preparing a new billable run.

## Reordering and history

Drag a step handle onto another card, use Move up/down, or focus the handle and press Alt+Up/Down. The UI waits for database confirmation. SQL checks exact membership, uses temporary positions to avoid uniqueness conflicts, saves transactionally, increments the revision, and rejects competing stale saves. Local PostgreSQL tests use two independent connections to verify this behavior.

Tool history paginates 20 runs and filters by true chain UUID in SQL, not by current name or only the latest global page. Original name, prompts, model parameters and order stay in a snapshot. Foreign keys retain referenced chains/steps/models; deletion prompts explain that historical items cannot be removed. Input images are served through an authenticated no-store API. No public signed URL is embedded.

Public runtime history is shown separately using the existing latest-20 telemetry RPC; that section is explicitly limited, not complete pagination. Earlier legacy generations without reliable chain attribution are not relabeled. Renames never reassign history. Runs interrupted by a killed worker remain running/unconfirmed and are flagged in detail after three minutes. There is no automatic stale-record rewrite, refund, or reliable resume. Orphaned uploads from pre-reservation failures can remain private; cleanup must be reviewed independently and must not delete referenced inputs.

## Testing

```sh
npm run lint
npm run typecheck
npm test
node --import tsx scripts/test-native.mts
npm run build
npm run test:ui
npm audit --omit=dev
```

Unit/integration tests use disposable PGlite PostgreSQL and mocked provider transport, never production identities/credentials. SQL covers auth denials, CRUD, transactional reorders, stale revisions, duplicate IDs, duplication, persisted positions, idempotency, private media, failure history and immutable attribution. Native PostgreSQL requires `initdb`, `pg_ctl`, and `psql` on PATH; it starts its own temporary Unix-socket-only cluster and stops it in finally. Logs stay in the printed temp directory. It does not read a hosted database URL.

Playwright starts a disposable backend and isolated Next server on localhost ports 4319 and 4318. It uses explicit fake sessions and a test-only fetch preload; there is no application auth bypass. Chrome defaults to `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`; override `CHROME_PATH` if needed. Browser tests cover auth/API enforcement, editor CRUD/reorder across reload/separate sessions, live streaming with explicitly mocked Gemini, image context, history, provider failure, CSRF, invalid upload, themes and responsive overflow. Live Google and Gemini verification remain separate from mocks. See [docs/VALIDATION.md](docs/VALIDATION.md) for actual results.

## GitHub and Vercel deployment

The new repository and project must both be `humor-prompt-chain-tool`, owner `sujithmolakala`. Do not link or deploy either existing application. Confirm the authenticated Vercel account/team before creating the new project.

```sh
npx vercel login
npx vercel whoami
npx vercel link --project humor-prompt-chain-tool
npx vercel git connect https://github.com/sujithmolakala/humor-prompt-chain-tool.git
# Add variables using secure interactive prompts, for production (and preview if needed):
npx vercel env add NEXT_PUBLIC_SUPABASE_URL production
npx vercel env add NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY production
npx vercel env add GEMINI_API_KEY production
npx vercel env add APP_ORIGIN production
npx vercel --prod
npx vercel ls humor-prompt-chain-tool
```

Choose a NEW project during link; never select an existing app. Use Vercel's GitHub integration to ensure deployments derive from this repository's commits. Configure `APP_ORIGIN` to the verified new production alias, then redeploy if changed. Set production environment values securely, never in README, CLI history, logs, or Git. Keep Gemini secret server-only.

For this new project only, disable Vercel Authentication/Deployment Protection in Settings → Deployment Protection, preserving application Google/superadmin access. Test in a fresh Incognito context: login page must load without Vercel login, protected APIs must deny access, and a non-superadmin must be denied after Google login. Do not disable protection on either existing project. Obtain approval before changing hosted Supabase Auth redirects.

Retrieve commit-specific URLs via Vercel deployments/inspect and match each source SHA. `SUBMISSION.md` must use deployment URLs, not a generic production alias. Existing public URL evidence was recovered through GitHub's deployments API; admin GitHub status currently links only to its Vercel deployment dashboard. The authenticated Vercel owner can retrieve the URL there without redeploying.

## Known limitations

Hosted schema, real Google login, actual paid model output, production private storage, production execution duration and Incognito deployment access require live verification after approved setup. No source inspection or mocked test proves those checks. The shared runtime supports up to four steps and model-level parameters, not invented step names, descriptions, input-source columns or per-step parameter overrides. Mix editing is deliberately omitted to avoid accidental changes to public traffic. Tool output is caption text with input previews, not invented generated image/video media. Admin/current legacy telemetry is limited to its existing RPC contract. Development-only lint dependencies inherit moderate audit advisories; production dependency audit is separate.
