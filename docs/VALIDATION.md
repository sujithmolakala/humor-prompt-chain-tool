# Validation record — November 3, 2026

## Completed locally

- ESLint: passes without warnings.
- Configured server-secret values are absent from staged source and browser assets; generated and local environment files are ignored.
- TypeScript strict checking: passes (`next typegen && tsc --noEmit`).
- Unit and SQL integration tests: 20 tests. Cover actual auth/session handlers, superadmin checks, legacy execution compatibility, five-caption propagation, missing credentials, invalid image input, provider failures, CRUD, transactional ordering, stale revisions, duplication, immutable chain history, idempotency and private media policies. Provider transport is mocked explicitly.
- Native PostgreSQL: passes with a disposable Unix-socket-only cluster, two independent `psql` connections, competing reorder revision rejection and persisted unique IDs/positions. Initial initdb locale issue was corrected using explicit C/UTF8 locale. No hosted database URL is read.
- Production Webpack build: passes, including server route generation and strict compile. No database or provider calls occur at build time.
- Playwright: six scenarios pass in local Chrome against the actual Next app and disposable SQL-backed HTTP adapter. Covers unauthenticated/nonadmin APIs and pages, superadmin CRUD/duplication/reorder across reload and separate sessions, keyboard reordering, explicitly mocked sequential Gemini streaming and image retention, five captions, saved history, provider error persistence, CSRF, invalid uploads, all theme modes/persistence and desktop/mobile overflow. Final pass includes actual drag-and-drop ordering.
- Screenshots in `docs/previews` use only disposable fictional fixture data. Desktop light/dark and mobile views were captured; desktop/mobile screenshots inspected visually.
- Production dependency audit: zero vulnerabilities (`npm audit --omit=dev`). Full audit includes 16 moderate findings in inherited development lint dependencies through minimatch; npm's proposed automatic fix downgrades incompatible major dependencies, so it was not applied.

The initial browser attempt on numeric loopback timed out. Using localhost resolved connectivity. An editor pre-hydration form issue was found and fixed with disabled/inert controls until hydration. Test selector ambiguity with Next's route announcer was corrected. A fixture assertion for expired-session navigation was updated from the reference admin's media path to this tool's chains path. A concurrent development/build run emitted an internal Next dev-router warning; final verification runs those operations sequentially.

## Hosted / external checks pending

- Vercel login, new project creation, GitHub integration, secure production environment configuration, deployment and new commit-specific URL.
- Approved hosted schema preflight and missing migration installation. No hosted migration/data/Auth changes performed.
- Exact new-domain callback allowlist entry (requires owner approval); real Google login, nonadmin denial, session renewal and logout on that domain.
- Actual Gemini image/JSON model probe and live billable execution. Mocked provider tests are not live model validation.
- Hosted storage policy verification and full execution trace under the intended hosting duration.
- New-project Vercel Deployment Protection setting and Incognito reachability. Application authentication must remain enabled.
- Admin commit-specific deployment URL retrieval from authenticated Vercel. Public URL is backed by GitHub successful deployment evidence, not a new live OAuth verification.

Use README commands to repeat every check. Test scripts are isolated and do not provide a production authentication bypass.

## Repository publication

Created and pushed the independent public repository https://github.com/sujithmolakala/humor-prompt-chain-tool under the authenticated `sujithmolakala` account. Main branch verified through GitHub. GitHub Actions quality/browser workflows are included; remote CI status must be checked independently from the completed local checks. No Vercel project or deployment has been created because CLI authentication remains unavailable.

## Humor Study Studio branding/authentication update

Updated login to the three requested elements; retained the deployed warm serif design. Application navigation, header and browser metadata use Humor Study Studio. Existing superadmin verification matches `ai-rating-admin` exactly and was retained. Added personal-Gmail and Columbia superadmin tests, non-superadmin/unsigned denials, real SQL role checks, exact login and title browser checks, and domain-free Google OAuth checks. Validation: ESLint, TypeScript, 24 automated tests, seven browser scenarios and production build pass. See [BRANDING-AUTH-REVIEW.md](BRANDING-AUTH-REVIEW.md) for controlled hosted OAuth results: the new callback currently falls back to the public Site URL, while the two existing application callbacks pass. No hosted Auth settings or database migrations were changed.
