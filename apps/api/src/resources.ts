import type { FastifyInstance } from "fastify";
import { requireUser } from "./auth.js";
import { canViewInstance } from "./authz.js";
import { readRegistry } from "./registry.js";
import { resolveOwnedCredentialsPath } from "./credentials-store.js";
import { GcpApiError, readKey } from "./gcp.js";
import { enumerateResources } from "./gcp-inventory.js";
import {
  attributeResources,
  summarize,
  type InstanceMeta,
  type ResourceGroupSummary,
  type ScanTotals,
} from "./resource-attribution.js";

interface ScanResponse {
  scannedAt: string;
  project: string;
  currency: string;
  /** Where cost-so-far comes from: rate×uptime estimate, or real billing. */
  billingSource: "estimate" | "billing-export";
  /** True when this response was served from the in-memory cache. */
  cached: boolean;
  groups: ResourceGroupSummary[];
  totals: ScanTotals;
  permissions: { missing: string[] };
  warnings: string[];
}

// On-demand + cache: keep the last scan per (credential, project); serve it
// until the caller passes ?refresh=1 or it ages past the soft TTL.
const CACHE_TTL_MS = 10 * 60_000;
const cache = new Map<string, { at: number; payload: ScanResponse }>();

function gcpError(err: unknown): { status: number; body: { error: string } } {
  if (err instanceof GcpApiError) {
    return { status: err.status >= 400 && err.status < 600 ? err.status : 502, body: { error: err.message } };
  }
  const statusCode = (err as { statusCode?: number }).statusCode;
  return { status: statusCode || 400, body: { error: err instanceof Error ? err.message : String(err) } };
}

export function registerResourceRoutes(app: FastifyInstance) {
  app.get<{ Querystring: { credentialsFile?: string; project?: string; refresh?: string } }>(
    "/gcp/resources",
    async (req, reply) => {
      const user = requireUser(req);
      const { credentialsFile, refresh } = req.query;
      if (!credentialsFile) {
        return reply.code(400).send({ error: "credentialsFile is required" });
      }

      try {
        const { absPath, credentialsId } = await resolveOwnedCredentialsPath(user, credentialsFile);
        // Default the project to the credential's own project.
        const project = req.query.project?.trim() || readKey(absPath).project_id;
        if (!project) {
          return reply.code(400).send({ error: "project is required (key has no project_id)" });
        }

        const cacheKey = `${credentialsId || credentialsFile}::${project}`;
        if (refresh !== "1") {
          const hit = cache.get(cacheKey);
          if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
            return reply.send({ ...hit.payload, cached: true });
          }
        }

        const inventory = await enumerateResources(absPath, project);

        // Instance metadata for labeling groups (only the caller's viewable ones
        // reveal name/status; the scan itself is over the caller's own project).
        const metaById = new Map<string, InstanceMeta>();
        for (const inst of await readRegistry()) {
          metaById.set(inst.id, {
            id: inst.id,
            name: inst.name,
            status: inst.status,
            mode: inst.mode,
            canView: canViewInstance(user, inst),
          });
        }

        const attribution = attributeResources(inventory.resources, [...metaById.keys()]);
        const { groups, totals } = summarize(attribution, metaById);

        const payload: ScanResponse = {
          scannedAt: new Date().toISOString(),
          project,
          currency: "USD",
          billingSource: "estimate",
          cached: false,
          groups,
          totals,
          permissions: { missing: inventory.missingPermissions },
          warnings: inventory.warnings,
        };
        cache.set(cacheKey, { at: Date.now(), payload });
        return reply.send(payload);
      } catch (err) {
        const { status, body } = gcpError(err);
        return reply.code(status).send(body);
      }
    },
  );
}
