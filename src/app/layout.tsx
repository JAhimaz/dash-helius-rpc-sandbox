import type { Metadata } from "next";

import "./globals.css";

export const metadata: Metadata = {
  title: "Helius Sandbox",
  description: "Internal workflow builder for Helius RPC HTTP methods.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="antialiased">{children}</body>
    </html>
  );
}
