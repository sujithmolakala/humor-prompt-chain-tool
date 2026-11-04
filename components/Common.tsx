import Link from "next/link";
export function Heading({
  eyebrow,
  title,
  description,
  children,
}: {
  eyebrow: string;
  title: string;
  description: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="page-heading">
      <div>
        <p className="eyebrow">{eyebrow}</p>
        <h1>{title}</h1>
        <p className="muted">{description}</p>
      </div>
      <div className="actions">{children}</div>
    </div>
  );
}
export function Setup({ message }: { message: string }) {
  return (
    <section className="panel empty">
      <span className="tag">SETUP REQUIRED</span>
      <h2>Connect your workflow data</h2>
      <p>{message}</p>
      <p>
        Review the migration checklist in README.md. Hosted SQL requires owner
        approval.
      </p>
      <Link className="button" href="/settings">
        View setup details
      </Link>
    </section>
  );
}
export function Empty({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="empty">
      <h2>{title}</h2>
      <p className="muted">{children}</p>
    </div>
  );
}
