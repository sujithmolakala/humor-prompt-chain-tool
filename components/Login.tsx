"use client";
import { useEffect, useState } from "react";
import { useHydrated } from "./useHydrated";
import { fragmentOAuthOutcome } from "@/lib/oauth-errors";
import { safeNext } from "@/lib/security";
export default function Login({ configured }: { configured: boolean }) {
  const ready = useHydrated();
  useEffect(() => {
    // Supabase may return errors in a fragment, which the server cannot read.
    const outcome = fragmentOAuthOutcome(location.hash);
    if (outcome) {
      const retry = new URL("/sign-in", location.origin);
      retry.searchParams.set("oauth", outcome);
      location.replace(retry.toString());
    }
  }, []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <>
      <button
        className="button primary login-button"
        disabled={busy || !ready || !configured}
        aria-busy={busy}
        onClick={async () => {
          setBusy(true);
          setError("");
          try {
            const destination = new URL("/auth/sign-in", location.origin);
            destination.searchParams.set(
              "next",
              safeNext(new URLSearchParams(location.search).get("next")),
            );
            location.assign(destination.toString());
          } catch {
            setError("Sign-in could not start. Please try again.");
            setBusy(false);
          }
        }}
      >
        {busy ? "Connecting…" : "Sign in with Google"}
      </button>
      {busy && (
        <span className="sr-only" role="status">
          Opening Google sign-in…
        </span>
      )}
      {error && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}
    </>
  );
}
