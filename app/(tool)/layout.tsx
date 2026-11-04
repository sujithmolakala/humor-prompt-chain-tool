import { requireAdminPage } from "@/lib/auth";
import Navigation from "@/components/Navigation";
export const dynamic = "force-dynamic";
export default async function ToolLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  await requireAdminPage();
  return (
    <div className="app-shell">
      <Navigation />
      <div className="main-column">
        <header className="topbar">
          <span>Humor Study Studio</span>
          <span className="tag">Private workspace</span>
        </header>
        <main id="main-content">{children}</main>
      </div>
    </div>
  );
}
