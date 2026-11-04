# Production domain incident — November 4, 2026 UTC

## Confirmed cause

The requested `https://humor-prompt-chain-tool.vercel.app` is not assigned to the intended project in the authenticated account. Repeated production builds cannot update a domain that this project does not own. This is a domain ownership/mapping problem, compounded by `APP_ORIGIN` redirecting the intended project's deployment URLs to that domain.

Authenticated CLI evidence:

- Account: `sujith-molakala`; project: `humor-prompt-chain-tool`.
- Project ID: `prj_qgsxvs4naoYaHlKltI9aosFLbPkN`.
- Repository mapping: `.vercel/repo.json`, directory `.`; no `.vercel/project.json` is present or required for this repository mapping.
- Hosted root directory: repository root. Git connection: `sujithmolakala/humor-prompt-chain-tool`, production branch `main`.
- Latest production deployment: `dpl_5yt5ES2basR5G7qHDCTEFNpaq1vn`, created `2026-11-04T03:33:36.982Z`, READY.
- Deployment URL: `https://humor-prompt-chain-tool-cavm5ebpa-sujith-molakala.vercel.app`.
- Deployment source: `bef497e411d9a0fd4f3f586ee6b39ae57652a50e`, branch `main`. GitHub `refs/heads/main` independently matched this SHA during investigation.
- Assigned aliases: `humor-prompt-chain-tool-ashy.vercel.app` and `humor-prompt-chain-tool-sujith-molakala.vercel.app`.
- Previous Git deployment `dpl_3GHFHdw4Fpr995jvTLcni9ESRjvY` also contains `bef497e`; the main-branch alias remains assigned to that deployment.
- `inspect` of the requested bare domain returns deployment not found in this account. Domain inspection returns no access. Alias lookup returns 404. There is only one project with this name in the authenticated team; the other two projects are the existing admin and public applications.
- Explicitly assigning the requested domain to the verified deployment fails: `The chosen alias "humor-prompt-chain-tool.vercel.app" is already in use.` The owning account, project, deployment ID and commit are not exposed to these credentials and must not be guessed.

## Live response evidence

At `2026-11-04T03:41:38Z`, an independent HTTP fetch of the requested root returned 307 to `/login`, followed by 200 HTML with title `Sign in | Humor Flavor Studio`. The response contained the old branding, Columbia email instruction and matrix-admin messaging, and lacked `Humor Study Studio`. Both responses had `x-vercel-cache: MISS`, age 0 and no-store/no-cache headers. Browser caching is not the explanation.

An authenticated `vercel curl /sign-in` against the intended deployment returned 307 to `https://humor-prompt-chain-tool.vercel.app/sign-in`. This establishes the deployed canonical origin from behavior without reading secrets. It prevents reaching the intended deployment's login through its own URL. Deployment Protection was accessed through the authenticated CLI; its configuration was not disabled.

Build logs show the expected Next.js 16.4.2 application, including `/sign-in` and `/auth/callback`, and a successful production build. The active source imports `components/Login.tsx` from `app/sign-in/page.tsx` and contains the exact three requested login texts. No obsolete strings occur in active application source. No duplicate login implementation or environment-specific branding was found. No source branding rewrite or further deployment can resolve the domain ownership conflict.

## Authentication

The local Supabase URL and publishable key equal those in `ai-rating-admin`; public project host: `qxpplzvkgugxklevbwqx.supabase.co`. `lib/auth-core.ts` is identical to the admin implementation. It verifies `auth.getUser()`, matching UUID and literal `is_superadmin === true` from `admin_identity()`. Protected pages/APIs enforce that check. Domain and Matrix membership are not authorization inputs.

Read-only public Auth settings returned HTTP 200, Google enabled, signup not globally disabled. Production environment pull returned `[SENSITIVE]` placeholders for all five values, so deployed Supabase credentials cannot be independently compared through this route. No secret values were printed or committed.

Required Supabase Redirect URL after the requested domain is recovered:

`https://humor-prompt-chain-tool.vercel.app/auth/callback`

Google's provider callback remains `https://qxpplzvkgugxklevbwqx.supabase.co/auth/v1/callback`. Prior controlled cancellation tests documented in `BRANDING-AUTH-REVIEW.md` found the studio redirect fell back to the public Site URL. This hosted allowlist issue has not been changed or revalidated as resolved. No hosted Supabase settings, migrations, users or roles were modified. Real account sign-in remains unverified.

## Validation and required next action

ESLint, TypeScript, all 24 automated tests, all seven browser scenarios and production build passed during this investigation. Tests explicitly allow personal Gmail/other-domain superadmins and reject non-superadmins. Browser coverage verifies exact login text and unrestricted Google sign-in using disposable fixtures. Secret scan passed. These checks do not establish successful live OAuth or correct public domain mapping.

The owner must provide authenticated access to the Vercel project currently holding the bare domain, or release/transfer that alias to the intended project. Then assign it to the verified deployment, confirm the project domain configuration retains it on future deployments, and fetch the public root and `/sign-in` again. Do not remove any domain from an unidentified application or change existing production applications without authorization. An unrelated domain or READY build is not completion of the requested task.
