"use client";

import { useAuth } from "@/lib/auth";

export default function LoginCallbackPage() {
  const { ready, user, config, login } = useAuth();

  if (!ready) return <div className="panel">Completing sign-in…</div>;
  if (user) {
    return (
      <div className="panel">
        <h2>Signed in</h2>
        <p className="page-sub">Welcome, {user.email}. Redirecting…</p>
        <meta httpEquiv="refresh" content="0;url=/" />
      </div>
    );
  }
  if (config?.oidcEnabled) {
    return (
      <div className="panel">
        <h2>Sign in</h2>
        <p className="page-sub">Finish Okta login to use the wizard.</p>
        <button className="btn btn-primary" type="button" onClick={login}>
          Sign in with Okta
        </button>
      </div>
    );
  }
  return (
    <div className="panel">
      <h2>Auth disabled</h2>
      <p className="page-sub">This environment runs with AUTH_DISABLED — no login required.</p>
      <a className="btn btn-primary" href="/">
        Continue
      </a>
    </div>
  );
}
