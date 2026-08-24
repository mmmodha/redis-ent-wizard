# Redis Enterprise Terraform Wizard

Local Docker Compose control plane for creating and tearing down **Redis Enterprise 8.2.0** clusters on GCP — either on **Compute Engine VMs** or on **GKE** (Operator + REC). Built on top of [alexvasseur/redis-terraform-gcp](https://github.com/alexvasseur/redis-terraform-gcp).

## Test this (for colleagues)

End-to-end on a laptop with Docker. Local mode has auth disabled — anyone who can open the UI can apply Terraform with whatever key you drop in.

### You need

1. **Docker Desktop** (or Docker Engine + Compose v2)
2. A **GCP service account JSON** key for the project you will deploy into (paste it in the UI — you do not have to copy it into the repo)
3. An **SSH key** at `~/.ssh/google_compute_engine.pub` (create with `ssh-keygen -t rsa -f ~/.ssh/google_compute_engine` if you do not have one)
4. A **Cloud DNS managed zone** in that project (the wizard lists them; Redis demo default is often `demo-clusters` / `demo.redislabs.com`)

Least-privilege IAM for **VM create** (prefer this over Project Owner):

- `roles/browser`
- `roles/serviceusage.serviceUsageConsumer`
- `roles/compute.viewer`
- `roles/compute.networkAdmin`
- `roles/compute.instanceAdmin.v1`
- `roles/dns.admin`

For **GKE** add `roles/container.clusterAdmin`, and `roles/iam.serviceAccountUser` **on the GKE node service account only** (not project-wide). The **Credentials** page → **Verify** button tells you exactly what is missing.

**Application** artifacts are copied onto the VMs over SSH (VM mode already requires the SSH key pair below), so *uploaded* and `https://` artifacts need **no** extra IAM. Only an artifact referenced by `gs://` needs a read role — `roles/storage.objectViewer` — because the API downloads it before copying it across.

### Run it

```bash
git clone https://github.com/mmmodha/redis-ent-wizard.git
cd redis-ent-wizard
docker compose up --build
```

Open **http://localhost:3000**

You do **not** need to copy the SA JSON onto disk. Go to **Credentials → Add your JSON**, paste the key, **Save**, then **Verify**. The wizard’s credentials dropdown will list it.

Optional alternative: `cp /path/to/your-sa.json data/credentials/sa.json` and skip the paste step (handy if you already keep keys in that folder).

| Port | Service |
| --- | --- |
| 3000 | UI |
| 4000 | API |

No `.env` is required for a local test. `AUTH_DISABLED=true` is the Compose default.

### Smoke test in the UI

1. **Credentials** — paste your SA JSON (or pick a file you dropped in `data/credentials/`). Click **Verify**. VM should be ready before you create a cluster. Fix any failed checks with the `gcloud` snippets shown.
2. **Create** wizard:
   - Credentials: pick the JSON, project, region, **Created by** (`firstName_lastName`, e.g. `mehul_modha`)
   - Target: start with **VM** (smaller blast radius than GKE)
   - Sizing: 3 nodes is HA; optional App VMs (each can be a different machine size), HTTP/HTTPS, Memviz
   - Validate: wait until checks pass, then **Apply with Terraform**
3. Wait for status **ready** (not just Terraform finished — Redis Enterprise still installs for several minutes). Cluster VMs get **Redis Enterprise 8.2.0-46**.
4. Open the UI URL from the instance page (HTTPS). Admin user/password are on that page.
5. **Destroy** from the instance page (or Instances → select → bulk destroy) when you are done. GCP leftover resources cost money.

If you stop Docker without destroying:

```bash
./scripts/list-instances.sh
./scripts/destroy-instance.sh --choose
```

Those scripts use Terraform state under `data/instances/` on your machine.

### Do not

- Commit SA JSON, `.env`, or anything under `data/instances/` / `data/credentials/`
- Leave a cluster running overnight unless you intend to
- Use Arm machine types (c4a / t2a) — images are x86_64 Ubuntu 22.04

Shared/Okta rollout is documented in [docs/ENTERPRISE.md](docs/ENTERPRISE.md).

## What you get

- Tabbed UI: **Instances** (inventory), **Create** (wizard), and **Design** (drag-and-drop canvas), in light or dark theme
- **Design** canvas: drag Redis clusters, databases, VMs, applications, and a load balancer onto a canvas, nest and connect them, then validate and create with the same preflight as the wizard
- **Databases**: add one or more databases (HA or sharded) to a cluster; created via the Redis Enterprise REST API once the cluster is ready, with capacity enforced against the cluster's memory
- **License keys**: set a Redis Enterprise license per cluster; applied via the REST API once the cluster is ready (before databases, since a trial license caps memory and shards). Leave it blank to keep the built-in trial license
- **Applications**: deploy a custom binary/JAR (uploaded or fetched from a URL/`gs://`) on its own VM group with an optional run command, or a container image on GKE
- Folders and owners for grouping — filter, multi-select, move, and bulk-destroy
- Redis-branded wizard with dropdowns populated live from your GCP project
- Preflight validation that blocks invalid configurations before Terraform runs
- Apply and destroy progress with phase tracker, per-section resource groups with a
  live spinner on the task in flight, resource counters, and the raw Terraform log
- Honest readiness: after Terraform finishes, the cluster is probed until Redis Enterprise
  is actually installed and every node has joined — only then is it `ready`
- VM sizing includes optional **Local NVMe** disks per node for Redis on Flash
- Okta-ready auth, per-user “Add your JSON” credentials, quotas, job queue, and audit
  (see [docs/ENTERPRISE.md](docs/ENTERPRISE.md))
- Instance detail with UI URLs, DNS, SSH/kubectl helpers, admin credentials
- Host-persisted registry under `data/` so when Compose is stopped you can still list and destroy instances with shell scripts

## Guard rails

Every create runs a preflight against the GCP APIs (also enforced server-side, so the API refuses a bad request even outside the UI):

| Check | Blocks on |
| --- | --- |
| Instance name | Name already used in the wizard |
| Credentials | Key unreadable, not a service account, or auth rejected |
| GCP project | Project not accessible with that key |
| Required APIs | `compute`/`dns` (VM) or `compute`/`container` (GKE) not enabled |
| Region and zones | Zone letters that do not exist in the chosen region |
| CPU quota | Requested vCPU exceeds the region's available quota |
| Machine type | Type unavailable in any selected zone, or Arm (the images are x86_64) |
| Cluster sizing | GKE nodes fewer than REC pods; warns on non-quorum node counts |
| DNS managed zone | Zone missing, or its domain does not match |
| Resource names | A VPC or GKE cluster with that prefix already exists |
| Local NVMe (VM) | Machine type cannot attach the requested Local SSD count |
| App VMs (VM) | App VM machine type unavailable in the first zone, or Arm |
| App web ports (VM) | Shown for informational purposes — HTTP :80 / HTTPS :443 when toggled |
| Memviz | Enabled with no app VM to run it on |
| Database capacity | Sum of database memory (×2 when replicated) exceeds the cluster's usable memory |
| Database names/ports | Duplicate database name or port within a cluster |
| Application machine type | App VM machine type unavailable in the first zone, or Arm |
| Artifact read IAM | `storage.objects.get` missing for a `gs://` artifact (uploaded / `https` need none) |
| SSH public key | `google_compute_engine.pub` not mounted (VM mode) |
| Redis Enterprise release | Release URL unreachable (warning only) |
| Terraform binary | `terraform` not on PATH |

## Prerequisites

- Docker + Docker Compose
- GCP project with the least-privilege roles listed under **Test this** (not Project Owner)
- Service account JSON key — `data/credentials/` for local Compose, or **Credentials → Add your JSON**
- SSH key pair used by GCP: `~/.ssh/google_compute_engine(.pub)` (mounted into the API container)
- Existing Cloud DNS managed zone (override in the wizard; do not assume `demo-clusters` exists in every project)
- Host tools for offline teardown: `terraform` (>= 1.5), `python3`, and for GKE destroy also `gcloud` / `kubectl` / `helm` if those resources were created

## Quick start

```bash
# 1. Copy your GCP SA key
cp /path/to/sa.json data/credentials/sa.json

# 2. Start the stack
docker compose up --build

# 3. Open the UI
open http://localhost:3000
```

API listens on `http://localhost:4000`.

You do **not** need a `.env` file for credentials — drop JSON keys into `data/credentials/` (local/`AUTH_DISABLED`) or use **Credentials → Add your JSON** when signed in. See `.env.example` and [docs/ENTERPRISE.md](docs/ENTERPRISE.md) for Okta, Postgres, quotas, and TLS.

In the wizard:

1. Credentials — pick a key, then project and region (all dropdowns from live GCP data)
2. Target — **VM** or **GKE**
3. Sizing — node counts, machine types, zones, DNS zone
4. Validate — preflight checks run automatically; Apply stays disabled until they pass

After apply, you land on the instance page: a progress bar with phase steps, resource counter, elapsed time, and an expandable Terraform log. Endpoints and credentials appear as soon as Terraform finishes.

### VM mode

Provisions VPC, firewall, Redis Enterprise **8.2.0-46** nodes (install + cluster create/join), DNS records, optional App VMs (independent machine size each), optional HTTP/HTTPS.

### GKE mode

Provisions VPC + GKE node pool, then installs Redis Enterprise Operator and a REC (`uiServiceType: LoadBalancer`). UI URL and admin secret are written to `data/instances/<id>/k8s-outputs.json` and shown in the dashboard.

## Offline teardown (Compose stopped)

Instance metadata lives in `data/instances.json` and per-instance Terraform state in `data/instances/<id>/`.

Each instance directory is self-contained: the Terraform modules are copied to `data/instances/<id>/tf/` at create time and the credentials path in `terraform.tfvars` is relative. That means the scripts below destroy an instance from the host even after the containers are gone, and an instance keeps the exact module code it was created with.

```bash
# List what was created
./scripts/list-instances.sh

# Interactive choose + destroy one
./scripts/destroy-instance.sh --choose

# Or destroy by id
./scripts/destroy-instance.sh myname-default

# Destroy everything registered
./scripts/destroy-all.sh
```

## Local development (without Docker)

```bash
npm install
# terminal 1
DATA_DIR=./data TERRAFORM_DIR=./terraform npm run dev:api
# terminal 2
NEXT_PUBLIC_API_URL=http://localhost:4000 npm run dev:web
```

Requires `terraform`, `gcloud`, `kubectl`, and `helm` on your PATH for apply/destroy.

## Layout

```
apps/web          Next.js wizard + dashboard
apps/api          Fastify Terraform orchestrator + SSE logs
  src/gcp.ts        GCP REST client (service account JWT auth)
  src/preflight.ts  validation checks
  src/progress.ts   Terraform log -> phase/percent
terraform/        modules + vm/gke profiles (refactored from basis repo)
scripts/          list / destroy helpers for offline cleanup
data/             credentials, instances.json, per-instance state (gitignored)
```

## API endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| GET/POST/DELETE | `/artifacts` | List, upload (multipart `file`), or delete application artifacts |
| POST | `/instances/:id/databases/reconcile` | Re-run database creation on a ready cluster |
| GET | `/credentials` | Service account keys found in `data/credentials/` |
| GET | `/gcp/projects` | Projects visible to a key |
| GET | `/gcp/regions` | Regions and their zones |
| GET | `/gcp/machine-types` | Machine types in a zone |
| GET | `/gcp/dns-zones` | Cloud DNS managed zones |
| POST | `/preflight` | Run validation without creating anything |
| GET/POST | `/instances` | List (optional `folder`/`owner`/`status` filters) or create |
| PATCH | `/instances/:id` | Move instance to a folder (`{ "folder": "…" }` or `null`) |
| POST | `/instances/bulk-destroy` | Start destroy for many ids |
| POST | `/instances/:id/forget` | Drop a destroyed/failed registry record |
| GET | `/folders` · `/owners` | Distinct folders/owners with counts |
| GET | `/instances/:id/progress` | Phase, percent, resource counts |
| POST | `/instances/:id/health` | Probe the cluster now instead of waiting for the next poll |
| GET | `/instances/:id/logs` | SSE stream of log output and progress |
| DELETE | `/instances/:id` | Destroy (keeps the record until you Forget) |

## When is an instance really ready?

`terraform apply` finishing only means the infrastructure exists. On VMs, Redis Enterprise is
installed afterwards by the node startup script, which downloads the package, runs the silent
installer, then `rladmin cluster create` on node 1 and `rladmin cluster join` on the others.
That takes roughly 5-10 minutes, during which the UI URL refuses connections or shows an
incomplete cluster.

So the instance goes `applying` → `bootstrapping` → `ready`:

| Status | Meaning |
| --- | --- |
| `bootstrapping` | Terraform is done; the API polls the cluster every 15s and reports what it sees |
| `ready` | All expected nodes report `active` and the management UI answers |
| `degraded` | Resources exist but the cluster never fully formed within 25 minutes |

The probe reads the Redis Enterprise REST API on node 1 (`:9443/v1/nodes`, using the admin
credentials from the Terraform outputs) and checks the UI port `:8443`. Certificate
verification is disabled for these probes only, because the cluster serves a self-signed cert.
On GKE, Terraform already waits for the REC state, so the probe confirms the load balancer
answers. Endpoints are still shown while bootstrapping — with a warning — so the admin
password is available, and the node counter tells you how far the cluster has got
(for example `2/3 nodes`). Restarting the API resumes any wait that was still in flight.

## Notes

- Instance IDs are `{name}-{env}` (default env `default`).
- **Created by** is mandatory and must be `firstName_lastName` (e.g. `mehul_modha`). That exact value is written to the GCP `owner` label. Emails, spaces, and the local-dev login are rejected.
- **Skip deletion** is optional. When enabled, resources also get the GCP label `skip_deletion=yes` so org cleanup jobs leave them. It is off by default.
- The theme follows your OS by default; the toggle in the header overrides it and is remembered per browser.
- Concurrent applies use isolated working directories under `data/instances/<id>/`.
- A failed instance shows a **Retry apply** button; retrying regenerates the workspace from the saved config, so template fixes are picked up without recreating the instance.
- GKE `terraform destroy` can be flaky on node pools in some GCP projects; the scripts and UI call the same destroy path — if needed, delete the node pool/cluster with `gcloud` after inspecting leftover resources.
- Defaults for DNS (`demo.redislabs.com`) match the public basis repo; change them to your zone before applying.

## License

Terraform scripts retain attribution to the upstream basis project. Application code in this repo is provided for Redis demos/labs.
