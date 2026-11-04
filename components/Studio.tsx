"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  GripVertical,
  ArrowUp,
  ArrowDown,
  Copy,
  Trash2,
  Plus,
  ArrowRight,
} from "lucide-react";
import type {
  RuntimeState,
  RuntimeChain,
  RuntimeStep,
} from "@/lib/runtime-admin";
import { useHydrated } from "./useHydrated";
import { moveStep } from "@/lib/order";
export default function Studio({
  initial,
  chainId,
}: {
  initial: RuntimeState;
  chainId?: string;
}) {
  const ready = useHydrated();
  const [state, setState] = useState(initial),
    [query, setQuery] = useState(""),
    [filter, setFilter] = useState("all"),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState(""),
    [error, setError] = useState(""),
    [drag, setDrag] = useState<number | null>(null),
    [dirty, setDirty] = useState(false);
  const dirtyForms = useRef(new Set<HTMLFormElement>()),
    submitted = useRef<HTMLFormElement | null>(null);
  useEffect(() => {
    const leave = (e: BeforeUnloadEvent) => {
      if (dirty) {
        e.preventDefault();
      }
    };
    const navigate = (e: MouseEvent) => {
      if (
        dirty &&
        (e.target as HTMLElement).closest("a") &&
        !confirm("Leave with unsaved changes?")
      ) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    window.addEventListener("beforeunload", leave);
    document.addEventListener("click", navigate, true);
    return () => {
      window.removeEventListener("beforeunload", leave);
      document.removeEventListener("click", navigate, true);
    };
  }, [dirty]);
  async function save(
    operation: string,
    payload: Record<string, unknown>,
    duplicate = false,
  ) {
    const form = submitted.current;
    submitted.current = null;
    setBusy(true);
    setError("");
    setNotice("Saving…");
    try {
      const res = await fetch(duplicate ? "/api/duplicate" : "/api/chains", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          duplicate
            ? { ...payload, expected_revision: state.settings.revision }
            : { operation, payload, revision: state.settings.revision },
        ),
      });
      const data = await res.json();
      if (!res.ok) throw Error(data.error || "Save failed.");
      setState(data);
      if (form) dirtyForms.current.delete(form);
      setDirty(dirtyForms.current.size > 0);
      setNotice("Saved to Supabase.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed.");
      setNotice("");
      if (operation === "reorder") {
        try {
          const r = await fetch("/api/chains");
          if (r.ok) setState(await r.json());
        } catch {}
      }
    } finally {
      setBusy(false);
    }
  }
  const fields = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    submitted.current = e.currentTarget;
    return Object.fromEntries(new FormData(e.currentTarget));
  };
  const selected = chainId ? state.chains.find((c) => c.id === chainId) : null;
  const modelSelect = (id: string | null) => (
    <label>
      Model
      <select name="model_id" defaultValue={id || ""}>
        <option value="">
          Database default: {state.settings.default_model}
        </option>
        {state.models.map((m) => (
          <option key={m.id} value={m.id}>
            {m.name}
            {m.approved && m.enabled && m.provider_enabled
              ? ""
              : " · unavailable / approval needed"}
          </option>
        ))}
      </select>
    </label>
  );
  const roles = (role = "auto") => (
    <label>
      Purpose
      <select name="role" defaultValue={role}>
        {[
          "auto",
          "image_analysis",
          "ideation",
          "caption_generation",
          "refinement",
        ].map((r) => (
          <option key={r} value={r}>
            {r.replaceAll("_", " ")}
          </option>
        ))}
      </select>
    </label>
  );
  function reorder(c: RuntimeChain, from: number, to: number) {
    if (dirty) {
      setError("Save your prompt changes before reordering.");
      return;
    }
    save("reorder", {
      chain_id: c.id,
      order: moveStep(
        c.steps.map((s) => s.id),
        from,
        to,
      ),
    });
  }
  const promptForm = (c: RuntimeChain, s?: RuntimeStep) => (
    <form
      className="form-stack"
      onChange={() => setDirty(true)}
      onSubmit={(e) => {
        const f = fields(e);
        save(s ? "edit_step" : "create_step", {
          ...f,
          chain_id: c.id,
          ...(s ? { id: s.id } : {}),
          model_id: f.model_id || null,
        });
      }}
    >
      <label>
        Prompt template
        <textarea
          name="template"
          rows={7}
          required
          maxLength={12000}
          defaultValue={s?.prompt_template}
          placeholder="Describe the important visual details in this image."
        />
      </label>
      <div className="two-column">
        {modelSelect(s?.model_id || null)}
        {roles(s?.execution_role)}
      </div>
      <p className="muted">
        The original image is supplied to every step. Previous structured output
        passes automatically. Optional variables: {"{{previous}}"} after step 1,
        and {"{{avoid}}"}. Final output: five captions.
      </p>
      <button
        className="button primary"
        disabled={!ready || busy || (!s && c.steps.length >= 4)}
      >
        {" "}
        {s ? "Save step" : "Add step"}
      </button>
    </form>
  );
  return (
    <div
      inert={!ready}
      onChangeCapture={(e) => {
        const form = (e.target as HTMLElement).closest("form");
        if (form) {
          dirtyForms.current.add(form);
          setDirty(true);
        }
      }}
    >
      <div className="save-status" aria-live="polite">
        {busy
          ? "Saving…"
          : dirty
            ? "Unsaved changes"
            : notice || `Configuration revision ${state.settings.revision}`}
      </div>
      {error && (
        <div className="notice error" role="alert">
          {error}{" "}
          <button onClick={() => location.reload()}>Reload saved state</button>
        </div>
      )}
      {!chainId ? (
        <>
          <div className="toolbar">
            <label className="search">
              Search chains
              <input
                aria-label="Search chains"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Find a workflow…"
              />
            </label>
            <label>
              Status
              <select
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
              >
                <option value="all">All chains</option>
                <option value="active">Active</option>
                <option value="inactive">Inactive</option>
              </select>
            </label>
          </div>
          <details className="panel create-panel">
            <summary>
              <Plus size={18} /> Create prompt chain
            </summary>
            <form
              className="form-stack"
              onChange={() => setDirty(true)}
              onSubmit={(e) => save("create_chain", fields(e))}
            >
              <label>
                Name
                <input name="name" required maxLength={200} />
              </label>
              <label>
                Description
                <textarea name="description" maxLength={4000} />
              </label>
              <button disabled={!ready || busy} className="button primary">
                Create inactive chain
              </button>
            </form>
          </details>
          <div className="chain-grid">
            {state.chains
              .filter(
                (c) =>
                  (c.name + " " + c.description)
                    .toLowerCase()
                    .includes(query.toLowerCase()) &&
                  (filter === "all" || c.enabled === (filter === "active")),
              )
              .map((c) => (
                <section className="panel chain-card" key={c.id}>
                  <div className="section-heading">
                    <span className="chain-glyph">⌘</span>
                    <span className="tag">
                      {c.enabled ? "Active" : "Inactive"}
                    </span>
                  </div>
                  <h2>
                    <Link href={`/chains/${c.id}`}>{c.name}</Link>
                  </h2>
                  <p className="muted">
                    {c.description || "A workflow waiting for its next idea."}
                  </p>
                  <div className="step-dots">
                    {c.steps.map((s) => (
                      <span key={s.id}>{s.position}</span>
                    ))}
                    {!c.steps.length && <span>—</span>}
                  </div>
                  <div className="card-footer">
                    <span className="muted">
                      {c.steps.length} ordered steps
                    </span>
                    <Link className="text-link" href={`/chains/${c.id}`}>
                      Open editor <ArrowRight size={15} />
                    </Link>
                  </div>
                </section>
              ))}
          </div>
          {!state.chains.length && (
            <div className="empty">
              <h2>Your canvas is ready.</h2>
              <p>Create a chain, add prompts, and run it with an image.</p>
            </div>
          )}
        </>
      ) : (
        selected && (
          <>
            <div className="editor-bar">
              <Link href="/chains">← All chains</Link>
              <div className="actions">
                <Link className="button" href={`/history?chain=${selected.id}`}>
                  Chain history
                </Link>
                <Link
                  className="button primary"
                  href={`/execute?chain=${selected.id}`}
                >
                  Execute chain ↗
                </Link>
              </div>
            </div>
            <section className="panel">
              <details>
                <summary>Chain details and actions</summary>
                <form
                  className="form-stack"
                  onChange={() => setDirty(true)}
                  onSubmit={(e) =>
                    save("edit_chain", { ...fields(e), id: selected.id })
                  }
                >
                  <label>
                    Name
                    <input
                      name="name"
                      defaultValue={selected.name}
                      required
                      maxLength={200}
                    />
                  </label>
                  <label>
                    Description
                    <textarea
                      name="description"
                      defaultValue={selected.description}
                      maxLength={4000}
                    />
                  </label>
                  <button disabled={!ready || busy}>Save details</button>
                </form>
                <div className="actions">
                  <button
                    disabled={!ready || busy || dirty}
                    onClick={() =>
                      save("", { target: selected.id, step_target: null }, true)
                    }
                  >
                    <Copy size={15} /> Duplicate chain
                  </button>
                  <button
                    className="danger"
                    disabled={!ready || busy || dirty}
                    onClick={() => {
                      if (
                        confirm(
                          `Delete “${selected.name}” and its steps? Historical or referenced chains are protected and will not be deleted.`,
                        )
                      )
                        save("delete_chain", { id: selected.id });
                    }}
                  >
                    <Trash2 size={15} /> Delete chain
                  </button>
                </div>
              </details>
            </section>
            <div className="section-heading editor-heading">
              <h2>
                Workflow steps{" "}
                <span className="muted">/ {selected.steps.length}</span>
              </h2>
              <span className="muted">
                Drag to reorder · Alt + ↑ / ↓ on a handle
              </span>
            </div>
            {selected.steps.map((s, index) => (
              <section
                className={`panel step-card ${drag === index ? "dragging" : ""}`}
                key={s.id}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault();
                  if (drag !== null && !busy) reorder(selected, drag, index);
                  setDrag(null);
                }}
              >
                <div className="step-heading">
                  <button
                    className="drag-handle"
                    aria-label={`Reorder step ${index + 1}`}
                    disabled={!ready || busy || dirty}
                    draggable={!busy && !dirty}
                    onDragStart={() => setDrag(index)}
                    onDragEnd={() => setDrag(null)}
                    onKeyDown={(e) => {
                      if (
                        e.altKey &&
                        (e.key === "ArrowUp" || e.key === "ArrowDown")
                      ) {
                        e.preventDefault();
                        const to = index + (e.key === "ArrowUp" ? -1 : 1);
                        if (to >= 0 && to < selected.steps.length)
                          reorder(selected, index, to);
                      }
                    }}
                  >
                    <GripVertical size={18} />
                  </button>
                  <span className="step-number">
                    {s.position.toString().padStart(2, "0")}
                  </span>
                  <div>
                    <strong>{s.execution_role.replaceAll("_", " ")}</strong>
                    <p className="muted">
                      {state.models.find((m) => m.id === s.model_id)?.name ||
                        `Default: ${state.settings.default_model}`}
                    </p>
                  </div>
                  <div className="step-actions">
                    <button
                      aria-label={`Move step ${index + 1} up`}
                      disabled={!ready || busy || dirty || index === 0}
                      onClick={() => reorder(selected, index, index - 1)}
                    >
                      <ArrowUp size={16} />
                    </button>
                    <button
                      aria-label={`Move step ${index + 1} down`}
                      disabled={
                        busy || dirty || index === selected.steps.length - 1
                      }
                      onClick={() => reorder(selected, index, index + 1)}
                    >
                      <ArrowDown size={16} />
                    </button>
                    <button
                      aria-label={`Duplicate step ${index + 1}`}
                      disabled={
                        !ready || busy || dirty || selected.steps.length >= 4
                      }
                      onClick={() =>
                        save(
                          "",
                          { target: selected.id, step_target: s.id },
                          true,
                        )
                      }
                    >
                      <Copy size={16} />
                    </button>
                    <button
                      aria-label={`Delete step ${index + 1}`}
                      className="danger"
                      disabled={!ready || busy || dirty}
                      onClick={() => {
                        if (
                          confirm(
                            "Remove this step? Historical references prevent deletion. Other steps retain their identities.",
                          )
                        )
                          save("delete_step", {
                            id: s.id,
                            chain_id: selected.id,
                          });
                      }}
                    >
                      <Trash2 size={16} />
                    </button>
                  </div>
                </div>
                {promptForm(selected, s)}
              </section>
            ))}
            {selected.steps.length < 4 && (
              <details className="panel create-panel">
                <summary>
                  <Plus size={18} /> Add workflow step
                </summary>
                {promptForm(selected)}
              </details>
            )}
            <p className="muted footnote">
              Ordering is saved atomically with a global configuration revision.
              Conflicting sessions must reload. Shared chain edits affect future
              executions in any application using this backend.
            </p>
          </>
        )
      )}
    </div>
  );
}
