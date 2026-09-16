/** Runtime configuration, from the environment. */
export interface McpConfig {
  /** Base URL of the redis-ent-wizard API. */
  apiUrl: string;
  /** Define-scoped API token (stdio: the single configured token). */
  apiToken: string | undefined;
  /** HTTP transport listen port. */
  httpPort: number;
  /** HTTP transport listen host. */
  httpHost: string;
}

export function loadConfig(): McpConfig {
  return {
    apiUrl: process.env.REW_API_URL || "http://localhost:4000",
    apiToken: process.env.REW_API_TOKEN || undefined,
    httpPort: Number(process.env.REW_MCP_PORT || 4100),
    httpHost: process.env.REW_MCP_HOST || "0.0.0.0",
  };
}
