# redis-ent-wizard MCP server

An [MCP](https://modelcontextprotocol.io) server that lets Claude and other AI
tools **define** Redis Enterprise infrastructure through the wizard — validate a
config, preview its Terraform, and save it as a **draft** for a human to review
and apply. It **cannot** provision or destroy anything:

- **By construction** — it exposes only `list_capabilities`, `validate_design`,
  `render_design`, `save_design`, `list_designs`, `get_design`. There is no
  apply/create/destroy/retry/recreate tool.
- **By scope** — it authenticates to the API with a `define`-scoped token, and
  the API refuses every provisioning route for that scope (403), so even a bug
  here can't provision.

An AI defines a design and gets a `reviewUrl`; a person opens it in the wizard
(`/edit?from=<id>`), reviews it, and applies it. The AI defines; only the human
applies.

## Tools

| Tool | What it does |
| --- | --- |
| `list_capabilities` | The create-config JSON Schema + a guide to components, modes (vm/gke), and wiring rules. Call this first. |
| `validate_design` | Schema-validate a config offline (no cloud). Returns `{ ok }` or errors. |
| `render_design` | Return the Terraform (`main.tf`, `variables.tf`, `terraform.tfvars`) a config would generate — no apply. |
| `save_design` | Persist a config as a draft; returns the record and a `reviewUrl`. |
| `list_designs` / `get_design` | List/fetch draft designs visible to the token. |

## Prerequisites

1. The wizard **API** running and reachable (default `http://localhost:4000`).
2. A **define-scoped API token**, configured on the API via `REW_API_TOKENS` —
   a JSON array mapping a token to a principal:

   ```jsonc
   // API environment
   REW_API_TOKENS=[
     {
       "token": "rew_define_CHANGE_ME_min16chars",
       "sub": "claude-mcp",
       "email": "ai-tools@your-org.com",
       "name": "Claude (MCP)",
       "scope": "define"      // default; the only scope you should grant here
     }
   ]
   ```

   `scope` defaults to `define` (least privilege) and the token must be at least
   16 characters. Use a distinct token per caller so actions attribute to a real
   principal in the audit log.

## Configuration (environment)

| Variable | Default | Purpose |
| --- | --- | --- |
| `REW_API_URL` | `http://localhost:4000` | Base URL of the wizard API. |
| `REW_API_TOKEN` | — | The define token (stdio only; HTTP takes it per-request). |
| `REW_MCP_PORT` | `4100` | HTTP transport listen port. |
| `REW_MCP_HOST` | `0.0.0.0` | HTTP transport listen host. |

## Local use (stdio) — Claude Desktop / Claude Code / Cursor

Build once, then point your client at the built entrypoint.

```bash
npm install
npm run build -w @redis-ent-wizard/mcp
```

**Claude Desktop** — `claude_desktop_config.json`:

```jsonc
{
  "mcpServers": {
    "redis-ent-wizard": {
      "command": "node",
      "args": ["/absolute/path/to/redis-ent-wizard/apps/mcp/dist/stdio.js"],
      "env": {
        "REW_API_URL": "http://localhost:4000",
        "REW_API_TOKEN": "rew_define_CHANGE_ME_min16chars"
      }
    }
  }
}
```

**Claude Code** — add it with the CLI:

```bash
claude mcp add redis-ent-wizard \
  --env REW_API_URL=http://localhost:4000 \
  --env REW_API_TOKEN=rew_define_CHANGE_ME_min16chars \
  -- node /absolute/path/to/redis-ent-wizard/apps/mcp/dist/stdio.js
```

During development you can skip the build and run the TypeScript directly with
`tsx` — set `command` to `npx` and `args` to
`["tsx", "/absolute/path/.../apps/mcp/src/stdio.js"]`.

> The server logs to **stderr**; stdout is the JSON-RPC channel. Never print to
> stdout from a stdio MCP server.

## Hosted use (Streamable HTTP + SSE)

Run one shared server that many callers reach over HTTP:

```bash
REW_API_URL=https://wizard-api.your-org.com \
REW_MCP_PORT=4100 \
npm run start:http -w @redis-ent-wizard/mcp
```

- Endpoint: `POST http://<host>:<port>/mcp` (health check: `GET /health`).
- **Auth is per-caller and forwarded.** Each request must send
  `Authorization: Bearer <define-token>`; the server forwards that token to the
  API, so actions attribute to a real, least-privilege principal. Requests with
  no bearer are rejected `401`. Do **not** run a hosted endpoint with a single
  shared admin token — issue a distinct define token per caller.
- The transport is **stateless** (one server per request), so it scales
  horizontally behind a load balancer with no shared session state.

A client points at it with the Streamable HTTP transport, e.g.:

```jsonc
{
  "mcpServers": {
    "redis-ent-wizard": {
      "url": "https://wizard-mcp.your-org.com/mcp",
      "headers": { "Authorization": "Bearer rew_define_CHANGE_ME_min16chars" }
    }
  }
}
```

## Safety summary

- No tool can apply, create, destroy, retry, or recreate — the surface is
  define-only.
- The API independently enforces the `define` scope: `POST /instances`,
  `DELETE /instances/:id`, `/bulk-destroy`, `/retry`, `/recreate`, and
  credential/artifact writes all return `403` for a define token.
- Saving only creates a `draft` record; provisioning happens exclusively through
  a human's Apply in the web app.
