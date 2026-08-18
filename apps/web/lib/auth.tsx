"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { apiBase } from "@/lib/api";

const TOKEN_KEY = "rew-access-token";

export type AuthMe = {
  sub: string;
  email: string;
  name: string;
  groups: string[];
  role: "user" | "admin";
};

type AuthConfig = {
  authDisabled: boolean;
  oidcEnabled: boolean;
  issuer?: string;
  clientId?: string;
};

type AuthContextValue = {
  ready: boolean;
  config: AuthConfig | null;
  user: AuthMe | null;
  token: string | null;
  login: () => void;
  logout: () => void;
  setToken: (token: string | null) => void;
  refreshMe: () => Promise<void>;
};

const AuthContext = createContext<AuthContextValue | null>(null);

function randomString(len = 43): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  return Array.from(bytes, (b) => chars[b % chars.length]).join("");
}

async function sha256Base64Url(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest("SHA-256", data);
  const bytes = new Uint8Array(hash);
  let str = "";
  bytes.forEach((b) => {
    str += String.fromCharCode(b);
  });
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [config, setConfig] = useState<AuthConfig | null>(null);
  const [user, setUser] = useState<AuthMe | null>(null);
  const [token, setTokenState] = useState<string | null>(null);

  const setToken = useCallback((t: string | null) => {
    setTokenState(t);
    if (t) localStorage.setItem(TOKEN_KEY, t);
    else localStorage.removeItem(TOKEN_KEY);
  }, []);

  const refreshMe = useCallback(async () => {
    const headers: HeadersInit = {};
    const t = localStorage.getItem(TOKEN_KEY);
    if (t) headers.Authorization = `Bearer ${t}`;
    const res = await fetch(`${apiBase()}/auth/me`, { headers, cache: "no-store" });
    if (!res.ok) {
      setUser(null);
      return;
    }
    setUser(await res.json());
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        const cfg = (await fetch(`${apiBase()}/auth/config`, { cache: "no-store" }).then((r) =>
          r.json(),
        )) as AuthConfig;
        setConfig(cfg);
        const stored = localStorage.getItem(TOKEN_KEY);
        if (stored) setTokenState(stored);
        if (cfg.authDisabled || stored) {
          const headers: HeadersInit = {};
          if (stored) headers.Authorization = `Bearer ${stored}`;
          const me = await fetch(`${apiBase()}/auth/me`, { headers, cache: "no-store" });
          if (me.ok) setUser(await me.json());
        }
      } catch {
        setConfig({ authDisabled: true, oidcEnabled: false });
      } finally {
        setReady(true);
      }
    })();
  }, []);

  // Handle OIDC redirect ?code=
  useEffect(() => {
    if (!config?.oidcEnabled || !config.issuer || !config.clientId) return;
    const params = new URLSearchParams(window.location.search);
    const code = params.get("code");
    const state = params.get("state");
    if (!code) return;
    const savedState = sessionStorage.getItem("rew-oidc-state");
    const verifier = sessionStorage.getItem("rew-oidc-verifier");
    if (!verifier || state !== savedState) return;

    void (async () => {
      const body = new URLSearchParams({
        grant_type: "authorization_code",
        client_id: config.clientId!,
        code,
        redirect_uri: `${window.location.origin}/login/callback`,
        code_verifier: verifier,
      });
      const tokenRes = await fetch(`${config.issuer}/v1/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
      });
      const tokenJson = (await tokenRes.json()) as { access_token?: string; error?: string };
      if (tokenJson.access_token) {
        setToken(tokenJson.access_token);
        sessionStorage.removeItem("rew-oidc-state");
        sessionStorage.removeItem("rew-oidc-verifier");
        window.history.replaceState({}, "", "/");
        await refreshMe();
      }
    })();
  }, [config, setToken, refreshMe]);

  const login = useCallback(() => {
    if (!config?.oidcEnabled || !config.issuer || !config.clientId) return;
    void (async () => {
      const verifier = randomString(64);
      const challenge = await sha256Base64Url(verifier);
      const state = randomString(24);
      sessionStorage.setItem("rew-oidc-verifier", verifier);
      sessionStorage.setItem("rew-oidc-state", state);
      const qs = new URLSearchParams({
        client_id: config.clientId!,
        response_type: "code",
        scope: "openid profile email groups",
        redirect_uri: `${window.location.origin}/login/callback`,
        state,
        code_challenge: challenge,
        code_challenge_method: "S256",
      });
      window.location.href = `${config.issuer}/v1/authorize?${qs}`;
    })();
  }, [config]);

  const logout = useCallback(() => {
    setToken(null);
    setUser(null);
  }, [setToken]);

  const value = useMemo(
    () => ({ ready, config, user, token, login, logout, setToken, refreshMe }),
    [ready, config, user, token, login, logout, setToken, refreshMe],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}

export function getAccessToken(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem(TOKEN_KEY);
}
