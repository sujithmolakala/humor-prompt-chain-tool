import Link from "next/link";
import { requireAdminPage } from "@/lib/auth";
import { getState, getHistory } from "@/lib/tool-data";
import { Heading, Setup } from "@/components/Common";
export default async function Overview() {
  const access = await requireAdminPage();
  const result = await Promise.allSettled([
    getState(access),
    getHistory(access),
  ]);
  const state = result[0].status === "fulfilled" ? result[0].value : null;
  const history = result[1].status === "fulfilled" ? result[1].value : null;
  return (
    <>
      <Heading
        eyebrow="WORKSPACE OVERVIEW"
        title="Your next great caption starts here."
        description="Build thoughtful workflows. Follow every step. Keep every result."
      >
        <Link className="button primary" href="/chains?create=1">
          + Create chain
        </Link>
        <Link className="button" href="/execute">
          Run a workflow ↗
        </Link>
      </Heading>
      {!state && (
        <Setup message="The shared prompt runtime is unavailable. Existing applications remain independent." />
      )}
      <div className="stats-grid">
        {[
          ["Prompt chains", state?.chains.length],
          ["Active chains", state?.chains.filter((c) => c.enabled).length],
          [
            "Ordered steps",
            state?.chains.reduce((n, c) => n + c.steps.length, 0),
          ],
          ["Executions", history?.stats.total],
          ["Successful", history?.stats.completed],
          ["Failed", history?.stats.failed],
        ].map(([label, value]) => (
          <section className="stat panel" key={label}>
            <p>{label}</p>
            <strong>{value ?? "—"}</strong>
            <small>
              {value === undefined ? "Setup required" : "From saved records"}
            </small>
          </section>
        ))}
      </div>
      <div className="two-column">
        <section className="panel">
          <div className="section-heading">
            <h2>Recently modified chains</h2>
            <Link href="/chains">View all →</Link>
          </div>
          {state?.chains.length ? (
            [...state.chains]
              .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
              .slice(0, 5)
              .map((c) => (
                <Link
                  href={`/chains/${c.id}`}
                  className="record-row"
                  key={c.id}
                >
                  <div>
                    <strong>{c.name}</strong>
                    <p className="muted">
                      {c.steps.length} steps ·{" "}
                      {new Date(c.updated_at).toLocaleDateString("en-US")}
                    </p>
                  </div>
                  <span className="tag">
                    {c.enabled ? "Active" : "Inactive"}
                  </span>
                </Link>
              ))
          ) : (
            <p className="muted">Create your first chain to begin.</p>
          )}
        </section>
        <section className="panel">
          <div className="section-heading">
            <h2>Recent generations</h2>
            <Link href="/history">View history →</Link>
          </div>
          {history?.runs.length ? (
            history.runs.slice(0, 5).map((r) => (
              <Link href={`/history/${r.id}`} className="record-row" key={r.id}>
                <div>
                  <strong>{r.snapshot.name}</strong>
                  <p className="muted">
                    {new Date(r.started_at).toLocaleString("en-US")}
                  </p>
                </div>
                <span className={`tag ${r.status}`}>{r.status}</span>
              </Link>
            ))
          ) : (
            <p className="muted">
              {history
                ? "Your saved executions will appear here."
                : "Execution history requires the new tool migration."}
            </p>
          )}
        </section>
      </div>
      <p className="muted footnote">
        Execution metrics cover this tool’s journal. Existing public runtime
        history is available separately in Generation History. Uncertain or
        interrupted runs are never counted as successful.
      </p>
    </>
  );
}
