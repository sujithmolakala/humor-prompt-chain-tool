import Link from "next/link";
import { requireAdminPage } from "@/lib/auth";
import { getHistory, getState, rpc } from "@/lib/tool-data";
import { Heading, Setup, Empty } from "@/components/Common";
import { idSchema } from "@/lib/security";
import { z } from "zod";
type Legacy = {
  batches: {
    user_id: string;
    request_id: string;
    chain_id: string;
    chain_name: string;
    status: string;
    started_at: string;
  }[];
};
export default async function History({
  searchParams,
}: {
  searchParams: Promise<{ chain?: string; page?: string }>;
}) {
  const access = await requireAdminPage();
  const q = await searchParams;
  const target = q.chain ? idSchema.safeParse(q.chain) : null;
  if (target && !target.success)
    return (
      <Empty title="Invalid chain filter">
        Use a chain link from the editor.
      </Empty>
    );
  const page = z.coerce
    .number()
    .int()
    .min(1)
    .max(100000)
    .catch(1)
    .parse(q.page || 1);
  let history;
  try {
    history = await getHistory(access, {
      target: target?.success ? target.data : null,
      page_number: page,
    });
  } catch {
    return (
      <Setup message="Execution history needs the new tool migration. Existing public generation records are preserved." />
    );
  }
  const [state, legacy] = await Promise.allSettled([
    getState(access),
    rpc<Legacy>(access, "hs_admin_telemetry"),
  ]);
  return (
    <>
      <Heading
        eyebrow="GENERATION HISTORY"
        title="Every run has a story."
        description="Saved inputs, immutable workflow snapshots, and the outputs along the way."
      />
      <form className="toolbar">
        <label>
          Filter by chain
          <select name="chain" defaultValue={q.chain || ""}>
            <option value="">All chains</option>
            {state.status === "fulfilled" &&
              state.value.chains.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
          </select>
        </label>
        <button>Apply filter</button>
        <Link href="/history">Reset</Link>
        <span className="muted">{history.total} saved executions</span>
      </form>
      <section className="panel">
        {history.runs.length ? (
          <div className="history-list">
            {history.runs.map((r) => (
              <Link
                href={`/history/${r.id}`}
                className="history-row"
                key={r.id}
              >
                <img
                  src={`/api/history/${r.id}/image`}
                  alt="Execution input"
                  loading="lazy"
                />
                <div>
                  <h3>{r.snapshot.name}</h3>
                  <p className="muted">
                    {new Date(r.started_at).toLocaleString("en-US")} ·{" "}
                    {r.snapshot.steps.length} steps
                  </p>
                  <p>
                    {r.outputs.at(-1)?.captions?.[0] ||
                      "Inspect intermediate outputs and execution status"}
                  </p>
                </div>
                <span className={`tag ${r.status}`}>{r.status}</span>
                <span aria-hidden="true">↗</span>
              </Link>
            ))}
          </div>
        ) : (
          <Empty title="No generations here yet">
            Run this chain with an image to see its results here.
          </Empty>
        )}
      </section>
      <div className="pagination">
        {page > 1 && (
          <Link
            className="button"
            href={`/history?page=${page - 1}${q.chain ? `&chain=${q.chain}` : ""}`}
          >
            Previous
          </Link>
        )}
        <span>Page {page}</span>
        {history.total > page * 20 && (
          <Link
            className="button"
            href={`/history?page=${page + 1}${q.chain ? `&chain=${q.chain}` : ""}`}
          >
            Next
          </Link>
        )}
      </div>
      {legacy.status === "fulfilled" && (
        <section className="panel">
          <h2>Existing public runtime · latest 20 records</h2>
          <p className="muted">
            Separate journal from the public app. Older legacy generations
            without attribution are never assigned to a chain.
          </p>
          {legacy.value.batches
            .filter((b) => !q.chain || b.chain_id === q.chain)
            .map((b) => (
              <div className="record-row" key={b.request_id}>
                <div>
                  <strong>{b.chain_name}</strong>
                  <p className="muted">
                    {b.request_id} ·{" "}
                    {new Date(b.started_at).toLocaleString("en-US")}
                  </p>
                </div>
                <span className="tag">{b.status}</span>
              </div>
            ))}
        </section>
      )}
    </>
  );
}
