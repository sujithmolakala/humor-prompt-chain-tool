import Link from "next/link";
import { ShieldX } from "lucide-react";
import SignOut from "@/components/SignOut";
export const dynamic = "force-dynamic";
export const metadata = { title: "Access denied" };
export default function Denied() {
  return (
    <main className="auth-page">
      <div className="auth-card">
        <ShieldX className="accent" size={40} />
        <p className="eyebrow">RESTRICTED WORKSPACE</p>
        <h1>Access denied.</h1>
        <p className="muted">
          This workspace is available to superadmins. Ask the project owner to
          verify your account access.
        </p>
        <SignOut className="button primary">
          Sign out and switch account
        </SignOut>
        <Link className="text-link" href="/">
          Check access again
        </Link>
      </div>
    </main>
  );
}
