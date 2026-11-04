"use client";
export default function ErrorPage({ reset }: { reset: () => void }) {
  return (
    <div className="panel empty" role="alert">
      <h1>Workspace temporarily unavailable</h1>
      <p>
        Your changes have not been confirmed. Reload to check the saved state.
      </p>
      <button onClick={reset}>Try again</button>
    </div>
  );
}
