export function resolveApiBase(opts: {
  isBrowser: boolean;
  publicUrl?: string;
  internalUrl?: string;
}): string {
  const publicUrl = (opts.publicUrl ?? "").trim();
  const sameOrigin = publicUrl === "same-origin" || publicUrl === "/";
  if (!opts.isBrowser) {
    return opts.internalUrl || (sameOrigin ? "http://localhost:4000" : publicUrl) || "http://localhost:4000";
  }
  if (sameOrigin) return "";
  return publicUrl || "http://localhost:4000";
}
