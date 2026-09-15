/**
 * Thin HTTP client to the redis-ent-wizard API. The MCP server owns no state
 * and no business logic — the API is the single writer and the authority for
 * validation, render, and persistence. Every call carries a bearer token
 * (a define-scoped API token), so the API enforces the "define, don't
 * provision" guarantee server-side even if a tool here were misused.
 */
export interface DesignRecord {
  id: string;
  name: string;
  mode: string;
  status: string;
  reviewUrl?: string;
  [key: string]: unknown;
}

export interface CapabilitiesResponse {
  jsonSchema: unknown;
  capabilities: unknown;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export class RewClient {
  private readonly baseUrl: string;

  constructor(
    baseUrl: string,
    private readonly token: string | undefined,
  ) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { accept: "application/json" };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (this.token) headers.authorization = `Bearer ${this.token}`;

    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (err) {
      throw new ApiError(
        `Cannot reach the wizard API at ${this.baseUrl} (${err instanceof Error ? err.message : String(err)})`,
        0,
        undefined,
      );
    }

    const text = await res.text();
    const parsed = text ? safeJson(text) : undefined;
    if (!res.ok) {
      const detail =
        (parsed && typeof parsed === "object" && "error" in parsed
          ? JSON.stringify((parsed as { error: unknown }).error)
          : text) || res.statusText;
      throw new ApiError(`API ${method} ${path} failed (${res.status}): ${detail}`, res.status, parsed);
    }
    return parsed as T;
  }

  getCapabilities(): Promise<CapabilitiesResponse> {
    return this.request("GET", "/designs/schema");
  }

  listCredentials(): Promise<unknown> {
    return this.request("GET", "/credentials");
  }

  listProjects(credentialsFile: string): Promise<unknown> {
    return this.request("GET", `/gcp/projects?credentialsFile=${encodeURIComponent(credentialsFile)}`);
  }

  listRegions(credentialsFile: string, project: string): Promise<unknown> {
    const qs = new URLSearchParams({ credentialsFile, project });
    return this.request("GET", `/gcp/regions?${qs}`);
  }

  validate(config: unknown): Promise<{ ok: boolean; errors?: unknown }> {
    return this.request("POST", "/designs/validate", config);
  }

  render(config: unknown): Promise<{ mainTf: string; variablesTf: string; tfvars: string }> {
    return this.request("POST", "/designs/render", config);
  }

  saveDesign(config: unknown): Promise<DesignRecord> {
    return this.request("POST", "/designs", config);
  }

  listDesigns(): Promise<DesignRecord[]> {
    return this.request("GET", "/designs");
  }

  getDesign(id: string): Promise<DesignRecord> {
    return this.request("GET", `/designs/${encodeURIComponent(id)}`);
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
