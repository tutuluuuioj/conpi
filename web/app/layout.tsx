import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Conpi — Trust-Minimised LLM Credit Marketplace",
  description: "Trade unused prepaid LLM API credits securely on NEAR Protocol backed by Intel TDX Confidential VMs (TEE).",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="dark">
      <body className="antialiased bg-slate-950 text-slate-100 min-h-screen">
        {children}
      </body>
    </html>
  );
}
