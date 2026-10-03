import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "A/L ICT WhatsApp Platform",
  description: "Internal WhatsApp management platform for an A/L ICT class.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="flex min-h-full flex-col">{children}</body>
    </html>
  );
}
