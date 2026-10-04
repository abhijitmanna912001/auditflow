import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "AuditFlow — Document review",
  description:
    "Checks invoices, purchase orders and receipts for mismatches and missing documents, and sends findings for review.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
