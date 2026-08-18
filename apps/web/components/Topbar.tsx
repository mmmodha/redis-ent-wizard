export function Topbar({
  title,
  subtitle,
  action,
}: {
  title: string;
  subtitle?: string;
  action?: React.ReactNode;
}) {
  return (
    <header className="topbar">
      <div className="brand">
        <div className="brand-mark" aria-hidden>
          R
        </div>
        <div>
          <h1>{title}</h1>
          {subtitle ? <p>{subtitle}</p> : null}
        </div>
      </div>
      {action}
    </header>
  );
}
