import type { Metadata } from "next";

import "./globals.css";

export const metadata: Metadata = {
  title: "DASH - Solana Workflow Builder",
  description: "Internal workflow builder for Helius RPC HTTP methods.",
  icons: {
    icon: "/icon.svg",
  },
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
