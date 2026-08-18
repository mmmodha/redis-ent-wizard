import type { FastifyReply, FastifyRequest } from "fastify";
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";

export type Role = "user" | "admin";

export interface AuthUser {
  sub: string;
  email: string;
  name: string;
  groups: string[];
  role: Role;
}

declare module "fastify" {
  interface FastifyRequest {
    user?: AuthUser;
  }
}

const AUTH_DISABLED = () =>
  process.env.AUTH_DISABLED === "true" || process.env.AUTH_DISABLED === "1";

export function authDisabled(): boolean {
  return AUTH_DISABLED();
}

function adminGroups(): Set<string> {
  const raw = process.env.OKTA_ADMIN_GROUPS || "rew-admins,rew-ops";
  return new Set(
    raw
      .split(",")
      .map((g) => g.trim())
      .filter(Boolean),
  );
}

function roleFromGroups(groups: string[]): Role {
  const admins = adminGroups();
  return groups.some((g) => admins.has(g)) ? "admin" : "user";
}

function devUser(): AuthUser {
  return {
    sub: process.env.DEV_USER_SUB || "local-dev",
    email: process.env.DEV_USER_EMAIL || "dev@localhost",
    name: process.env.DEV_USER_NAME || "Local Dev",
    groups: ["rew-admins"],
    role: "admin",
  };
}

let jwks: ReturnType<typeof createRemoteJWKSet> | undefined;

function getJwks() {
  const issuer = process.env.OKTA_ISSUER?.replace(/\/$/, "");
  if (!issuer) throw new Error("OKTA_ISSUER is not configured");
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(`${issuer}/v1/keys`));
  }
  return jwks;
}

export function oidcConfig() {
  const issuer = process.env.OKTA_ISSUER?.replace(/\/$/, "") || "";
  const clientId = process.env.OKTA_CLIENT_ID || "";
  return {
    enabled: !AUTH_DISABLED() && Boolean(issuer && clientId),
    issuer,
    clientId,
    audience: process.env.OKTA_AUDIENCE || clientId,
  };
}

function fromPayload(payload: JWTPayload): AuthUser {
  const email =
    (typeof payload.email === "string" && payload.email) ||
    (typeof payload.preferred_username === "string" && payload.preferred_username) ||
    String(payload.sub || "unknown");
  const name =
    (typeof payload.name === "string" && payload.name) ||
    email.split("@")[0] ||
    "User";
  const groups = Array.isArray(payload.groups)
    ? payload.groups.filter((g): g is string => typeof g === "string")
    : [];
  return {
    sub: String(payload.sub || email),
    email,
    name,
    groups,
    role: roleFromGroups(groups),
  };
}

export async function authenticateRequest(req: FastifyRequest): Promise<AuthUser> {
  if (AUTH_DISABLED()) return devUser();

  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    throw Object.assign(new Error("Authentication required"), { statusCode: 401 });
  }
  const token = header.slice("Bearer ".length).trim();
  const cfg = oidcConfig();
  if (!cfg.enabled) {
    throw Object.assign(new Error("OIDC is not configured (set OKTA_ISSUER and OKTA_CLIENT_ID)"), {
      statusCode: 503,
    });
  }

  try {
    const { payload } = await jwtVerify(token, getJwks(), {
      issuer: cfg.issuer,
      audience: cfg.audience,
    });
    return fromPayload(payload);
  } catch (err) {
    throw Object.assign(
      new Error(err instanceof Error ? err.message : "Invalid token"),
      { statusCode: 401 },
    );
  }
}

export async function authHook(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  // Public endpoints (config is readable before login)
  const path = req.url.split("?")[0];
  if (path === "/health" || path === "/auth/config") return;

  // EventSource cannot set Authorization; allow access_token query on log streams.
  const url = new URL(req.url, "http://localhost");
  const accessToken = url.searchParams.get("access_token");
  if (accessToken && !req.headers.authorization) {
    req.headers.authorization = `Bearer ${accessToken}`;
  }

  try {
    req.user = await authenticateRequest(req);
  } catch (err) {
    const status = (err as { statusCode?: number }).statusCode || 401;
    reply.code(status).send({ error: err instanceof Error ? err.message : "Unauthorized" });
  }
}

export function requireUser(req: FastifyRequest): AuthUser {
  if (!req.user) throw Object.assign(new Error("Authentication required"), { statusCode: 401 });
  return req.user;
}
