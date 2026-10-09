const PATHS = {
  plus: 'M12 5v14M5 12h14',
  edit: 'M4 20h4L19 9l-4-4L4 16v4zM13 7l4 4',
  x: 'M6 6l12 12M18 6L6 18',
  play: 'M7 5l12 7-12 7V5z',
  chevron: 'M9 6l6 6-6 6',
  updown: 'M8 9l4-4 4 4M8 15l4 4 4-4',
  panel: 'M4 5h16v14H4V5zM15 5v14',
  subnode: 'M6 4v9a3 3 0 003 3h9M14 12l4 4-4 4',
  trash: 'M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13',
  search: 'M11 4a7 7 0 100 14 7 7 0 000-14zM16 16l4 4',
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 16 }: { name: IconName; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={PATHS[name]} />
    </svg>
  );
}
