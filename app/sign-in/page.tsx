import { oauthMessage } from "@/lib/oauth-errors";
import Login from "@/components/Login";
export const dynamic = "force-dynamic";
export const metadata = { title: "Sign in" };
export default async function SignIn({
  searchParams,
}: {
  searchParams: Promise<{ oauth?: string }>;
}) {
  const message = oauthMessage((await searchParams).oauth);
  const configured =
    !!process.env.NEXT_PUBLIC_SUPABASE_URL &&
    !!process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  return (
    <main className="auth-page studio-login">
      <div className="auth-card">
        <h1>Humor Study Studio</h1>
        <p className="muted">Authorized superadmins only</p>
        {message && (
          <p className="notice error" role="alert">
            {message}
          </p>
        )}
        <Login configured={configured} />
      </div>
    </main>
  );
}
