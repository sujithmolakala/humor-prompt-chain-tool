import type { Metadata } from "next";
import { themeScript } from "@/lib/theme";
import "./globals.css";
export const metadata: Metadata = {
  title: { default: "Overview · Humor Chains", template: "%s · Humor Chains" },
  description: "Private prompt chain management and execution workspace",
  robots: { index: false, follow: false },
};
export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
