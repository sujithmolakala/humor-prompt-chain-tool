import { requireAdminPage } from "@/lib/auth";
import { getState } from "@/lib/tool-data";
import { Heading } from "@/components/Common";
import Theme from "@/components/Theme";
import ModelSettings from "@/components/ModelSettings";
export default async function Settings() {
  const access = await requireAdminPage();
  let state;
  try {
    state = await getState(access);
  } catch {}
  return (
    <>
      <Heading
        eyebrow="SETTINGS"
        title="A workspace that works for you."
        description="Appearance, model readiness, and connection requirements."
      />
      <section className="panel">
        <h2>Appearance</h2>
        <p className="muted">
          System follows your operating system. Your preference stays on this
          browser.
        </p>
        <Theme />
      </section>
      <section className="panel">
        <h2>Connection checklist</h2>
        <div className="record-row">
          <span>Supabase public configuration</span>
          <span className="tag">
            {process.env.NEXT_PUBLIC_SUPABASE_URL ? "Configured" : "Missing"}
          </span>
        </div>
        <div className="record-row">
          <span>Gemini server credential</span>
          <span className="tag">
            {process.env.GEMINI_API_KEY
              ? "Present · not live verified"
              : "Missing"}
          </span>
        </div>
        <div className="record-row">
          <span>Prompt runtime RPC</span>
          <span className="tag">
            {state ? "Available" : "Migration / connection required"}
          </span>
        </div>
        <p className="muted">
          Expected OAuth callback:{" "}
          <code>
            {process.env.APP_ORIGIN || "http://localhost:3002"}/auth/callback
          </code>
          . Add this exact URL to the shared Supabase redirect allowlist only
          after owner approval. Keep existing URLs.
        </p>
        <p className="muted">
          Database setup is manual. See README.md for prerequisites, migration
          review, private storage, and execution verification. No service-role
          key is used.
        </p>
      </section>
      {state && <ModelSettings initial={state} />}
    </>
  );
}
