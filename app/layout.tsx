import type { Metadata } from "next";
import { themeScript } from "@/lib/theme";
import "./globals.css";
export const metadata: Metadata = {
  title: { default: "Humor Study Studio", template: "%s · Humor Study Studio" },
  description:
    "Humor Study Studio — private prompt chain management and execution",
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
