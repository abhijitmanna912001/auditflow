import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "AuditFlow — Workpaper review",
  description: "A local, simulated AuditFlow workpaper reviewer workspace.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
