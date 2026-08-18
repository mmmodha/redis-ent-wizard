/** Official Redis wordmark. Light uses Red; dark uses White. Never recreate the mark. */
export function RedisLogo() {
  return (
    <span className="brand-logos" role="img" aria-label="Redis">
      <img
        className="brand-logo brand-logo-light"
        src="/brand/Redis_Logo_Red_RGB.svg"
        alt=""
        height={32}
        width={102}
      />
      <img
        className="brand-logo brand-logo-dark"
        src="/brand/Redis_Logo_White_RGB.svg"
        alt=""
        height={32}
        width={102}
        aria-hidden
      />
    </span>
  );
}
