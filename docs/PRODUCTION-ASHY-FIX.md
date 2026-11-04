# Canonical studio domain correction

The canonical production origin is `https://humor-prompt-chain-tool-ashy.vercel.app`.
The conflicting bare domain is not this project's canonical origin.

The prior incident report (`PRODUCTION-DEPLOYMENT-INCIDENT.md`) records the intended
project's correct source and aliases, but a deployed APP_ORIGIN pointing to the
bare domain. `proxy.ts` canonicalizes requests before rendering sign-in, so it
sent visitors away from the updated application to another application with old
branding. Successful builds alone could not fix that configuration.

This change validates APP_ORIGIN, rejects the conflicting domain in every
environment, requires the exact canonical domain for Vercel Production, and
returns a private, uncached 503 from the proxy on invalid configuration. Missing
production configuration cannot fall back to an incoming Host. Auth error links
use the same validation. The existing shared superadmin authorization and exact
login copy are preserved. OAuth tests now use the canonical callback.

Required hosted setting in existing project
`prj_qgsxvs4naoYaHlKltI9aosFLbPkN`, owner/project
`sujith-molakala/humor-prompt-chain-tool`:

- Production APP_ORIGIN: `https://humor-prompt-chain-tool-ashy.vercel.app`
- Check for duplicate Production entries and branch/Preview overrides before
  deployment. Preview configuration should remain separately scoped.
- Retain the existing production alias `humor-prompt-chain-tool-ashy.vercel.app`.
- Deploy the reviewed commit to this existing project, then verify the deployed
  SHA and alias using authenticated Vercel inspection.

Current validation: lint, TypeScript, 25 automated tests, production build and
compiled login text inspection pass. Compiled output includes all three exact
requested strings and none of the forbidden strings. Actual local HTTP and
Playwright are blocked by listen EPERM. Both mandatory production curl commands
fail with DNS resolution error (curl exit 6). The Vercel CLI is not installed;
no Vercel connector is available. The IDE terminal fallback is denied by the
session's never-approval policy. Hosted configuration, current source SHA and
aliases therefore cannot be independently rechecked or changed in this session.
No deployment was attempted; production success is unverified.

OAuth remains unverified. The prior incident documents a Supabase callback
allowlist blocker; the relevant canonical callback is now
`https://humor-prompt-chain-tool-ashy.vercel.app/auth/callback`. No hosted Auth
configuration, migrations, applications, users or roles were changed. Hosted
schema prerequisites remain unverified.
