"use client";
import { useState } from "react";
import { ArrowUpRight } from "lucide-react";
import { useHydrated } from "./useHydrated";
import { safeNext } from "@/lib/security";
export default function Login({ configured }: { configured: boolean }) {
  const ready = useHydrated();
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
        <span className="google-mark">G</span>
        {busy ? "Connecting…" : "Continue with Google"}
        <ArrowUpRight size={18} />
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
