"use client";
import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
export default function RecoverExecution({ id }: { id: string }) {
  const router = useRouter();
  const inFlight = useRef(false);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  return (
    <div className="form-stack">
      <p className="muted">
        Recovery skips saved outputs. Only steps never dispatched can resume and
        incur new charges. An unconfirmed started step will not be repeated.
      </p>
      <button
        disabled={busy}
        aria-busy={busy}
        onClick={async () => {
          if (inFlight.current) return;
          inFlight.current = true;
          setBusy(true);
          setError("");
          try {
            const response = await fetch(`/api/execute/${id}/resume`, {
              method: "POST",
            });
            if (
              response.headers.get("Content-Type")?.includes("application/json")
            ) {
              const data = await response.json();
              if (!response.ok)
                throw Error(data.error || "Recovery could not be confirmed.");
              if (data.run?.status !== "completed")
                throw Error("Inspect saved history before retrying.");
            } else {
              if (!response.ok || !response.body)
                throw Error("Recovery response is unavailable.");
              const reader = response.body.getReader(),
                decoder = new TextDecoder();
              let buffer = "",
                terminal = false;
              while (true) {
                const { value, done } = await reader.read();
                buffer += decoder.decode(value, { stream: !done });
                let newline;
                while ((newline = buffer.indexOf("\n")) >= 0) {
                  const line = buffer.slice(0, newline);
                  buffer = buffer.slice(newline + 1);
                  if (!line) continue;
                  const event = JSON.parse(line);
                  if (event.type === "error") throw Error(event.error);
                  if (event.type === "finished") terminal = true;
                }
                if (done) break;
              }
              if (!terminal)
                throw Error(
                  "Connection ended before recovery was confirmed. Recheck saved history; no model request is retried automatically.",
                );
            }
          } catch (e) {
            setError(
              e instanceof Error
                ? e.message
                : "Recovery could not be confirmed.",
            );
          } finally {
            inFlight.current = false;
            setBusy(false);
            router.refresh();
          }
        }}
      >
        {busy
          ? "Checking / resuming…"
          : "Recover saved run / resume safe steps"}
      </button>
      {error && (
        <p role="alert" className="notice error">
          {error}
        </p>
      )}
    </div>
  );
}
