import Login from "@/components/Login";
import Theme from "@/components/Theme";
export const dynamic = "force-dynamic";
export default function SignIn() {
  const configured =
    !!process.env.NEXT_PUBLIC_SUPABASE_URL &&
    !!process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  return (
    <main className="auth-page">
      <div className="auth-card">
        <p className="eyebrow">HUMOR CHAINS / WORKFLOW STUDIO</p>
        <h1>From image to punchline.</h1>
        <p className="muted">
          Design, run, and refine your AI prompt workflows in one focused
          workspace.
        </p>
        <div className="login-flow">
          <span>01 · Describe</span>
          <span>02 · Observe</span>
          <span>03 · Caption</span>
        </div>
        <Login configured={configured} />
        <p className="muted">Google sign-in · Superadmins only</p>
        {!configured && (
          <p role="status">
            Set the two public Supabase variables in .env.local to enable
            sign-in.
          </p>
        )}
        <Theme />
      </div>
    </main>
  );
}
