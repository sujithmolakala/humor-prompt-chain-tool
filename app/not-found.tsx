import Link from "next/link";
export default function NotFound() {
  return (
    <main className="auth-page">
      <section className="auth-card">
        <h1>Record not found</h1>
        <p>It may have been deleted or the link may be incorrect.</p>
        <Link href="/">Return to overview</Link>
      </section>
    </main>
  );
}
