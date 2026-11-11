# Step 1 uncertain outcome investigation

Historical review: current timeout and lifecycle behavior is documented in
[EXECUTION-LIFECYCLE-REVIEW.md](EXECUTION-LIFECYCLE-REVIEW.md).

## What the available evidence establishes

The reported Campus Humor run has Step 1 started, no accepted saved output, and
no later steps started. The existing journal stores no failure classification:
pct_progress writes the same generic error for failed and uncertain runs. The
execution route previously logged no stage or provider timings. No matching
production invocation log was found in local artifacts. No Vercel log connector
or installed CLI is available; shell HTTP fails DNS, and the IDE database
connection metadata tool is denied by the session approval policy. No hosted
rows were modified or billable Gemini requests made.

Consequently, the precise trigger for that historical run cannot be recovered
from the supplied status/duration alone. In particular, provider failure and
Vercel termination are not established. A run ID and redacted invocation log
are needed to attribute that run.

## Request, streaming and deadlines

- The provider uses one POST to the selected model's :generateContent endpoint,
  with an inline WebP image, configured temperature/maxOutputTokens and JSON
  response MIME type. It is not Gemini SSE/streamGenerateContent.
- Studio streams its own newline-delimited JSON progress events. It sends
  completed only after output validation and the journal acknowledgement.
- Provider timeout is 20 seconds; chain deadline is 95 seconds; Node route
  maxDuration is 120 seconds. No nine-second generation deadline exists locally.
- Supabase authentication/identity has a separate eight-second bound, not a
  Gemini body timeout. Actual deployed function configuration is unverified.
- A disconnected browser does not automatically abort or redispatch generation.
  A truncated progress stream is still treated as unconfirmed.

## Confirmed bugs and fixes

1. Contract validation throws ordinary Error values. The old catch classified
   every non-AppError as uncertain, including a complete successful provider
   response rejected for unexpected JSON fields or invalid intermediate strings.
   A regression reproduces Step 1 with no saved output and no later dispatch.
   The runner now classifies this as a known application output-contract failure,
   and exposes a useful message without relaxing validation.
2. Conversely, journal failures represented as AppError were treated as failed,
   including after a provider response/output-write acknowledgement was lost.
   Journal output/finalization ambiguity now remains uncertain. Failed terminal
   acknowledgement never claims a confirmed final state and is not retried.
3. The browser treated every terminal server error as uncertain. It now honors
   the runner's explicit outcome, while missing/unknown terminal events remain
   uncertain. History labels a known stopped step accordingly.
4. Complete malformed JSON envelopes are distinguished from body-read/transport
   interruption. Explicit provider response errors carry a fixed reason and HTTP
   status; transport/timeouts remain uncertain. No automatic provider retry exists.

New sanitized runtime events record run ID, stage, step, elapsed milliseconds,
confirmed response receipt/output save, and allowlisted provider reason/status.
They never serialize prompts, images, credentials, response bodies or arbitrary
error messages. These events distinguish provider receipt, validation failure,
and journal acknowledgement loss in future invocation logs. No schema change
or hosted journal backfill is performed.

## Reliability verification

Tests cover four-step sequential success, known output rejection, provider HTTP
rejection, malformed complete bodies, interrupted body reads, transport errors,
timeouts, deadline before dispatch, output acknowledgement loss, and terminal
journal failure. Real local PGlite journal tests confirm failed versus uncertain
states, preservation of acknowledged output, no later step dispatch, and
pct_start(dispatch=false) on reuse of either failed/uncertain request token.
The existing reservation/upload/hash checks are unchanged.

ESLint, TypeScript, all 35 automated tests and the production build passed. The
subsequent fixed provider-reason metadata addition is rechecked by lint,
TypeScript and the same automated suite. No production smoke test is claimed.

## Production action

No configuration change is justified by the current evidence. Before attributing
this incident to Vercel, inspect the affected invocation's deployed source and
effective maxDuration; the intended route value remains 120 seconds. Do not
increase deadlines, change models, or replay an uncertain request merely based
on a roughly nine-second duration. New logs become available only after an
explicitly authorized deployment. Historical generic journal errors cannot be
made more specific without the original logs.

References:
- https://vercel.com/docs/functions/configuring-functions/duration
- Local Next.js route-handler guide in node_modules/next/dist/docs/
