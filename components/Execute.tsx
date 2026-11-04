"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import type { RuntimeState } from "@/lib/runtime-admin";
import type {
  ExecutionSnapshot,
  StructuredOutput,
} from "@/lib/chain-execution";
export default function Execute({
  state,
  selectedId,
}: {
  state: RuntimeState;
  selectedId?: string;
}) {
  const [chain, setChain] = useState(selectedId || state.chains[0]?.id || ""),
    [file, setFile] = useState<File | null>(null),
    [preview, setPreview] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [run, setRun] = useState(""),
    [running, setRunning] = useState(-1),
    [outputs, setOutputs] = useState<StructuredOutput[]>([]),
    [finished, setFinished] = useState(false),
    [uncertain, setUncertain] = useState(false);
  const [snapshot, setSnapshot] = useState<ExecutionSnapshot | null>(null);
  const token = useRef("");
  useEffect(
    () => () => {
      if (preview) URL.revokeObjectURL(preview);
    },
    [preview],
  );
  useEffect(() => {
    const leave = (e: BeforeUnloadEvent) => {
      if (busy) e.preventDefault();
    };
    window.addEventListener("beforeunload", leave);
    return () => window.removeEventListener("beforeunload", leave);
  }, [busy]);
  const selected = state.chains.find((c) => c.id === chain);
  const displayedSteps =
    snapshot?.steps.map((s) => ({
      ...s,
      prompt_template: s.template,
      execution_role: s.role,
    })) || selected?.steps;
  async function start() {
    if (!file || busy || !selected) return;
    setBusy(true);
    setError("");
    setFinished(false);
    setOutputs([]);
    setRunning(-1);
    setUncertain(false);
    if (!token.current) token.current = crypto.randomUUID();
    setRun(token.current);
    try {
      const body = new FormData();
      body.set("requestId", token.current);
      body.set("chainId", chain);
      body.set("image", file);
      const response = await fetch("/api/execute", { method: "POST", body });
      if (!response.ok) {
        const data = await response.json();
        throw Error(data.error || "Could not start execution.");
      }
      if (response.headers.get("Content-Type")?.includes("application/json")) {
        const data = await response.json();
        setRun(data.id);
        setError(
          "This request is already reserved. View saved history to check its outcome. No model call was repeated.",
        );
        return;
      }
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "",
        terminal = false;
      while (true) {
        const { done, value } = await reader.read();
        buffer += decoder.decode(value, { stream: !done });
        let newline;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          if (!line) continue;
          const e = JSON.parse(line);
          if (e.type === "started") setSnapshot(e.snapshot);
          if (e.type === "running") setRunning(e.index);
          if (e.type === "completed")
            setOutputs((old) => {
              const next = [...old];
              next[e.index] = e.output;
              return next;
            });
          if (e.type === "finished") {
            terminal = true;
            setFinished(true);
            setRunning(-1);
          }
          if (e.type === "error") {
            terminal = true;
            setError(e.error);
            setUncertain(true);
            setRunning(-1);
          }
        }
        if (done) break;
      }
      if (!terminal) {
        setUncertain(true);
        throw Error(
          "Connection ended before completion was confirmed. Check saved history; do not repeat the request blindly.",
        );
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Execution failed.");
      setUncertain(true);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="execution-grid">
      <section className="panel">
        <p className="eyebrow">01 / INPUT</p>
        <h2>Choose your starting point</h2>
        <label>
          Prompt chain
          <select
            value={chain}
            disabled={busy || !!run}
            onChange={(e) => setChain(e.target.value)}
          >
            {state.chains.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} · {c.steps.length} steps
              </option>
            ))}
          </select>
        </label>
        <label className="upload-zone">
          {preview ? (
            <img src={preview} alt="Selected input image" />
          ) : (
            <>
              <span className="upload-symbol">↑</span>
              <strong>Upload an image</strong>
              <span>JPEG, PNG, or WebP · up to 3 MB</span>
            </>
          )}
          <input
            aria-label="Upload input image"
            type="file"
            accept="image/jpeg,image/png,image/webp"
            disabled={busy || !!run}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f && f.size <= 3 * 1024 * 1024) {
                setFile(f);
                setPreview(URL.createObjectURL(f));
                setError("");
              } else {
                setFile(null);
                setPreview("");
                setError("Choose an image up to 3 MB.");
              }
            }}
          />
        </label>
        <button
          className="button primary full"
          disabled={busy || !!run || !file || !selected?.steps.length}
          onClick={start}
        >
          {busy ? "Executing workflow…" : "Run chain →"}
        </button>
        <p className="muted footnote">
          Live Gemini calls may incur cost. No automatic provider retries. The
          original image accompanies every step.
        </p>
        {error && (
          <p className="notice error" role="alert">
            {error}
          </p>
        )}
        {run && (
          <div className="form-stack">
            <Link className="button" href={`/history/${run}`}>
              Inspect saved execution
            </Link>
            {!busy && (
              <button
                onClick={() => {
                  if (
                    confirm(
                      "Start a NEW execution? This creates a new request and may incur additional model charges. Check history first.",
                    )
                  ) {
                    token.current = "";
                    setRun("");
                    setSnapshot(null);
                    setError("");
                    setOutputs([]);
                    setFinished(false);
                    setUncertain(false);
                  }
                }}
              >
                Prepare a new billable run
              </button>
            )}
          </div>
        )}
      </section>
      <section className="panel">
        <p className="eyebrow">02 / WORKFLOW</p>
        <h2>{snapshot?.name || selected?.name || "Create a chain first"}</h2>
        <p className="muted">
          {selected?.description ||
            "Each step builds on the last, with original image context retained."}
        </p>
        <ol className="execution-steps">
          {displayedSteps?.map((s, index) => (
            <li key={s.id}>
              <span className={`step-number ${outputs[index] ? "done" : ""}`}>
                {outputs[index] ? "✓" : index + 1}
              </span>
              <div className="step-content">
                <div className="section-heading">
                  <strong>{s.execution_role.replaceAll("_", " ")}</strong>
                  <span className="tag">
                    {outputs[index]
                      ? "Completed"
                      : running === index && busy
                        ? "Running"
                        : uncertain
                          ? "Not confirmed"
                          : "Pending"}
                  </span>
                </div>
                <p className="muted">{s.prompt_template}</p>
                {outputs[index] && (
                  <pre>{JSON.stringify(outputs[index], null, 2)}</pre>
                )}
              </div>
            </li>
          ))}
        </ol>
        {finished && (
          <div className="results">
            <span className="tag completed">Execution completed</span>
            <h2>Five angles. One image.</h2>
            {outputs.at(-1)?.captions?.map((c, i) => (
              <p className="caption" key={i}>
                <span>{i + 1}</span>
                {c}
              </p>
            ))}
          </div>
        )}
        {!run && (
          <div className="empty">
            <p className="muted">
              Intermediate outputs and final captions appear here as each step
              completes.
            </p>
          </div>
        )}
      </section>
    </div>
  );
}
