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
| `download_instance_properties` | Local (stdio) only. Save a **deployed** instance's endpoints, credentials and details as a `.properties` file (`name=value`) at an absolute path on your machine — the same data as the web "Download .properties" button. The file is written with mode `0600` and the tool returns only the path and a count, never the contents, so the cluster admin password stays out of the model's context. Refuses to overwrite unless `overwrite: true`; fails for destroyed or not-yet-provisioned instances. |

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

## Known limitations: local-only tools (TODO)

Two tools read or write a file path, which only makes sense when the MCP server
runs on the same machine as the caller. They are registered by the local stdio
server (`allowLocalFiles: true` in `src/stdio.ts`) and **are not available over
the hosted HTTP transport** (`createServer(client)` in `src/http.ts` omits them),
because a path there would resolve on the server, not on the user's machine.
Every other tool works on both transports.

| Tool | Local (stdio) | Hosted (HTTP) | Workaround on HTTP today |
| --- | --- | --- | --- |
| `upload_artifact` | reads a local jar/binary and stages it | missing | use a hosted artifact (`url`, `gcs`, or `git`), or have a human attach the file in the wizard |
| `download_instance_properties` | writes a `0600` `.properties` file | missing | the web "Download .properties" button, or `GET /instances/:id/properties` with a bearer token |

To address later (options, nothing decided):

- **Upload over HTTP:** a tool that returns a short-lived upload URL (or a ready
  `curl` command) the user runs on their own machine, so file bytes still never go
  through the model. Sending the file as base64 in the tool call would work for
  small files but puts it in the model's context and hits size limits.
- **Download over HTTP:** a tool that returns a short-lived, single-use download
  URL for the `.properties` file instead of the contents, so the admin password is
  never placed in the model's context.
- Both need a new API route (signed, expiring, audited) and a decision on token
  lifetime. Until then, over HTTP the model's instructions (`src/server.ts`) tell
  it to use `url`/`gcs`/`git` for a hosted artifact and to leave a local file for
  the human to attach; there is no equivalent fallback text for
  `download_instance_properties`, so it simply isn't offered.

## Safety summary

- No tool can apply, create, destroy, retry, or recreate — the surface is
  define-only.
- The API independently enforces the `define` scope: `POST /instances`,
  `DELETE /instances/:id`, `/bulk-destroy`, `/retry`, `/recreate`, and
  credential/artifact writes all return `403` for a define token.
- Saving only creates a `draft` record; provisioning happens exclusively through
  a human's Apply in the web app.
- `download_instance_properties` is read-only for the deployment (it calls
  `GET /instances/:id/properties`, which a define token may read) but its output
  contains the cluster admin password. It is therefore only registered on the
  local stdio server, writes straight to a `0600` file, and is audited as
  `instance.properties_download`. User-chosen database passwords are never
  included.
