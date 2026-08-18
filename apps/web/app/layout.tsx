import type { Metadata } from "next";
import "./globals.css";
import { AppNav } from "@/components/AppNav";
import { Providers } from "@/components/Providers";

export const metadata: Metadata = {
  title: "Redis Enterprise Wizard",
  description: "Terraform Redis Enterprise clusters on GCP VMs or GKE",
  icons: {
    icon: [{ url: "/favicon.svg", type: "image/svg+xml" }],
  },
};

// Runs before first paint so the stored theme does not flash the wrong palette.
const THEME_INIT = `(function(){try{var s=localStorage.getItem("rew-theme");var d=s?s==="dark":window.matchMedia("(prefers-color-scheme: dark)").matches;document.documentElement.dataset.theme=d?"dark":"light";}catch(e){document.documentElement.dataset.theme="light";}})();`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT }} />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link
          href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@300;400;500;600;700&family=Space+Mono:wght@400;700&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>
        <Providers>
          <div className="shell">
            <AppNav />
            {children}
          </div>
        </Providers>
      </body>
    </html>
  );
}
