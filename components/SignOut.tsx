"use client";
import { useState, type ReactNode } from "react";
import { useHydrated } from "./useHydrated";
export default function SignOut({
  children = "Sign out",
  className,
}: {
  children?: ReactNode;
  className?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const ready = useHydrated();
  return (
    <form
      action="/auth/sign-out"
      method="post"
      data-hydrated={ready}
      onSubmit={async (event) => {
        event.preventDefault();
        setBusy(true);
        setError(false);
        try {
          const response = await fetch("/auth/sign-out", {
            method: "POST",
            headers: { Accept: "application/json" },
            credentials: "same-origin",
            cache: "no-store",
          });
          if (!response.ok) throw new Error();
          const data = await response.json();
          if (
            data.redirect !== "/sign-in" &&
            data.redirect !== "/sign-in?logout=local"
          )
            throw new Error();
          location.assign(data.redirect);
        } catch {
          setError(true);
          setBusy(false);
        }
      }}
    >
      <button className={className} disabled={busy} aria-busy={busy}>
        {busy ? "Signing out…" : children}
      </button>
      {busy && (
        <span className="sr-only" role="status">
          Signing out…
        </span>
      )}
      {error && (
        <span role="alert">Sign-out could not complete. Please try again.</span>
      )}
    </form>
  );
}
