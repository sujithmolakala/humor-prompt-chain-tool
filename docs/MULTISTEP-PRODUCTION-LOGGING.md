# Multi-step orchestration and Production log visibility

## Findings and confidence

Single-step success and saved intermediate outputs establish that portions of the
workflow can work. They do not identify the cause of the remaining intermittent
interruptions. No specific production Gemini exception, HTTP status, SQLSTATE or
Vercel termination event has been obtained, so the actual incident cause remains
unverified. There is no new evidence-based reason to change models, raise budgets,
retry Gemini, expire a dispatch claim, or discard saved outputs.

Concrete source findings:

- HEAD 0f84a08fc3ce9095bd1327d406f810cf5315a1e7 has no console logging in the
  execution route/provider/chain executor. Its emit() writes browser NDJSON, not
  server stdout. That build generates no custom execution console messages.
- Previous logging/orchestration changes remain pending in this working tree.
  This task has not deployed them. Production artifact/source identity remains
  unverified; neither Git HEAD nor a dirty checkout proves deployed content.
- next.config.ts does not remove console output. There is no production logging
  toggle, sampling switch or browser-only logging implementation in the pending
  server logger. Logs are unconditional on the server.
- HEAD's client marks every streamed error uncertain, even when the server records
  a known failed result. The display is not proof of the raw database status.
- The Step 1→2 handoff is sequential and supplies a validated JSON object through
  {{previous}} and the structured context footer. Actual mocked request-body tests
  cover escaping, not just visible UI text. They cannot establish the hosted
  snapshot's exact instructions or provider response.
- A durable start marker precedes fetch. A local dispatch attempt does not prove
  Google receipt. HTTP/model response observations are tracked separately.
- Current reviewed SQL claims do not expire. last_dispatch_at's time window is
  rate/concurrency coordination, not permission to replay an uncertain request.
- Final checkpoint recovery, frozen snapshots, completed-prefix reuse and refusal
  to replay an unconfirmed started step are preserved. No execution semantics,
  provider retry or timeout policy was changed in this logging pass.

## Structured logging added/completed

The common logger writes one JSON record per event directly to server console
channels, tagged service=humor-study-studio and diagnosticsVersion=2026-11-11.1.
Normal progress uses info; checkpoint acknowledgement warnings use warn;
execution/terminal failures use error so an Errors filter can find them.

Events include:

- request_received, authorization/reservation timing;
- execution_start (run/invocation IDs, step count, cached output count);
- execution_claim_started/acknowledged and execution_step_start;
- provider dispatch, response headers, body receipt and parsed response;
- execution_output_validated, checkpoint attempt/acknowledgement;
- execution_step_transition_ready, after the previous checkpoint acknowledgement;
- execution_completed, including recovered completion and final caption count;
- execution_stopped with categorized stage/error codes, checkpoint read-back,
  request/stream disconnection, and invocation settlement.

Records contain total/step elapsed times, remaining budget, step number, confirmed
output count and safe deployment metadata. Transition metadata includes only
allowlisted output field names, not their contents. No key, private prompt, image,
raw output, arbitrary error message or stack is serialized. Logger failure cannot
change dispatch or execution outcomes. Heartbeats do not produce console spam.

## Non-billable log visibility check

New authenticated GET /api/execute is a logging probe; POST remains generation.
GET calls only the existing live-superadmin authorization and the console logger.
It never reads a Gemini key, uploads an image, reserves a run, writes execution
state, or dispatches a model request. It is force-dynamic, private and no-store.
Unauthorized callers are denied without exposing deployment metadata.

After an explicitly authorized deployment of these changes (NOT performed here):

1. Sign into Studio as a superadmin and open the following URL in the browser
   address bar (a GET, not a POST):
   https://humor-prompt-chain-tool-ashy.vercel.app/api/execute
2. A successful response reports operation=logging_probe, billableDispatch=false,
   diagnosticsVersion=2026-11-11.1, invocationId and safe build/environment data.
   X-HSS-Diagnostic-Id repeats the correlation ID in response headers.
3. HTTP 405 or a different version indicates this route/version is not serving
   that request. A login redirect/401/403 indicates authentication needs resolving.
   Do not start a paid execution to test logging.
4. In Vercel select sujith-molakala/humor-prompt-chain-tool (project ID
   prj_qgsxvs4naoYaHlKltI9aosFLbPkN) → Logs. Use Runtime Logs, not Build Logs.
   Select the environment returned by the probe; the canonical domain alone is
   not evidence of the deployment target. Use a fresh UTC/live time window.
5. Clear branch/status/Errors-only/browser-only filters. Include Info for the
   successful probe. Search its invocationId or humor-study-studio and inspect
   GET /api/execute plus logging_probe_confirmed.
6. Streamed executions can return HTTP 200 even when a later NDJSON event reports
   interruption. An HTTP-500-only filter therefore hides those requests. Their
   categorized console.error events are separate from HTTP response status.

Retention and filters depend on the Vercel plan/settings; old events may no longer
be available. This task cannot verify the current account's filters, alias target,
retention or actual runtime messages. The Vercel plugin is installed but exposes
no authenticated logging tool here, the CLI is unavailable, IDE database access
was denied by the session policy, and shell HTTP DNS resolution is restricted.
Related task records supplied only older deployment/branding evidence, not the
current interrupted invocation's logs.

References:
https://vercel.com/docs/logs/runtime
https://vercel.com/docs/cli/logs

## Validation

ESLint, TypeScript, all 48 automated tests and production build pass. New tests
verify the non-billable authenticated probe, versioned logs under Production
settings, checkpoint-before-transition ordering, four-step completion logs,
error-level interruption diagnostics, privacy, and logger failure isolation.
Existing tests cover every-step transport/write interruptions, response parsing,
connection drops, slow requests, resume guards and final persistence.

The compiled server artifact is inspected for the logging version/probe/events;
this demonstrates inclusion in the local production build, not live visibility.
A live Production log claim requires deployment and observing the probe event.
No billable calls, hosted data changes, commits, pushes or deployments occurred.
No Vercel configuration change is currently justified beyond verifying the actual
project/environment/source and existing Node.js maxDuration=120 metadata. The
previously pending SQL recovery migration still requires separate hosted review
before deploying the entire pending execution change set. The GET logging probe
itself does not depend on that migration.
