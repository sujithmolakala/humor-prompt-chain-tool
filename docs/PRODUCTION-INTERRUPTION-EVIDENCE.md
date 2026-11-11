# Production interruption: evidence status

## Conclusion

The exact cause of the reported 4.5-second Campus Humor interruption is **not
established**. Neither provider receipt nor a production exception/HTTP status
has been observed in this session. No new execution-behavior fix was made.

The earlier twenty-second finding reproduced one local failure mechanism; it was
not proof of the cause of the production runs. The new 4.5-second report does not
support using that mechanism as a complete explanation. Reported 4.5/9/22-second
durations are not substitutes for per-stage timestamps from the same invocation.

## Evidence available and access limitations

- Local directory: /Users/sm/IdeaProjects/humor-prompt-chain-tool.
- Local HEAD: 0f84a08fc3ce9095bd1327d406f810cf5315a1e7.
- Earlier execution changes and the recovery migration remain uncommitted here.
  No deployment has been made by this investigation. A production deployment may
  have different source; a CLI deployment of a dirty checkout can also retain
  HEAD metadata. Deployment ID and actual build provenance must be checked.
- Vercel plugin discovery confirms it is installed/enabled, but no authenticated
  runtime-log tool is exposed in the available tools. The CLI is unavailable.
- A read-only IDE database-connection inspection attempt was rejected:
  "MCP tool call requires approval, but approval policy is never".
- A non-billable sign-in HEAD request failed with curl exit 6, "Could not resolve
  host: humor-prompt-chain-tool-ashy.vercel.app".
- Local temporary logs found are validation/test logs, not matching production
  invocation logs. No production Gemini error or PostgreSQL error was obtained.

## Trace and what it proves

1. chain-execution.ts validates Step 1's output and builds Step 2's prompt from
   that object. {{previous}} is JSON-serialized into the template; the footer also
   carries {previous: <object>, avoid: []}. A wire-body fixture test confirms
   quotes, backslashes and Unicode are encoded correctly, not double-encoded.
   This verifies local behavior, not the actual hosted snapshot/instructions.
2. pct_progress writes current_step BEFORE provider invocation. A started marker
   proves a durable claim, not that fetch executed, reached Google or was billed.
3. execution_provider_dispatch and requestAttempted describe a local attempt.
   An observed HTTP response is stronger evidence of endpoint communication; a
   parsed model response establishes response content was received. With no HTTP
   response or provider-side record, receipt remains unknown and replay is unsafe.
4. Response JSON, workflow output validation and output checkpointing are separate
   stages. A saved Step 1 proves its checkpoint succeeded, not that Step 2's
   provider/parse/checkpoint stage succeeded.
5. Current SQL has actor-scoped locks and nonexpiring dispatch claims. There is
   no timed lease expiration/reclamation branch. last_dispatch_at's three-minute
   window controls concurrency/rate limiting. It does not expire a started-step
   claim or authorize replay. The applied hosted function definitions are unknown.
6. Local stream cancellation is separate from the bounded worker promise tracked
   through after(). A hard platform kill can still prevent cleanup. Neither
   client cancellation nor Vercel timeout was observed for this production run.

Relevant locations:
- lib/chain-execution.ts: stepPrompt and executeChain.
- lib/provider.ts: fetch, response.json, output parsing, stopped diagnostics.
- lib/execution-runner.ts: claim, provider invocation, validation, checkpoints,
  read-back reconciliation and terminal status.
- lib/execution-stream.ts: after tracking, request/stream cancellation, heartbeats.
- supabase/migrations/202611050001_execution_recovery.sql: pct_progress/pct_resume.

## Diagnostic-only changes in this pass

- Provider diagnostics distinguish providerReceipt=unobserved,
  http_response_observed and model_response_observed, separately from
  requestAttempted. They do not infer remote receipt from a local fetch call.
- Fixed exception categories and allowlisted network/cause codes are retained,
  e.g. ECONNRESET, UND_ERR_SOCKET, UND_ERR_HEADERS_TIMEOUT, UND_ERR_BODY_TIMEOUT.
  These are diagnostic categories, NOT errors observed in the production run.
