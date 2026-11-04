# Humor Study Studio branding and authentication review

Reviewed November 3, 2026. Repository and Vercel project remain `humor-prompt-chain-tool`.

## Shared authorization verified locally

The local Supabase URL and publishable key match `ai-rating-admin`. The shared project host is `qxpplzvkgugxklevbwqx.supabase.co` (public configuration, not a credential). No credential values are included here.

`lib/auth-core.ts` is identical to the admin implementation: verified `auth.getUser()`, then `admin_identity()`, with a matching user UUID and literal boolean `is_superadmin === true`. The SQL function calls `admin_assert()`, which checks the existing `profiles` row and auth user under a share lock. Email/domain, separate membership, and separate administrator flags are not authorization inputs. Every protected page uses the checked layout/page helpers, and every protected API independently calls `requireSuperadmin()`. All mutations also keep same-origin checks and checked database RPCs. Existing RLS, roles and user records were not changed.

Google OAuth uses the existing shared Supabase provider, PKCE and an app-specific host-only cookie namespace. No Workspace domain, `hd`, organization or email hint is supplied. A personal Gmail superadmin and a Columbia superadmin have the same authorization behavior; a non-superadmin is denied for either domain. Unit and real disposable-SQL tests cover both cases. Existing callback/session/expired-session tests remain in place.

## Branding and login

Login has only the heading “Humor Study Studio”, subtitle “Authorized superadmins only”, and “Sign in with Google” button. No uppercase eyebrow, account-domain instruction, workflow badges, theme picker, or additional default authorization text. Its existing deployed serif typography, warm surface, rounded card and teal pill button are preserved. Auth failures still have the existing dedicated error route.

Navigation, workspace header, browser titles, metadata and README use Humor Study Studio. Repository, package and Vercel project names remain unchanged.

## Deployment discrepancy found before changes

The live `https://humor-prompt-chain-tool.vercel.app/login` served the old flavor branding, a Columbia-only instruction, and an unrelated administrator-membership message. Its root title was also different from this GitHub checkout, and `/sign-in` returned 404. The local implementation already contained the correct shared role-based Supabase authentication. This establishes a source/deployment discrepancy; it does not prove which Vercel source, alias or environment setting caused it.

GitHub's deployment status points to the existing `sujith-molakala/humor-prompt-chain-tool` project. Vercel CLI was logged out during inspection. Production source, canonical domain and environment must be verified through the authenticated project before claiming the mismatch is resolved. No hosted Auth setting or migration was changed.

## Hosted OAuth verification

The shared Supabase public Auth settings endpoint reports Google enabled. A controlled Google authorization start followed by cancellation before account login returned to the exact existing admin callback and exact existing public callback in control tests. The same test with the studio callback instead returned to the public application's Site URL. This verifies the new studio callback is currently unsupported by the shared redirect configuration; it is not evidence of a user's role problem. No account was signed in or created, no role was changed, and no configuration was modified. OAuth state and cookie values were not logged.

## Production callback

Expected canonical callback for the currently observed production domain:

`https://humor-prompt-chain-tool.vercel.app/auth/callback`

Local callback: `http://localhost:3002/auth/callback`.

The project owner must approve and add the exact production callback in the shared Supabase Dashboard → Authentication → URL Configuration → Redirect URLs, retaining every existing application URL and the existing Site URL. This is a protected hosted configuration change and is not performed automatically. Google itself continues to redirect to the existing shared Supabase `/auth/v1/callback`; no domain restriction should be added. An end-to-end Google login still requires the real user's account interaction; mocked tests alone do not establish live sign-in success.

## Validation for this change

ESLint, strict TypeScript, 24 automated tests, seven browser scenarios and production build passed. Browser coverage includes exact login text/title, mobile layout, legacy `/login` redirect, Google provider and callback without domain hints, all protected API families, direct protected-page navigation and existing workflow functionality. Screenshots were captured using disposable fixture data. A secret scan runs again before commit. Deployment verification is tracked separately; local checks do not establish live account login.

## Deployment verification after push

GitHub Vercel status confirmed successful deployment of source commit `83256f6ac1b46a52b230e1089798e7a5c8109a2f`: https://vercel.com/sujith-molakala/humor-prompt-chain-tool/AiJGbcMoHe7YhpGXKjX8s9xsvAWr . This is a deployment inspection record, not a verified website URL. The bare domain still serves the other source. The team alias `https://humor-prompt-chain-tool-sujith-molakala.vercel.app` and main-branch alias `https://humor-prompt-chain-tool-git-main-sujith-molakala.vercel.app` respond with redirects to Vercel SSO, preventing unauthenticated page verification. No protection was bypassed or changed. Authenticated Vercel access or confirmation of the actual production URL is required to inspect the production source/environment and test the updated login page. The expected callback must match that confirmed canonical origin; do not add a different domain's callback blindly.
