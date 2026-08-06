import type { SVGProps } from 'react';
import { UI_ICON_PATHS } from '../icons/uiIconPaths';

export type UiIconName =
  | 'arrow-down' | 'arrow-up' | 'caret-down' | 'check' | 'chevron-down' | 'chevron-right'
  | 'chevrons-down' | 'chevrons-up' | 'close' | 'eye' | 'eye-off' | 'group'
  | 'lightness' | 'lock' | 'maximize' | 'minimize' | 'opacity' | 'pen' | 'pin'
  | 'plus' | 'reset' | 'saturation' | 'search' | 'trash' | 'unlock'
  | 'note-arrow' | 'note-number' | 'tag' | 'eraser' | 'pressure' | 'renumber' | 'edit' | 'palette' | 'smooth';

export function UiIcon({ name, size = 16, ...props }: SVGProps<SVGSVGElement> & { name: UiIconName; size?: number }) {
  return <svg {...props} className={`ui-icon${props.className ? ` ${props.className}` : ''}`}
    width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor"
    strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {name === 'arrow-down' && <path d="M8 2.5v10.8m-4-4 4 4 4-4" />}
    {name === 'arrow-up' && <path d="M8 13.5V2.7m-4 4 4-4 4 4" />}
    {name === 'caret-down' && <path d="m4.5 6 3.5 3.5L11.5 6" />}
    {name === 'check' && <path d="m3 8.3 3.1 3.1L13 4.6" />}
    {name === 'chevron-down' && <path d={UI_ICON_PATHS.chevronDown} />}
    {name === 'chevron-right' && <path d="m6 4 4 4-4 4" />}
    {name === 'chevrons-down' && <path d="m4 3.5 4 4 4-4M4 8.5l4 4 4-4" />}
    {name === 'chevrons-up' && <path d="m4 7.5 4-4 4 4M4 12.5l4-4 4 4" />}
    {name === 'close' && <path d="m4 4 8 8m0-8-8 8" />}
    {name === 'eye' && <><path d="M1.7 8s2.2-3.5 6.3-3.5S14.3 8 14.3 8s-2.2 3.5-6.3 3.5S1.7 8 1.7 8Z" /><circle cx="8" cy="8" r="1.7" /></>}
    {name === 'eye-off' && <><path d="M5.2 4.9A6.7 6.7 0 0 1 8 4.3c4.1 0 6.3 3.7 6.3 3.7a9 9 0 0 1-1.7 2.1M10.8 11.1a6.7 6.7 0 0 1-2.8.6C3.9 11.7 1.7 8 1.7 8a9 9 0 0 1 1.7-2.1M2.5 2.5l11 11" /><path d="M6.8 6.8A1.7 1.7 0 0 0 9.2 9.2" /></>}
    {name === 'group' && <><rect x="2.2" y="3" width="11.6" height="10" rx="1.5" /><path d="M2.2 6h11.6" /></>}
    {name === 'lightness' && <><circle cx="8" cy="8" r="2.7" /><path d="M8 1.5v1.6M8 12.9v1.6M1.5 8h1.6M12.9 8h1.6M3.4 3.4l1.1 1.1M11.5 11.5l1.1 1.1M12.6 3.4l-1.1 1.1M4.5 11.5l-1.1 1.1" /></>}
    {name === 'lock' && <><rect x="3" y="7" width="10" height="6.5" rx="1.5" /><path d="M5.2 7V5.2a2.8 2.8 0 0 1 5.6 0V7" /></>}
    {name === 'unlock' && <><rect x="3" y="7" width="10" height="6.5" rx="1.5" /><path d="M5.2 7V5.2A2.8 2.8 0 0 1 10.5 4" /></>}
    {name === 'maximize' && <rect x="2.5" y="2.5" width="11" height="11" rx="1.5" />}
    {name === 'minimize' && <path d="M3 8h10" />}
    {name === 'opacity' && <><path d="M8 1.8S3.8 6.4 3.8 9.5a4.2 4.2 0 0 0 8.4 0C12.2 6.4 8 1.8 8 1.8Z" /><path d="M4.2 9h7.6" /></>}
    {name === 'pen' && <><path d="m3 11.8.7-3 6.9-6.9 2.5 2.5-6.9 6.9-3.2.5Z" /><path d="m9.8 2.7 2.5 2.5" /></>}
    {name === 'pin' && <path d="M5 2.8h6l-1.2 3v2.1l1.5 1.3H4.7l1.5-1.3V5.8L5 2.8ZM8 9.2V14" />}
    {name === 'plus' && <path d="M8 2.8v10.4M2.8 8h10.4" />}
    {name === 'reset' && <path d="M3.1 5.5A5.2 5.2 0 1 1 3 10.3M3.1 5.5V2.7M3.1 5.5h2.8" />}
    {name === 'saturation' && <path d="M8 1.7S3.8 6.2 3.8 9.5A4.2 4.2 0 0 0 12.2 9.5C12.2 6.2 8 1.7 8 1.7Z" />}
    {name === 'search' && <><circle cx="7" cy="7" r="4.2" /><path d="m10.2 10.2 3.1 3.1" /></>}
    {name === 'trash' && <><path d="M3.2 4.5h9.6M6 2.5h4M4.4 4.5l.6 9h6l.6-9" /><path d="M7 7v4M9 7v4" /></>}
    {name === 'note-arrow' && <><path d="M2.4 12.5 12.2 2.7" /><path d="M7.9 2.7h4.3V7" /></>}
    {name === 'note-number' && <><circle cx="8" cy="8" r="5.3" /><path d="M7 6.1 8.4 5v6M6.8 11h3.2" /></>}
    {name === 'tag' && <><path d="M2.5 3.2h5.1l5.9 5.9-4.4 4.4-5.9-5.9V3.2Z" /><circle cx="5.6" cy="6.1" r=".8" /></>}
    {name === 'eraser' && <><path d="m2.7 10.1 6.8-6.8a1.5 1.5 0 0 1 2.1 0l1.1 1.1a1.5 1.5 0 0 1 0 2.1l-6.8 6.8H3.8l-1.1-1.1a1.5 1.5 0 0 1 0-2.1Z" /><path d="m7.6 5.2 3.2 3.2M6 13.3h7.2" /></>}
    {name === 'pressure' && <><path d="M2 10.8c1.5 0 1.5-5.6 3-5.6s1.5 6.8 3 6.8 1.5-8 3-8 1.5 6.8 3 6.8" /><path d="M2 13.5h12" /></>}
    {name === 'renumber' && <><path d="M3 4.5h6.8M3 8h5M3 11.5h6.8" /><path d="m11.2 9.8 1.8 1.7-1.8 1.7M13 11.5V6" /></>}
    {name === 'edit' && <><path d="m3 11.9.5-2.5 6.8-6.8 2.1 2.1-6.8 6.8-2.6.4Z" /><path d="M8.9 4 11 6.1" /></>}
    {name === 'palette' && <><path d="M8 2.2a5.8 5.8 0 1 0 0 11.6h1.1c.8 0 1.2-.9.7-1.5-.6-.7-.1-1.8.8-1.8h1.1c1.3 0 2.1-1.2 2.1-2.5A5.8 5.8 0 0 0 8 2.2Z" /><circle cx="5" cy="6" r=".7" /><circle cx="8" cy="4.8" r=".7" /><circle cx="11" cy="6.2" r=".7" /></>}
    {name === 'smooth' && <path d="M2 10.8c1.7 0 1.8-5.6 3.8-5.6 1.8 0 1.9 5.6 3.7 5.6 2 0 2.1-5.6 4.5-5.6" />}
  </svg>;
}
