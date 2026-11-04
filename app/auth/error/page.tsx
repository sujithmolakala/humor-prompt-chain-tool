import { safeNext, configuredAppOrigin } from "@/lib/security";
import SignOut from "@/components/SignOut";
export default async function AuthError({
  searchParams,
}: {
  searchParams: Promise<{ temporary?: string; next?: string }>;
}) {
  const params = await searchParams;
  const origin = configuredAppOrigin();
  const signInUrl = origin
    ? new URL("/sign-in", origin).toString()
    : "/sign-in";
  const temporary = params.temporary === "1";
  return (
    <main className="auth-page">
      <div className="auth-card">
        <p className="eyebrow">LET’S TRY AGAIN</p>
        <h1>
          {temporary
            ? "Verification temporarily unavailable."
            : "Sign-in interrupted."}
        </h1>
        <p className="muted">
          {temporary
            ? "We couldn’t verify your account right now. This does not mean your admin access was removed. Please try again."
            : "The sign-in link may have expired. Start a fresh Google sign-in to continue."}
        </p>
        {temporary && (
          <a className="button primary" href={safeNext(params.next || null)}>
            Try verification again
          </a>
        )}
        <a
          className={temporary ? "text-link" : "button primary"}
          href={signInUrl}
        >
          Back to sign in
        </a>
        {temporary && (
          <SignOut className="text-link">Sign out and switch account</SignOut>
        )}
      </div>
    </main>
  );
}