- The existing RPC error response/status behavior is unchanged. Its safe SQLSTATE
  is retained internally so 55000 claim rejection, 40001 conflicts, 42501 access
  failures and transport loss need not collapse into the same generic event.
- Checkpoint/read/terminal diagnostics include those safe codes. Claim events
  explicitly report claimExpiration=none rather than inventing an expiration.
- No arbitrary messages, stacks, API keys, URLs, image/prompt content or raw
  provider payloads are logged. Unknown codes are omitted, not echoed.
- No changes to timeouts, requests, retries, cancellation, persistence, ownership,
  resume eligibility, models, migrations or authorization were made in this pass.
  Previously pending work is left intact.

## Evidence needed to conclude the production incident

Provide the run UUID and UTC start/end, deployment ID and source/build provenance,
and Vercel logs for that invocation. Preserve platform termination events and the
following structured events if the deployed build contains them:

- execution_lifecycle and authorization/reservation timings;
- execution_claim_acknowledged (run/step/invocation IDs);
- execution_provider_transport: providerEvent, providerStage, providerElapsedMs,
  requestAttempted, providerReceipt, httpStatus, abortSource, errorCode/causeCode;
- execution_checkpoint_started/output_saved/checkpoint_read;
- execution_stopped, terminal-write diagnostics, client_disconnected,
  invocation_settled and FUNCTION_INVOCATION_TIMEOUT/termination events.

If receipt is still unobserved, provider-side request status/latency metadata is
needed to determine whether Google received the request. Usage aggregates alone
cannot necessarily identify a specific request. Do not submit another billable
request to create that evidence.

The following SELECTs are optional evidence collection for an authorized operator,
not executed here. Replace the all-zero UUID with the reported run UUID. They do
not return prompt/image/output contents and do not modify data:

```sql
select r.id, r.status, r.started_at, r.finished_at,
       extract(epoch from (r.finished_at-r.started_at)) as journal_elapsed_seconds,
       r.current_step as zero_based_started_step,
       jsonb_array_length(r.outputs) as saved_output_count,
       r.current_step >= jsonb_array_length(r.outputs) as claimed_without_output,
       to_jsonb(r)->>'last_dispatch_at' as last_dispatch_at,
       r.error,
       r.snapshot->'steps'->1->>'model' as step2_model,
       r.snapshot->'steps'->1->>'role' as step2_role,
       r.snapshot->'steps'->1->>'max_tokens' as step2_max_tokens,
       strpos(coalesce(r.snapshot->'steps'->1->>'template',''),'{{previous}}')>0
         as step2_has_previous_placeholder,
       jsonb_typeof(r.outputs->0) as step1_output_type,
       case when jsonb_typeof(r.outputs->0)='object' then
         (select jsonb_agg(k order by k) from jsonb_object_keys(r.outputs->0) as keys(k))
       end as step1_output_keys
from public.pct_runs r
where r.id='00000000-0000-0000-0000-000000000000'::uuid;

select p.oid::regprocedure as function_signature, p.prosecdef,
       pg_get_userbyid(p.proowner) as owner, md5(p.prosrc) as definition_fingerprint
from pg_proc p
where p.oid in (
  to_regprocedure('public.pct_start(uuid,uuid,text,text)'),
  to_regprocedure('public.pct_progress(uuid,integer,jsonb,text)'),
  to_regprocedure('public.pct_resume(uuid)'),
  to_regprocedure('public.pct_stop(uuid,integer,text,text)'),
  to_regprocedure('public.pct_recovery_ready()')
);
```

## Validation and configuration

ESLint, TypeScript, all 44 tests, production build and whitespace checks pass.
New tests verify actual mocked Step 2 request formatting, receipt-vs-attempt
semantics, safe network diagnostics, SQLSTATE retention and unchanged API errors.
There is no incident-specific regression test claiming the unknown production
fault has been reproduced. Existing interruption/recovery safeguards still pass.

No Vercel or Supabase change is justified by the new evidence. Verify actual
production source, effective function duration and installed RPC definitions
before deciding whether any configuration differs. Do not apply the pending
recovery migration or deploy the diagnostic code automatically. No hosted writes,
billable calls, commits, pushes or deployments were made.
