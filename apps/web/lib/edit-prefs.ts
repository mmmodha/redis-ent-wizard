"use client";

/**
 * Sticky deployment defaults for the create/edit workspace, remembered in
 * localStorage so a fresh "New instance" starts from the credential / project /
 * region / owner you last used — the same idea as the Wizard⇄Diagram view
 * preference. Only non-secret ids/labels/flags are stored (credentialsFile is a
 * credential id, never key material). Per-deployment identity (name/env/folder)
 * is deliberately NOT remembered.
 */
export type EditPrefs = {
  credentialsFile?: string;
  project?: string;
  region_name?: string;
  region_zones?: string[];
  dns_managed_zone?: string;
  dns_zone_dns_name?: string;
  youremail?: string;
  skip_deletion?: boolean;
  mode?: "vm" | "gke";
};

const KEY = "rew:editPrefs";

export function loadEditPrefs(): EditPrefs | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as EditPrefs) : null;
  } catch {
    return null;
  }
}

export function saveEditPrefs(prefs: EditPrefs): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(KEY, JSON.stringify(prefs));
  } catch {
    /* ignore quota / disabled storage */
  }
}
