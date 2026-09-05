import type { ReactNode } from "react";

export type IconName = "shield" | "upload" | "play" | "clock" | "check" | "close" | "note";

interface IconProps {
  name: IconName;
  size?: number;
}

const paths: Record<IconName, ReactNode> = {
  shield: <><path d="M12 3 20 6v5c0 5-3.4 8.3-8 10-4.6-1.7-8-5-8-10V6l8-3Z" /><path d="m8.5 12 2.2 2.2 4.8-5" /></>,
  upload: <><path d="M12 16V4" /><path d="m7 9 5-5 5 5" /><path d="M5 20h14" /></>,
  play: <path d="m8 5 10 7-10 7V5Z" fill="currentColor" stroke="none" />,
  clock: <><circle cx="12" cy="12" r="8" /><path d="M12 7v5l3 2" /></>,
  check: <path d="m5 12 4 4L19 6" />,
  close: <><path d="m6 6 12 12M18 6 6 18" /></>,
  note: <><path d="M5 4h14v16H5z" /><path d="M8 9h8M8 13h6" /></>,
};

export function Icon({ name, size = 18 }: IconProps) {
  return (
    <svg className="icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {paths[name]}
    </svg>
  );
}
