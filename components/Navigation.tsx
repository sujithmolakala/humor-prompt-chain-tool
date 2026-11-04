"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Workflow,
  LayoutDashboard,
  Layers,
  Play,
  History,
  Settings,
} from "lucide-react";
import Theme from "./Theme";
import SignOut from "./SignOut";
export default function Navigation() {
  const path = usePathname();
  return (
    <aside className="sidebar">
      <Link href="/" className="brand">
        <span className="brand-icon">
          <Workflow size={22} />
        </span>
        <span>
          Humor <strong>Chains</strong>
          <small>WORKFLOW STUDIO</small>
        </span>
      </Link>
      <p className="nav-label">WORKSPACE</p>
      <nav aria-label="Main navigation">
        {[
          ["/", "Overview", LayoutDashboard],
          ["/chains", "Prompt Chains", Layers],
          ["/execute", "Execute", Play],
          ["/history", "Generation History", History],
          ["/settings", "Settings", Settings],
        ].map(([href, label, Icon]) => {
          const H = href as string;
          const I = Icon as typeof Workflow;
          return (
            <Link
              key={H}
              href={H}
              className={
                path === H || (H !== "/" && path.startsWith(H + "/"))
                  ? "active"
                  : ""
              }
              aria-current={path === H ? "page" : undefined}
            >
              <I size={18} />
              {label as string}
            </Link>
          );
        })}
      </nav>
      <div className="sidebar-bottom">
        <span className="access-badge">
          <span /> Superadmin workspace
        </span>
        <Theme />
        <SignOut className="button quiet" />
      </div>
    </aside>
  );
}
