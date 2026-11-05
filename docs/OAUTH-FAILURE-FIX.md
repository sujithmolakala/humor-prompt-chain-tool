# Studio OAuth failure routing

## Diagnosis

The admin fix at `26ef54b17b9c03b5d50ad408c022294a7ac77fa3` removed
`next` from redirectTo, disabled appended PKCE flow IDs, and stored flow/return
context in an HttpOnly cookie so the complete callback URL matches the Supabase
allowlist. Studio already has that exact initiation/callback approach.

The earlier hosted cancellation investigation in BRANDING-AUTH-REVIEW.md and
PRODUCTION-DEPLOYMENT-INCIDENT.md recorded Supabase falling back to the public
Site URL for Studio's unaccepted callback, while the admin/public controls
returned correctly. That redirect happens before Studio code executes. Current
hosted settings cannot be rechecked here: shell curl fails DNS resolution, no
Vercel connector or CLI is available, and the session does not permit approval.
The canonical -ashy callback's current allowlist membership is unverified.

## Required owner configuration

In the existing shared Supabase project, open Authentication → URL Configuration
→ Redirect URLs. Add these exact entries if absent, preserving all existing
entries and the shared Site URL:

- https://humor-prompt-chain-tool-ashy.vercel.app/auth/callback
- http://localhost:3002/auth/callback

Do not append `next`, wildcards, or flow IDs. Google still returns to the shared
Supabase `/auth/v1/callback`; its provider configuration does not need to change.
Official reference: https://supabase.com/docs/guides/auth/redirect-urls

In existing Vercel project prj_qgsxvs4naoYaHlKltI9aosFLbPkN, Production APP_ORIGIN
must be https://humor-prompt-chain-tool-ashy.vercel.app. Local APP_ORIGIN is
http://localhost:3002. This task does not change hosted settings.

## Local changes

Callback and initiation failures return to Studio sign-in with a fixed error
category. Cancellation, provider failure, expired/invalid code, missing exchange
session and service failure have retry messages. Provider descriptions are never
rendered. Supabase fragment errors are handled in the hydrated login component
and replaced with a same-origin sign-in URL, clearing the fragment. A callback
received on another host never exchanges a code or writes session cookies there.

Successful exchange still commits host-only session cookies before navigation.
Protected pages independently verify getUser and admin_identity with matching
UUID and literal is_superadmin true. Non-superadmins remain access-denied;
missing sessions return to sign-in. External next values remain sanitized.
No existing admin/public code, hosted database, roles or Auth settings changed.

## Verification limits

The automated suite covers exact production/local callbacks, strict allowlist
matching, cookie exchange, role denial, missing/expired sessions, provider errors,
cancellation, wrong callback hosts, external next rejection and safe fragment
messages. Its allowlist simulation does not prove hosted configuration and cannot
prevent Supabase redirecting to Site URL when the hosted allowlist rejects a URL.
Real production Google cancellation/failure must be tested after owner setup.

Current results: ESLint, TypeScript, all 28 automated tests, production build,
secret scan and diff whitespace checks pass. Browser tests cannot start because
the sandbox denies listening on a port (EPERM). Both mandatory live curl checks
fail DNS resolution. Git add/commit fail creating .git/index.lock (operation not
permitted); push fails DNS resolution for github.com. No deployment was made.
Current baseline HEAD is 96a2146db92300e138e1186a8af91ca35151533f; the OAuth
changes remain uncommitted. Production behavior has not been verified fixed.
