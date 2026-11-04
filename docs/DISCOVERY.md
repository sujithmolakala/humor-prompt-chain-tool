# Discovery and reuse

Inspected November 3, 2026. Actual workspace: `/Users/sm/IdeaProjects/humor-prompt-chain-tool` (empty at start). Parent: `/Users/sm/IdeaProjects`. Both `ai-rating-admin` and `hello-world-nextjs` are accessible siblings. The existing repositories were read only; no existing app was changed, reset, committed, pushed, or deployed.

## Actual schema from source migrations

- `profiles.is_superadmin`, verified through existing `admin_identity()` and `admin_assert()`.
- `prompt_chains`: UUID, name, description, timestamps.
- `prompt_chain_steps`: UUID, chain_id, position, prompt_template, nullable model_id; runtime migration adds execution_role.
- `prompt_chain_mix`: chain_id, enabled, allocation; shared public weighted selection. New chains are automatically inactive with zero allocation. This tool does not change the live public mix.
- `llm_models`: UUID, identifier, provider_id, temperature, max_tokens, enabled; `llm_providers` are reused, never recreated automatically.
- Existing generation: `caption_generation_requests`, `caption_generation_days`, `caption_drafts`; published `captions`, immutable `caption_versions`, images referenced by storage path. Existing history has no reliable retrospective chain attribution.
- Runtime upgrade: `hs_runtime_settings`, `hs_model_adapters`, `hs_generation_batches`, `hs_llm_calls`, `hs_batch_step_models`. Public generations have immutable chain/model snapshots and service-only planner/finish functions.
- Storage: existing private `caption-images`, public avatars. The new tool uses the same Supabase Storage infrastructure with a separate private `prompt-chain-inputs` bucket; existing objects/policies are not replaced.

## Working code reused

Existing admin Google PKCE start/callback/logout, error classification, bounded authentication transport, `getUser` plus superadmin identity checks, `proxy.ts`, same-origin mutation checks, bounded request bodies, Sharp image normalization, model capability probe, chain types, SQL atomic catalog mutations, model approval and revision locks, and structured sequential execution contract. The new execution contract defaults to the original three-caption behavior for regression tests and accepts five for this application. New UI, theme management, private execution journal, streaming route, duplication RPC and tool-specific tests were built separately.

Next.js 16.4.2 / React 19.3 and compatible existing dependencies retained. Read installed Next.js client-boundary and Route Handler documentation before implementation. Strict TypeScript is enabled.

## Hosted state and deployment

Source inspection establishes local schema expectations, not hosted schema drift. No hosted Supabase migrations, data changes, or authentication configuration changes were performed. Existing admin docs state that `202611010001_prompt_execution.sql` was pending. Use read-only preflight before proposing any hosted installation. Historical migrations are included to reproduce disposable tests, not as instructions to replay them in production. Signup-policy migration was excluded entirely.

GitHub CLI authenticated owner: `sujithmolakala`. New repository did not exist at discovery. Vercel CLI absent globally; `npx vercel` works but reports logged out. Existing repositories have no `.vercel/project.json`. Public commit-specific URL was obtained from GitHub deployment status. Admin GitHub commit status provides a Vercel deployment dashboard link, not its commit-specific application URL.
