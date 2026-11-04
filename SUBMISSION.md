# Assignment 8 submission

Deadline: November 5, 2026, 4:30 PM EST.

| Application | Commit-specific Vercel deployment | Evidence |
| --- | --- | --- |
| Public Humor Study (`hello-world-nextjs`) | https://hello-world-nextjs-exp91k077-sujith-molakala.vercel.app | GitHub Production deployment `7102912049`, success, source commit `917a2ffcd0bd159d3d0d1431b5d9dfa29221ad5f` |
| Admin (`ai-rating-admin`) | **PENDING — retrieve from authenticated Vercel dashboard** | Commit `c44f7035743241ba77a19cb339143bb6f8834787`; GitHub Vercel success status links to https://vercel.com/sujith-molakala/ai-rating-admin/DewEfZaWcRbJZd7sHVvdUMwb33zH ; this is a dashboard link, not a submission deployment URL |
| Humor Study Studio (`humor-prompt-chain-tool`) | **PENDING — Vercel login and new deployment required** | `npx vercel whoami` reports logged out; no deployment claimed |

The public URL is verified through GitHub's successful deployment status, not a new live OAuth test. Existing apps were not modified or redeployed.

After Vercel login, inspect the admin deployment linked above and copy its unique `*.vercel.app` URL and source commit. For the new project, deploy the committed GitHub repository, inspect its deployment SHA and copy the unique deployment URL. Preserve the generic production alias separately for OAuth canonical origin. Record Incognito login-page reachability and actual superadmin/non-superadmin checks after approved Supabase redirect configuration.

Repository and new local validation evidence are documented in README and docs/VALIDATION.md. This document intentionally leaves unavailable URLs visibly pending.

Independent source repository: https://github.com/sujithmolakala/humor-prompt-chain-tool — created and pushed; GitHub owner and main branch verified.
