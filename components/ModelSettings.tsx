"use client";
import { useState } from "react";
import type { RuntimeState } from "@/lib/runtime-admin";
export default function ModelSettings({ initial }: { initial: RuntimeState }) {
  const [state, setState] = useState(initial),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState("");
  async function approve(id: string) {
    if (
      !confirm(
        "Verify this model with one real synthetic-image Gemini call? This may incur cost and updates shared model approval for future workflows.",
      )
    )
      return;
    setBusy(true);
    setMessage("Verifying model…");
    try {
      const r = await fetch("/api/chains", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          operation: "approve_model",
          payload: { id },
          revision: state.settings.revision,
        }),
      });
      const d = await r.json();
      if (!r.ok) throw Error(d.error);
      setState(d);
      setMessage("Model verified and approved.");
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Verification failed.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="panel">
      <h2>Database models</h2>
      <p className="muted">
        Default model: {state.settings.default_model}. Model identifiers,
        temperature, and token limits come from the shared catalog. Parameter
        changes invalidate approval.
      </p>
      {state.models.map((m) => (
        <div className="record-row" key={m.id}>
          <div>
            <strong>{m.name}</strong>
            <p className="muted">
              {m.identifier} · {m.provider}
            </p>
            <span className="tag">
              {m.approved ? "Approved" : "Approval required"}
            </span>
          </div>
          <button
            disabled={busy || !m.enabled || !m.provider_enabled}
            onClick={() => approve(m.id)}
          >
            {m.approved ? "Reverify model" : "Verify and approve"}
          </button>
        </div>
      ))}
      <p role="status">{message}</p>
    </section>
  );
}
