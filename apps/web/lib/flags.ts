/**
 * Client feature flags. Read from NEXT_PUBLIC_* env at build/runtime so they can
 * be toggled per deployment without server changes.
 */

/**
 * When enabled, the legacy standalone Create (`/wizard`) and Design (`/design`)
 * routes are surfaced in the nav as a fallback. Off by default: the unified
 * `/edit` "Wizard" tab is the only entry point.
 */
export function legacyCreateFlowsEnabled(): boolean {
  return process.env.NEXT_PUBLIC_ENABLE_LEGACY_CREATE_FLOWS === "true";
}
