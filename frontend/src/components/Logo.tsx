/** Original Droply brand mark: a droplet containing a bidirectional transfer arrow. */
export function Logo({ size = 30 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 48 48"
      role="img"
      aria-label="Droply logo"
      xmlns="http://www.w3.org/2000/svg"
    >
      <defs>
        <linearGradient id="droply-g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#12a387" />
          <stop offset="1" stopColor="#0b6b5b" />
        </linearGradient>
      </defs>
      <path
        d="M24 3C24 3 9 20.2 9 29.4 9 38 15.5 45 24 45s15-7 15-15.6C39 20.2 24 3 24 3Z"
        fill="url(#droply-g)"
      />
      <path
        d="M24 12.5c3.9 5.6 7.6 11.3 7.6 16.6 0 4.9-3.3 8.4-7.6 8.4s-7.6-3.5-7.6-8.4c0-5.3 3.7-11 7.6-16.6Z"
        fill="#fff"
        opacity="0.22"
      />
      <path
        d="M17.5 27.5 24 34l6.5-6.5M24 33V21"
        stroke="#fff"
        strokeWidth="3.2"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
    </svg>
  );
}
