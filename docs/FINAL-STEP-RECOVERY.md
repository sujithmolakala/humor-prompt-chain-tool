# Contextual Humor Step 4 investigation and recovery

Historical review: current timeout and lifecycle behavior is documented in
[EXECUTION-LIFECYCLE-REVIEW.md](EXECUTION-LIFECYCLE-REVIEW.md).

## Incident attribution

The supplied observation establishes three saved outputs and an uncertain run.
It does not identify whether Step 4 was dispatched, timed out, returned unusable
JSON, or failed while persisting its response. The previous live client labeled
*every* unfinished step “Not confirmed” after an error, including steps that had
never started. That label alone is not dispatch evidence. The database's
current_step, outputs, status, timestamps and invocation logs must be correlated.

The exact historical trigger remains unverified: no run ID/invocation logs were
provided, no authenticated Vercel logging tool is available, and the earlier IDE
metadata access attempt was denied by the session's never-approval policy. The
old journal's generic error text cannot recover the lost exception. No provider
failure or platform timeout is assumed. No hosted rows were inspected/modified
by the implementation tests, and no live Gemini requests were made.

## Confirmed code defects

1. Final output persistence and run completion were two separate database
   transactions. A committed response followed by lost acknowledgement or failed
   finalization could remain uncertain despite saved captions. This explains
   all-outputs-saved uncertainty; it alone does not establish why this reported
   run has only three saved outputs.
2. There was no guarded resume: pct_start returned dispatch=false for every
   existing token, and the runner always started at step zero.
3. A lost output acknowledgement could not be retried successfully as an
   idempotent checkpoint; finalization ambiguity could incorrectly hide success.
4. Generic persisted errors and the live “Not confirmed” label hid failure stage.

## Local changes

`202611050001_execution_recovery.sql` is a new, un-applied migration after the two
existing pct migrations. It retains table RLS, RPC superadmin checks, actor
ownership, immutable snapshots and request-token binding.

- pct_progress atomically appends the accepted final response and transitions to
  Completed. Identical output checkpoints and completion confirmations are
  idempotent; conflicting payloads fail. A start marker is an exclusive claim:
  a second claim cannot authorize another model request.
- pct_resume locks/authorizes the existing actor's run. It finalizes fully saved
  legacy runs without model dispatch, or reserves a stopped run only when its
  next step has never been claimed. Running runs and started/unconfirmed steps
  are refused, even if they might actually have failed at the provider.
- last_dispatch_at preserves original started_at while including resumed work in
  existing actor concurrency/rate checks. Existing rows are backfilled from their
  original start times; no outputs or snapshots are rewritten.
- pct_stop persists fixed step/reason diagnostics. pct_recovery_ready prevents the
  new application from reserving/dispatching until this migration is available.

The runner validates/replays saved outputs without invoking Gemini. It retries
only one identical database checkpoint, never a model call, and rereads the
journal to recover confirmed completion after acknowledgement loss. No accepted
output is discarded. Persistent storage failure remains uncertain; there is no
claim that an unsaved provider response can be reconstructed after process loss.

The resume endpoint checks origin, live superadmin authorization, actor ownership,
saved-prefix validity, and the original image hash before reserving work. It uses
the frozen execution snapshot, not later prompt/model edits. No model request is
made for a fully saved run. History and execution views expose explicit recovery
controls. Cached outputs and final captions are displayed from the journal.
The live status label distinguishes a known started step from never-started ones.

## Parsing, streaming and limits

Gemini remains a single non-streaming generateContent POST per dispatched step;
only Studio progress is NDJSON-streamed. The provider's complete/malformed JSON,
finish reason and output contract retain existing validation. Network/body-read
interruptions remain uncertain. There are no SDK/provider retries or weakened
output checks. Client stream interruption never proves provider failure and never
triggers automatic redispatch.

Budgets are unchanged: 20s/provider request, 95s/chain invocation, maxDuration=120
for both execution routes. A resumed safe prefix receives a new invocation budget.
The deployed source and effective Vercel limits still need authenticated review;
no timeout/model/environment setting change is justified by current evidence.

## Verification

Local PostgreSQL (PGlite) tests install all three pct migrations and exercise
one-, two-, three- and four-step snapshots. Tests reproduce lost final-save and
finalization acknowledgements, persistent final-write failure, Step 4 transport
interruption, actionable saved diagnostics, preserved first-three outputs,
exclusive resume reservation, refusal to repeat ambiguous Step 4, conflicting
checkpoints, unauthorized/cross-actor access, legacy completion recovery and a
resume that makes exactly one call using the original snapshot after later edits.
The existing suite also covers invalid JSON/output, deadline and stream/body loss.

ESLint, TypeScript, all 36 automated tests, the production build, whitespace
checks and tracked/untracked source plus browser-asset secret scans pass. Browser
tests were attempted but the fixture server cannot listen under the sandbox
(listen EPERM). Tests use only synthetic responses and disposable local PostgreSQL.

## Required production action (not performed)

Review and explicitly approve the new migration, then run it once as postgres
before deploying this application. It requires existing pct_runs, pct_start,
pct_progress and admin_assert. It takes a table lock while adding/backfilling one
column and changes the existing checkpoint function; review deployment timing.
Verify new RPC visibility in PostgREST; reload its schema cache if necessary.
Missing recovery RPCs fail closed before billable dispatch.

A Step 4 already marked started with no saved response cannot safely be resumed
from these records alone. Recovery will refuse to rebill it. If all four outputs
are saved, recovery can finalize with zero provider calls. If only Steps 1–3 are
saved and Step 4 was never claimed, recovery skips them and dispatches Step 4 once.
The current incident still requires its run ID and matching production logs for
an exact historical root-cause conclusion. No automatic deployment is authorized.
