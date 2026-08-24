/**
 * Renders a brand placeholder icon as a CSS mask so it recolors with the
 * current text color (theme tokens). The SVGs live in /public/brand/icons.
 */
export type IconName =
  | "cluster"
  | "database"
  | "vm"
  | "application"
  | "load-balancer"
  | "network"
  | "gke";

export function BrandIcon({ name, size = 18 }: { name: IconName; size?: number }) {
  return (
    <span
      className={`design-icon design-icon-${name}`}
      style={{ width: size, height: size }}
      aria-hidden
    />
  );
}
