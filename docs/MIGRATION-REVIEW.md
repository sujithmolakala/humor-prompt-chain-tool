# New tool database review

These files are review artifacts, not authorization to apply hosted SQL.

1. `202611030001_chain_tool.sql` depends on the existing checked admin and runtime RPCs. It creates two new RLS-enabled private journal/reference tables with no direct API grants; reserves selected-chain snapshots under the shared configuration lock; rate-limits per verified superadmin; binds request ID to actor/chain/image hash; records sequential outputs; filters history by chain UUID in SQL; and adds a new private Supabase Storage bucket.
2. Storage policies touch only the new bucket. Restrictive fences protect against existing broad permissive policies. Only a superadmin's own UUID folder may be inserted; superadmins may view private inputs; clients cannot update or delete these immutable inputs. Existing caption/avatars buckets, objects and policies are not replaced or made public.
3. `202611030002_chain_duplication.sql` uses the same configuration revision lock and `admin_assert()`. It copies chain metadata and supported step settings with new UUIDs. New chain mix rows remain disabled. Four-step limits are enforced for step duplication.
4. Execution references use `ON DELETE RESTRICT` for actor, chain, step and model, preserving historical attribution. Snapshots are writable only through narrow definer functions, with no arbitrary SQL interfaces and empty search paths. Existing history is never reassigned or migrated.
5. No existing profiles, prompts, mix allocations, outputs, Auth settings, service keys or environment records are changed by the new migrations. The existing runtime prerequisite may introduce its documented schema/locks; review that separately if absent. Do not replay historical migrations on an upgraded hosted schema.
6. These new migrations are once-only additive installs. Unexpected existing object names fail and roll back rather than silently adopting a different definition. PGlite and native PostgreSQL installation pass against the local schema fixtures; hosted drift is still unverified.

Approval scope, if later requested: inspect hosted metadata read-only, review prerequisite presence, then approve only the exact missing files. Keep hosted Supabase Auth redirect changes as a separate approval. Never run a blanket migration push. No hosted operation has been performed by this task.

## Final Storage compatibility review — 2026-11-05

Scope: only the two pending `20261103000{1,2}` migrations; no hosted SQL,
Storage requests, migrations, Auth settings, or user roles were changed.

### Compatibility defect fixed

`202611030001_chain_tool.sql` originally placed direct `profiles` subqueries
inside restrictive policies `TO public`. A local before/after test reproduced an
anonymous avatar SELECT that succeeded before installation and failed afterward
with SQLSTATE 42501. PostgreSQL checks referenced-table privileges while planning
the policy expression even when the other bucket branch would be true. Granting
anonymous profile access would weaken existing security.

The migration now creates `pct_is_superadmin()`, a stable, SECURITY DEFINER,
empty-search-path helper returning only whether the current `auth.uid()` has an
existing superadmin profile. It takes no user-controlled identity argument.
Execution is limited to anon/authenticated (and the owner); all four new policies
that checked profiles now call it. Anonymous callers receive false, not profile
rows. No existing profile/table grants or Storage policies are changed.

`202611030002_chain_duplication.sql` required no SQL changes.

### Executed checks

`tests/storage-compatibility.test.ts` installs all historical local fixtures and
runtime prerequisites, then installs both pending files unchanged from disk.
The SQL runs on PostgreSQL 18.6 through PGlite 0.5.15, not a SQL mock.

- 66 Storage cases compare exact before/after results for avatars and captions:
  anonymous, ordinary-user and superadmin reads, uploads, updates and deletes;
  owned and foreign folders; unreferenced, active and archived caption images.
- Existing policy names, roles, commands and expressions remain identical.
- The private bucket is created with `public=false`. Anonymous and ordinary
  clients cannot read/upload Studio inputs, even with a deliberately broad
  permissive policy. A superadmin can read and upload with matching UUID folder
  and owner_id. Spoofed ownership and moving an avatar into the new bucket fail.
  No client can update/delete inputs. Revoking a superadmin flag immediately
  removes access in the next query.
- Duplication preserves description, positions, templates, explicit/null model
  settings and execution roles, while giving chains and steps fresh UUIDs.
  Copied chains have disabled, zero-allocation mix entries. Stale revisions,
  non-superadmins and a fifth step are rejected without partial changes.
  Revisions increase through existing catalog triggers as well as the RPC.
- The existing database suite also passes start/progress/history, image ownership,
  direct-table/RPC authorization and immutable execution-reference checks.

ESLint, TypeScript and all 30 automated tests pass. `git diff --check` passes.
Native PostgreSQL verification was attempted but initdb cannot allocate shared
memory under this sandbox (shmget: Operation not permitted), including an attempt
with explicit shared-memory options. No native-server pass is claimed.

### Readiness and remaining risks

Both files install cleanly locally and are ready for sequential, once-only SQL
Editor execution as postgres *subject to hosted schema/policy drift review*.
Run only `202611030001_chain_tool.sql` then `202611030002_chain_duplication.sql`;
do not replay prerequisites or use a blanket migration push. Each file has its
own transaction; if file 2 fails, file 1 remains installed. Object-name conflicts
fail rather than overwrite existing definitions. Review any error before retry.

The supplied hosted inspection confirms the runtime objects exist and the tool
objects/bucket are missing, but does not include exact policy definitions. Local
fixtures contain 12 Storage policies (including a legacy broad policy), whereas
the supplied hosted inventory reports nine. Tests exercise the named
`study_image_*_fence` and `caption_history_storage_*_fence` definitions from the
repository; they do not prove the nine hosted definitions or custom grants are
identical. A hosted restrictive policy scoped incorrectly to all buckets could
still block Studio uploads/reads; inspect those definitions before execution.

The tests exercise SQL RLS, not the hosted Storage HTTP service, upload MIME/size
enforcement, signed URLs, or hosted latency. Database owners and BYPASSRLS/service
roles retain their privileged access; client-only restrictions cannot constrain
them. Inputs are intentionally immutable to clients, so orphaned uploads and
retention/cleanup require a separately reviewed operational process. Execution
foreign keys deliberately prevent deleting referenced users/chains/steps/models.
