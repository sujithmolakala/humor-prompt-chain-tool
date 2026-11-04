import Link from "next/link";
import { notFound } from "next/navigation";
import { requireAdminPage } from "@/lib/auth";
import { getHistory } from "@/lib/tool-data";
import { idSchema } from "@/lib/security";
import { Heading, Setup } from "@/components/Common";
export default async function RunDetail({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const access = await requireAdminPage();
  const id = idSchema.safeParse((await params).id);
  if (!id.success) notFound();
  let h;
  try {
    h = await getHistory(access, { run_token: id.data });
  } catch {
    return (
      <Setup message="Saved execution details are unavailable. Check database setup and retry." />
    );
  }
  const run = h.runs[0];
  if (!run) notFound();
  const stale =
    run.status === "running" && h.asOf - Date.parse(run.started_at) > 180000;
  return (
    <>
      <Heading
        eyebrow="EXECUTION DETAIL"
        title={run.snapshot.name}
        description={`${new Date(run.started_at).toLocaleString("en-US")} · ${run.id}`}
      >
        <Link className="button" href={`/history?chain=${run.chain_id}`}>
          Chain history
        </Link>
      </Heading>
      <div className="execution-grid">
        <section className="panel">
          <img
            className="detail-image"
            src={`/api/history/${run.id}/image`}
            alt="Original execution input"
          />
          <p className={`tag ${run.status}`}>
            {stale ? "Interrupted / outcome unconfirmed" : run.status}
          </p>
          <dl>
            <dt>Chain identifier</dt>
            <dd>{run.chain_id}</dd>
            <dt>Started</dt>
            <dd>{run.started_at}</dd>
            <dt>Finished</dt>
            <dd>{run.finished_at || "Not confirmed"}</dd>
          </dl>
          {(run.error || stale) && (
            <p className="notice error">
              {run.error ||
                "This run has not reported completion. Do not assume failure or retry automatically; model charges may have occurred."}
            </p>
          )}
          <Link href={`/chains/${run.chain_id}`}>Open current chain →</Link>
          <p className="muted">
            The saved snapshot below retains the original name, prompts, order,
            and models even after future edits.
          </p>
        </section>
        <section className="panel">
          <h2>Execution trace</h2>
          {run.snapshot.steps.map((s, i) => (
            <details open key={s.id} className="trace">
              <summary>
                Step {s.position} · {s.role.replaceAll("_", " ")} ·{" "}
                {run.outputs[i]
                  ? "Completed"
                  : run.current_step === i
                    ? "Started / unconfirmed"
                    : "Not started"}
              </summary>
              <p className="muted">
                {s.model} · temperature {s.temperature} · max tokens{" "}
                {s.max_tokens}
              </p>
              <blockquote>{s.template}</blockquote>
              {run.outputs[i] ? (
                <pre>{JSON.stringify(run.outputs[i], null, 2)}</pre>
              ) : (
                <p className="muted">No saved output.</p>
              )}
            </details>
          ))}
          {run.status === "completed" &&
            run.outputs.at(-1)?.captions?.map((c, i) => (
              <p className="caption" key={i}>
                <span>{i + 1}</span>
                {c}
              </p>
            ))}
        </section>
      </div>
    </>
  );
}
