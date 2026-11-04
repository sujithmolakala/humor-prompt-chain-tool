# New tool database review

These files are review artifacts, not authorization to apply hosted SQL.

1. `202611030001_chain_tool.sql` depends on the existing checked admin and runtime RPCs. It creates two new RLS-enabled private journal/reference tables with no direct API grants; reserves selected-chain snapshots under the shared configuration lock; rate-limits per verified superadmin; binds request ID to actor/chain/image hash; records sequential outputs; filters history by chain UUID in SQL; and adds a new private Supabase Storage bucket.
2. Storage policies touch only the new bucket. Restrictive fences protect against existing broad permissive policies. Only a superadmin's own UUID folder may be inserted; superadmins may view private inputs; clients cannot update or delete these immutable inputs. Existing caption/avatars buckets, objects and policies are not replaced or made public.
3. `202611030002_chain_duplication.sql` uses the same configuration revision lock and `admin_assert()`. It copies chain metadata and supported step settings with new UUIDs. New chain mix rows remain disabled. Four-step limits are enforced for step duplication.
4. Execution references use `ON DELETE RESTRICT` for actor, chain, step and model, preserving historical attribution. Snapshots are writable only through narrow definer functions, with no arbitrary SQL interfaces and empty search paths. Existing history is never reassigned or migrated.
5. No existing profiles, prompts, mix allocations, outputs, Auth settings, service keys or environment records are changed by the new migrations. The existing runtime prerequisite may introduce its documented schema/locks; review that separately if absent. Do not replay historical migrations on an upgraded hosted schema.
6. These new migrations are once-only additive installs. Unexpected existing object names fail and roll back rather than silently adopting a different definition. PGlite and native PostgreSQL installation pass against the local schema fixtures; hosted drift is still unverified.

Approval scope, if later requested: inspect hosted metadata read-only, review prerequisite presence, then approve only the exact missing files. Keep hosted Supabase Auth redirect changes as a separate approval. Never run a blanket migration push. No hosted operation has been performed by this task.
