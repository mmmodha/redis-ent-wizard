# Enterprise pilot rollout

This stack can run as a shared internal platform for ~80–90 SA/SE staff.

## Modes

| Mode | How |
| --- | --- |
| Local demo | `AUTH_DISABLED=true` (default). Shared `data/credentials/` JSON still works. |
| Pilot (recommended) | Okta OIDC + per-user **Add your JSON** credentials. File registry or Postgres. |
| Hardened | Same + `DATABASE_URL` Postgres + TLS via Caddy profile. |

## Okta setup

1. Create an Okta SPA application (Authorization Code + PKCE).
2. Sign-in redirect URI: `https://<host>/login/callback` (and `http://localhost:3000/login/callback` for local).
3. Set env on the API:

```bash
AUTH_DISABLED=false
OKTA_ISSUER=https://your-org.okta.com/oauth2/default
OKTA_CLIENT_ID=0oa...
OKTA_AUDIENCE=0oa...          # usually the SPA client id
OKTA_ADMIN_GROUPS=rew-admins,rew-ops
CREDENTIALS_ENCRYPTION_KEY=<long-random-secret>
```

4. Assign users; put platform admins in `rew-admins` (or whatever you configure).
5. Rebuild: `docker compose up --build`.

## Per-user credentials

- Open **Credentials** in the UI → paste SA JSON → Save.
- Keys are encrypted at rest and listed only for the owning Okta user.
- With `AUTH_DISABLED=true`, keys in `data/credentials/` remain available as a shared pool.

Each user’s SA still needs GCP IAM (Compute / DNS / GKE as appropriate). Preflight surfaces permission hints (e.g. missing `container.clusters.get`).

## Postgres

```bash
export DATABASE_URL=postgres://rew:rew@db:5432/rew
docker compose --profile enterprise up --build
```

Legacy `data/instances.json` is migrated into Postgres when the table is empty.

## TLS

```bash
mkdir -p certs   # cert.pem + key.pem
docker compose --profile tls up
```

## Quotas & concurrency

| Env | Default | Meaning |
| --- | --- | --- |
| `JOB_GLOBAL_LIMIT` | 10 | Max concurrent Terraform apply/destroy |
| `JOB_PER_USER_LIMIT` | 2 | Max concurrent jobs per user |
| `QUOTA_MAX_LIVE_CLUSTERS` | 5 | Live clusters per user |
| `QUOTA_MAX_NODES` | 7 | Max nodes per create |
| `QUOTA_MAX_NVME` | 8 | Max Local SSD NVMe disks per node |

## Audit

Admins: `GET /admin/audit` and `GET /admin/jobs`.

## Later (not required for pilot)

- SA impersonation / Workload Identity Federation instead of JSON upload
- Horizontal Terraform workers on GKE / Cloud Run Jobs
- Remote Terraform state in GCS
