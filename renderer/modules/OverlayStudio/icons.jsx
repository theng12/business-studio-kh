/**
 * Inline stroke icons for Overlay Studio's show/hide and lock controls
 * (AGENTS.md §1: inline SVG, no icon library; §18: no emoji in UI text).
 * They inherit `currentColor`, so the button's colour states apply.
 */

function Svg({ size = 14, children }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

export function EyeIcon(props) {
  return (
    <Svg {...props}>
      <path d="M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8s-2.4 4.5-6.5 4.5S1.5 8 1.5 8z" />
      <circle cx="8" cy="8" r="2" />
    </Svg>
  );
}

export function EyeOffIcon(props) {
  return (
    <Svg {...props}>
      <path d="M6.6 3.7A6.6 6.6 0 0 1 8 3.5c4.1 0 6.5 4.5 6.5 4.5a11 11 0 0 1-1.6 2.1" />
      <path d="M10.1 10.6A2.5 2.5 0 0 1 8 10.5 2.5 2.5 0 0 1 5.5 8c0-.7.3-1.4.8-1.9" />
      <path d="M4.2 4.7C2.5 5.9 1.5 8 1.5 8s2.4 4.5 6.5 4.5c1.4 0 2.6-.5 3.6-1.2" />
      <path d="M2 2l12 12" />
    </Svg>
  );
}

export function LockIcon(props) {
  return (
    <Svg {...props}>
      <rect x="3" y="7" width="10" height="7" rx="1.5" />
      <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" />
    </Svg>
  );
}

export function UnlockIcon(props) {
  return (
    <Svg {...props}>
      <rect x="3" y="7" width="10" height="7" rx="1.5" />
      <path d="M5.5 7V5a2.5 2.5 0 0 1 4.9-.7" />
    </Svg>
  );
}
