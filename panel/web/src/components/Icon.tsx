import type { CSSProperties } from 'react';

const paths = {
  dashboard: 'M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z',
  sites: 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z M3 12h18 M12 3c5 5 5 13 0 18-5-5-5-13 0-18Z',
  servers: 'M4 3h16v7H4z M4 14h16v7H4z M7 6.5h.01 M7 17.5h.01 M11 6.5h6 M11 17.5h6',
  terminal: 'm5 6 6 6-6 6 M13 18h6',
  plugins: 'M8 3v4 M16 3v4 M5 7h14v4a7 7 0 0 1-7 7v4 M12 18a7 7 0 0 1-7-7',
  mail: 'M3 5h18v14H3z m0 0 9 7 9-7',
  jobs: 'M8 5H5v16h14V5h-3 M8 3h8v4H8z M8 12h8 M8 16h5',
  key: 'M14 10a5 5 0 1 1 5 5h-3l-2 2h-3v3H7v-4l7-6Z',
  // Lucide's `puzzle` (lucide-static 1.48, ISC).
  puzzle:
    'M15.39 4.39a1 1 0 0 0 1.68-.474 2.5 2.5 0 1 1 3.014 3.015 1 1 0 0 0-.474 1.68l1.683 1.682a2.414 2.414 0 0 1 0 3.414L19.61 15.39a1 1 0 0 1-1.68-.474 2.5 2.5 0 1 0-3.014 3.015 1 1 0 0 1 .474 1.68l-1.683 1.682a2.414 2.414 0 0 1-3.414 0L8.61 19.61a1 1 0 0 0-1.68.474 2.5 2.5 0 1 1-3.014-3.015 1 1 0 0 0 .474-1.68l-1.683-1.682a2.414 2.414 0 0 1 0-3.414L4.39 8.61a1 1 0 0 1 1.68.474 2.5 2.5 0 1 0 3.014-3.015 1 1 0 0 1-.474-1.68l1.683-1.682a2.414 2.414 0 0 1 3.414 0z',
  users: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2 M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z M22 21v-2a4 4 0 0 0-3-3.87 M16 3.13a4 4 0 0 1 0 7.75',
  // Lucide's `user` and `clock` (ISC).
  user: 'M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2 M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z',
  clock: 'M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0Z M12 6v6l4 2',
  settings: 'M4 7h16 M4 17h16 M8 4v6 M16 14v6',
  sun: 'M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z M12 2v2 M12 20v2 M2 12h2 M20 12h2 M5 5l1.5 1.5 M17.5 17.5l1.5 1.5 M5 19l1.5-1.5 M17.5 6.5l1.5-1.5',
  moon: 'M20.5 13A9 9 0 0 1 11 3.5 9 9 0 1 0 20.5 13Z',
  system: 'M3 4h18v13H3z M8 21h8 M12 17v4',
  plus: 'M12 5v14 M5 12h14',
  arrow: 'M5 12h14 m-5-5 5 5-5 5',
  logout: 'M9 4H4v16h5 M10 12h11 m-4-4 4 4-4 4',
  activity: 'M2 12h5l3-8 4 16 3-8h5',
  memory: 'M4 6h16v12H4z M8 10v4 M12 10v4 M16 10v4 M8 3v3 M16 3v3 M8 18v3 M16 18v3',
  disk: 'M5 4h14l3 12v4H2v-4L5 4Z M2 16h20 M16 18h.01 M19 18h.01',
  menu: 'M4 6h16 M4 12h16 M4 18h16',
  close: 'm6 6 12 12 M6 18 18 6',
  check: 'm5 12 4 4 10-10',
  chevron: 'm6 9 6 6 6-6',
  info: 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z M12 11v5 M12 7.6h.01',
  folder: 'M3 6.5A1.5 1.5 0 0 1 4.5 5H9l2 2h8.5A1.5 1.5 0 0 1 21 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5Z',
  file: 'M6 3h8l4 4v14H6z M14 3v4h4',
  image: 'M4 4h16v16H4z M4 16l5-5 4 4 3-3 4 4 M15 9h.01',
  archive: 'M3 4h18v4H3z M5 8v12h14V8 M10 12h4',
  link: 'M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1 1 M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1-1',
  upload: 'M12 16V4 m-5 5 5-5 5 5 M4 16v4h16v-4',
  download: 'M12 4v12 m-5-5 5 5 5-5 M4 20h16',
  pencil: 'M4 20h4L19 9l-4-4L4 16z M13 7l4 4',
  trash: 'M4 7h16 M9 7V4h6v3 M6 7l1 13h10l1-13',
  search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14Z m9 3-4.35-4.35',
  refresh: 'M20 11a8 8 0 1 0-2.3 5.6 M20 4v7h-7',
  // Lucide's `ellipsis`: three r=1 circles, drawn at its stroke width (STROKE below).
  more: 'M13 12a1 1 0 1 1-2 0 1 1 0 0 1 2 0Z M20 12a1 1 0 1 1-2 0 1 1 0 0 1 2 0Z M6 12a1 1 0 1 1-2 0 1 1 0 0 1 2 0Z',
  lock: 'M6 11h12v10H6z M8 11V7a4 4 0 0 1 8 0v4',
  copy: 'M8 8h12v12H8z M16 8V4H4v12h4',
  up: 'M12 19V5 m-7 7 7-7 7 7',
  support:
    'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z M5.64 5.64l3.53 3.53 M14.83 14.83l3.53 3.53 M14.83 9.17l3.53-3.53 M9.17 14.83l-3.53 3.53',
  chat: 'M3 4h12v9H8l-4 3.5V13H3z M18 8h3v9h-1v3.5L16 17H10v-1',
  gem: 'M6 4h12l4 5-10 12L2 9z M2 9h20 M9.5 4 8 9l4 12 4-12-1.5-5',
  bug: 'M8 12a4 4 0 0 1 8 0v4a4 4 0 0 1-8 0z M9.5 8.5V7a2.5 2.5 0 0 1 5 0v1.5 M12 12v8 M8 14H4 M20 14h-4 M8 11 5 9 M16 11l3-2 M8.2 17.5 5 20 M15.8 17.5 19 20',
  // Lucide's `sparkles`, `layers`, `git-branch` and `shield-check` (lucide-static 1.48, ISC).
  sparkles:
    'M11.017 2.814a1 1 0 0 1 1.966 0l1.051 5.558a2 2 0 0 0 1.594 1.594l5.558 1.051a1 1 0 0 1 0 1.966l-5.558 1.051a2 2 0 0 0-1.594 1.594l-1.051 5.558a1 1 0 0 1-1.966 0l-1.051-5.558a2 2 0 0 0-1.594-1.594l-5.558-1.051a1 1 0 0 1 0-1.966l5.558-1.051a2 2 0 0 0 1.594-1.594z M20 2v4 M22 4h-4 M6 20a2 2 0 1 1-4 0 2 2 0 0 1 4 0Z',
  layers:
    'M12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83z M2 12a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 12 M2 17a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 17',
  branch: 'M15 6a9 9 0 0 0-9 9V3 M21 6a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z M9 18a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z',
  shield:
    'M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z M9 12l2 2 4-4',
} as const;

export type IconName = keyof typeof paths;

/** Icons that are nothing but stroke, where the set's thinner line would shrink them. */
const STROKE: Partial<Record<IconName, number>> = { more: 2 };

export function Icon({ name, size = 18, style }: { name: IconName; size?: number; style?: CSSProperties }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={STROKE[name] ?? 1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={style}
    >
      <path d={paths[name]} />
    </svg>
  );
}
