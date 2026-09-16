import type { PubsubSpec } from "./types.js";

export const MAX_TOPICS = 8;
const MAX_TOPIC_SLUG = 30;

/** Slugify + validate a topic short name. The deployment prefix is added later. */
export function normalizeTopicName(raw: unknown): string {
  const slug = String(raw ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_TOPIC_SLUG)
    .replace(/-+$/g, "");
  if (!slug) throw new Error("Pub/Sub topic name is required");
  if (!/^[a-z]/.test(slug)) throw new Error("Pub/Sub topic names must start with a letter");
  return slug;
}

/** The topic id within the project: `<deploymentPrefix>-<slug>`. */
export function topicFullName(deploymentPrefix: string, name: string): string {
  return `${deploymentPrefix}-${name}`;
}

/** Validate + clamp the Pub/Sub topics for a deployment. Pure (no I/O). */
export function normalizePubsub(input: { pubsub_topics?: PubsubSpec[] }): Required<PubsubSpec>[] {
  const listed = input.pubsub_topics || [];
  if (listed.length > MAX_TOPICS) {
    throw new Error(`A deployment can have at most ${MAX_TOPICS} Pub/Sub topics`);
  }
  const seen = new Set<string>();
  return listed.map((t) => {
    const name = normalizeTopicName(t.name);
    if (seen.has(name)) throw new Error(`Pub/Sub topic names must be unique (${name})`);
    seen.add(name);
    return {
      name,
      create_subscription: Boolean(t.create_subscription),
      role: t.role === "publish" || t.role === "subscribe" ? t.role : "both",
    };
  });
}

export function grantsPublisher(role: "publish" | "subscribe" | "both"): boolean {
  return role === "publish" || role === "both";
}
export function grantsSubscriber(role: "publish" | "subscribe" | "both"): boolean {
  return role === "subscribe" || role === "both";
}
