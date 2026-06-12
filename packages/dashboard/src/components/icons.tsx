// A tiny inline SVG icon set — the five glyphs the chrome needs, stroke-styled
// to read at 16px in either scheme. No icon-library dependency: the dashboard
// ships as prebuilt static assets and stays lean.

interface IconProps {
  size?: number;
}

function base(size: number | undefined) {
  return {
    width: size ?? 16,
    height: size ?? 16,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 2,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
  };
}

export function IconGrid({ size }: IconProps) {
  return (
    <svg {...base(size)}>
      <rect x="3" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="3" width="7" height="7" rx="1.5" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" />
      <rect x="14" y="14" width="7" height="7" rx="1.5" />
    </svg>
  );
}

export function IconGear({ size }: IconProps) {
  return (
    <svg {...base(size)}>
      <circle cx="12" cy="12" r="3.2" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.03 1.56V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1.11-1.56 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.56-1.03H3a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 4.65 8.85a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34h.01A1.7 1.7 0 0 0 10.05 3V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1.03 1.56 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87v.01c.26.63.87 1.04 1.56 1.04H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.51 1.04Z" />
    </svg>
  );
}

export function IconPlug({ size }: IconProps) {
  return (
    <svg {...base(size)}>
      <path d="M9 2v6" />
      <path d="M15 2v6" />
      <path d="M6 8h12v4a6 6 0 0 1-6 6 6 6 0 0 1-6-6V8Z" />
      <path d="M12 18v4" />
    </svg>
  );
}

export function IconPlus({ size }: IconProps) {
  return (
    <svg {...base(size)}>
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </svg>
  );
}

export function IconKey({ size }: IconProps) {
  return (
    <svg {...base(size)}>
      <circle cx="8" cy="15" r="4.5" />
      <path d="M11.5 11.5 20 3" />
      <path d="M16 7l3 3" />
    </svg>
  );
}

export function IconAlert({ size }: IconProps) {
  return (
    <svg {...base(size)}>
      <path d="M12 3 2.5 19.5h19L12 3Z" />
      <path d="M12 10v4" />
      <path d="M12 17.5v.5" />
    </svg>
  );
}
