"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ThemeToggle } from "@/components/ThemeToggle";
import { useAuth } from "@/lib/auth";

const TABS = [
  { href: "/", label: "Instances", match: (p: string) => p === "/" || p.startsWith("/instances") },
  { href: "/wizard", label: "Create", match: (p: string) => p.startsWith("/wizard") },
  { href: "/credentials", label: "Credentials", match: (p: string) => p.startsWith("/credentials") },
];

export function AppNav() {
  const pathname = usePathname() || "/";
  const { ready, config, user, login, logout } = useAuth();

  return (
    <header className="appnav">
      <div className="appnav-top">
        <Link className="brand" href="/">
          <span className="brand-mark" aria-hidden>
            R
          </span>
          <span>
            <span className="brand-title">Redis Enterprise Wizard</span>
            <span className="brand-sub">Provision and tear down clusters on GCP</span>
          </span>
        </Link>
        <div className="appnav-actions">
          {ready && user ? (
            <span className="user-chip" title={user.email}>
              {user.name || user.email}
              {user.role === "admin" ? " · admin" : ""}
            </span>
          ) : null}
          {ready && config?.oidcEnabled && !config.authDisabled ? (
            user ? (
              <button className="btn" type="button" onClick={logout}>
                Sign out
              </button>
            ) : (
              <button className="btn btn-primary" type="button" onClick={login}>
                Sign in with Okta
              </button>
            )
          ) : null}
          <ThemeToggle />
        </div>
      </div>

      <nav className="tabs" aria-label="Sections">
        {TABS.map((tab) => {
          const active = tab.match(pathname);
          return (
            <Link
              key={tab.href}
              href={tab.href}
              className={active ? "tab tab-active" : "tab"}
              aria-current={active ? "page" : undefined}
            >
              {tab.label}
            </Link>
          );
        })}
      </nav>
    </header>
  );
}
