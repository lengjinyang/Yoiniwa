import { useEffect, useLayoutEffect, useRef, useState } from 'react';

export type ContextMenuEntry =
  | { type: 'separator' }
  | {
      type: 'range';
      label: string;
      value: number;
      min: number;
      max: number;
      step?: number;
      onChange(value: number): void;
    }
  | {
      type: 'item';
      label: string;
      shortcut?: string;
      checked?: boolean;
      disabled?: boolean;
      danger?: boolean;
      action?: () => void;
      children?: ContextMenuEntry[];
    };

export interface MenuPosition { x: number; y: number }
export interface MenuSize { width: number; height: number }

export function clampMenuPosition(position: MenuPosition, size: MenuSize, viewport: MenuSize, margin = 8): MenuPosition {
  return {
    x: Math.max(margin, Math.min(position.x, viewport.width - size.width - margin)),
    y: Math.max(margin, Math.min(position.y, viewport.height - size.height - margin)),
  };
}

function Submenu({ entries, onClose }: { entries: ContextMenuEntry[]; onClose(): void }) {
  const ref = useRef<HTMLUListElement>(null);
  const [style, setStyle] = useState<React.CSSProperties>({ left: '100%', top: -6, visibility: 'hidden' });

  useLayoutEffect(() => {
    const menu = ref.current;
    const parent = menu?.parentElement;
    if (!menu || !parent) return;
    const parentRect = parent.getBoundingClientRect();
    const width = menu.offsetWidth;
    const height = menu.offsetHeight;
    const flipLeft = parentRect.right + width + 8 > window.innerWidth;
    const top = Math.min(-6, window.innerHeight - parentRect.top - height - 8);
    setStyle({
      left: flipLeft ? 'auto' : '100%',
      right: flipLeft ? '100%' : 'auto',
      top: Math.max(8 - parentRect.top, top),
      visibility: 'visible',
    });
  }, []);

  return <MenuList ref={ref} entries={entries} onClose={onClose} className="context-submenu" style={style} />;
}

const MenuList = ({ entries, onClose, className = '', style, ref }: {
  entries: ContextMenuEntry[];
  onClose(): void;
  className?: string;
  style?: React.CSSProperties;
  ref?: React.Ref<HTMLUListElement>;
}) => {
  const [openIndex, setOpenIndex] = useState<number>();
  return <ul ref={ref} className={`context-menu-list ${className}`} style={style} role="menu">
    {entries.map((entry, index) => entry.type === 'separator'
      ? <li className="context-separator" key={`separator-${index}`} />
      : entry.type === 'range'
        ? <li className="context-range" key={`${entry.label}-${index}`} onClick={(event) => event.stopPropagation()}>
            <div><span>{entry.label}</span><output>{Math.round(entry.value)}%</output></div>
            <input type="range" min={entry.min} max={entry.max} step={entry.step ?? 1} value={entry.value}
              onChange={(event) => entry.onChange(Number(event.target.value))} />
          </li>
        : <li
          key={`${entry.label}-${index}`}
          className={`context-menu-item ${entry.disabled ? 'disabled' : ''} ${entry.danger ? 'danger' : ''}`}
          role="menuitem"
          aria-disabled={entry.disabled}
          onMouseEnter={() => setOpenIndex(!entry.disabled && entry.children ? index : undefined)}
          onClick={(event) => {
            event.stopPropagation();
            if (entry.disabled || entry.children) return;
            entry.action?.();
            onClose();
          }}
        >
          <span className="context-check">{entry.checked === undefined ? '' : entry.checked ? '✓' : ''}</span>
          <span className="context-label">{entry.label}</span>
          {entry.shortcut && <span className="context-shortcut">{entry.shortcut}</span>}
          {entry.children && <span className="context-arrow">›</span>}
          {!entry.disabled && entry.children && openIndex === index && <Submenu entries={entry.children} onClose={onClose} />}
        </li>)}
  </ul>;
};

export function ContextMenu({ position, entries, onClose }: {
  position: MenuPosition;
  entries: ContextMenuEntry[];
  onClose(): void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [clamped, setClamped] = useState(position);
  const [ready, setReady] = useState(false);

  useLayoutEffect(() => {
    if (!ref.current) return;
    setClamped(clampMenuPosition(position, {
      width: ref.current.offsetWidth,
      height: ref.current.offsetHeight,
    }, { width: window.innerWidth, height: window.innerHeight }));
    setReady(true);
  }, [position]);

  useEffect(() => {
    const close = () => onClose();
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('pointerdown', close);
    window.addEventListener('blur', close);
    window.addEventListener('keydown', key);
    return () => {
      window.removeEventListener('pointerdown', close);
      window.removeEventListener('blur', close);
      window.removeEventListener('keydown', key);
    };
  }, [onClose]);

  return <div
    ref={ref}
    className="context-menu-root no-drag"
    style={{ left: clamped.x, top: clamped.y, visibility: ready ? 'visible' : 'hidden' }}
    onPointerDown={(event) => event.stopPropagation()}
    onContextMenu={(event) => event.preventDefault()}
  >
    <MenuList entries={entries} onClose={onClose} />
  </div>;
}
