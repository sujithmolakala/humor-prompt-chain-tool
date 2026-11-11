# Cross-step execution interruption review

## Evidence and attribution

Reported production facts: an older run saved Steps 1–3, a newer run saved Step 1,
the newer run ended at about 21.5 seconds, and both used gemini-3.1-flash-lite.
No invocation logs, run IDs, deployed source SHA, or effective Vercel function
settings have been supplied. No authenticated Vercel logging tool is available.
Exact attribution of those historical invocations therefore remains unverified.

The source has a concrete cross-step cancellation mechanism: generate always
combined a new AbortSignal.timeout(20000) with its caller's 95-second execution
deadline. The 20-second timer covered both time to headers and the entire JSON
response body. It ran anew for every step. A healthy response taking longer than
20 seconds was aborted by the application, leaving its billable outcome unknown.
A fast Step 1 followed by this Step 2 cutoff is consistent with a 21.5-second run;
it is not evidence that Gemini itself failed or that Vercel killed the function.

A fake-clock test reproduces the old cutoff with a valid 25-second response,
including an explicit standalone_provider_deadline diagnostic. This is a verified
code-path reproduction, not a measurement of production Gemini latency. The
original 20-second safeguard remains for standalone calls lacking a caller-owned
execution budget. Execution calls now honor their existing shared deadline,
without a second per-step wall clock. The total execution cap remains 95 seconds,
the Node.js route cap remains 120 seconds, and neither was increased.

## Lifecycle fixes and instrumentation

- Execution and resume requests share an invocation ID across authorization,
  upload parsing/image validation, reservation, provider, journal and settlement
  events. Validated deployment/source identifiers are included when Vercel
  supplies them. No environment dumps or user/auth identifiers are logged.
- Each provider call reports model, headers/body/parse stage, HTTP status,
  allowlisted finish/error category, elapsed time, request outcome and exact abort
  source. A headers-received event is not mistaken for a complete response.
- Every step records whether its exclusive database start claim was acknowledged,
  how many outputs are confirmed, remaining execution budget, checkpoint attempts
  and acknowledgements. Failure reconciliation logs the journal status,
  current_step, saved-output count, actor-match boolean and last_dispatch_at.
  Arbitrary exceptions, provider bodies, images, prompts and secrets are excluded.
- The execution budget accounts for elapsed preflight time and preserves a
  ten-second settlement margin inside the declared 120-second function limit.
  Authentication retains its separate existing eight-second budget; it is not a
  Gemini latency limit. Unbounded/unacknowledged journal I/O is distinguishable
  from provider work by the last recorded stage; a hard platform kill still
  cannot be handled or reconstructed with certainty by application code.
- The exact running worker promise is registered with next/server after *before*
  dispatch starts. A cancelled stream/request is logged and detached from output
  delivery; it neither aborts the bounded provider work nor starts a new worker.
  Five-second NDJSON heartbeats reduce idle progress-connection gaps. Existing
  clients ignore these nonterminal events.
- after is not a durable queue and does not survive a hard platform termination
  or extend maxDuration. Durable journal state remains authoritative after a
  process loss. No automatic model retry, reconnection dispatch, or replay was
  added. Logging failures cannot interrupt generation or checkpointing.

## Dispatch ownership and recovery

The previously reviewed recovery migration remains required. Its actor-scoped
row locks, run token, current_step start marker and frozen snapshot govern
ownership. The start marker is a nonexpiring dispatch claim, not a lease that can
be reclaimed simply because a timer elapsed. A started step without saved output
cannot be resumed. last_dispatch_at supplies rate/concurrency windows, not evidence
that a potentially billed call can be replayed. Invocation IDs are diagnostics,
not new authorization credentials or substitutes for the database claim.

Confirmed prefixes are reused without provider calls. Atomic final output and
Completed status, identical idempotent database checkpoint retry and read-back
reconciliation remain intact. Persistent write failures and body/transport loss
remain uncertain. A successful disconnected worker can complete in the journal;
its client recovers from saved state instead of replaying generation.

## Tests and checks

Automated cases cover:

- Reproduction of the old 20-second cutoff with simulated valid 25-second latency.
- A slow response at each of four step positions, complete streamed captions,
  and exactly one provider request per step.
- Slow chunked response bodies and interruption during body consumption, with
  explicit execution_deadline attribution.
- Whole-invocation budget expiry, preserving completed outputs and preventing
  later dispatch.
- Stream cancellation and request abort: the same lifecycle promise completes,
  checkpoints are retained, and no extra request is created.
- Real local PostgreSQL transport interruptions and database write failures at
  every step; preserved prefixes, blocked ambiguous replay, saved final-output
  recovery, cross-actor rejection and exclusive resume reservation.
- Log-content checks excluding fixture keys, prompts, response content and raw
  cancellation reasons.

ESLint, TypeScript, all 41 tests and production build pass. Local
.next/server/functions-config-manifest.json declares maxDuration=120 for both
/api/execute and /api/execute/[id]/resume. This confirms local build metadata,
not the production deployment's effective settings. All provider requests in
these tests are intercepted fixture responses; no live Gemini call is made.

## Required production verification

No new Vercel setting or timeout increase is justified. Verify that the existing
production project actually deploys this source, both routes use Node.js and
maxDuration=120, and the previously reviewed recovery migration is present. Do
not auto-apply it. If request cancellation is enabled, after tracks the bounded
work; there is no requirement to disable cancellation or change its setting.

For the affected run, correlate invocation/run IDs and the deployment SHA, then
look for provider stopped.abortSource, providerStage and providerElapsedMs;
execution_stopped.phase; the checkpoint read; and any platform
FUNCTION_INVOCATION_TIMEOUT or termination log. A missing settlement event plus a
platform termination is different from a caught application deadline. Existing
runs without those diagnostics cannot be retrospectively assigned an exact cause
from their generic uncertain status alone.

References:
- https://vercel.com/docs/functions/functions-api-reference (cancellation and after)
- https://vercel.com/docs/functions/configuring-functions/duration
- https://nextjs.org/docs/app/api-reference/functions/after
