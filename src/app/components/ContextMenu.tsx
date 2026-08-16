import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { UiIcon } from './app/components/UiIcon';

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
      onInteractionStart?(): void;
      onInteractionEnd?(): void;
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
interface MenuViewport { left: number; top: number; right: number; bottom: number; ready: boolean }

const MENU_MARGIN = 8;

function fallbackViewport(): MenuViewport {
  return { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight, ready: !window.refCanvas };
}

function clampMenuPositionToBounds(position: MenuPosition, size: MenuSize, viewport: Omit<MenuViewport, 'ready'>, margin = MENU_MARGIN): MenuPosition {
  const minX = viewport.left + margin;
  const minY = viewport.top + margin;
  return {
    x: Math.max(minX, Math.min(position.x, Math.max(minX, viewport.right - size.width - margin))),
    y: Math.max(minY, Math.min(position.y, Math.max(minY, viewport.bottom - size.height - margin))),
  };
}

export function clampMenuPosition(position: MenuPosition, size: MenuSize, viewport: MenuSize, margin = 8): MenuPosition {
  return clampMenuPositionToBounds(position, size, { left: 0, top: 0, right: viewport.width, bottom: viewport.height }, margin);
}

function useMenuViewport(anchor?: MenuPosition) {
  const [viewport, setViewport] = useState<MenuViewport>(fallbackViewport);
  // Track the coordinates, not the anchor object: callers rebuild it every
  // render and getWindowWorkArea only reads x/y.
  const anchorX = anchor?.x;
  const anchorY = anchor?.y;

  useLayoutEffect(() => {
    let disposed = false;
    const refresh = () => {
      const fallback = fallbackViewport();
      const api = window.refCanvas;
      if (!api) { setViewport(fallback); return; }
      setViewport({ ...fallback, ready: false });
      const point = anchorX === undefined || anchorY === undefined ? undefined : { x: anchorX, y: anchorY };
      void api.getWindowWorkArea(point).then((workArea) => {
        if (disposed) return;
        const left = Math.max(0, Math.min(window.innerWidth, workArea.left));
        const top = Math.max(0, Math.min(window.innerHeight, workArea.top));
        const right = Math.max(left, Math.min(window.innerWidth, workArea.right));
        const bottom = Math.max(top, Math.min(window.innerHeight, workArea.bottom));
        setViewport({ left, top, right, bottom, ready: right > left && bottom > top });
      }, () => { if (!disposed) setViewport({ ...fallback, ready: true }); });
    };
    refresh();
    window.addEventListener('resize', refresh);
    return () => { disposed = true; window.removeEventListener('resize', refresh); };
  }, [anchorX, anchorY]);

  return viewport;
}

function Submenu({ entries, onClose, viewport }: { entries: ContextMenuEntry[]; onClose(): void; viewport: MenuViewport }) {
  const anchorRef = useRef<HTMLSpanElement>(null);
  const ref = useRef<HTMLUListElement>(null);
  const [style, setStyle] = useState<React.CSSProperties>({ position: 'fixed', left: 0, top: 0, visibility: 'hidden' });
  useLayoutEffect(() => {
    const place = () => {
      const menu = ref.current;
      const parent = anchorRef.current?.parentElement;
      if (!menu || !parent || !viewport.ready) return;
      const parentRect = parent.getBoundingClientRect();
      const width = menu.offsetWidth;
      const height = menu.offsetHeight;
      const fitsRight = parentRect.right + width + MENU_MARGIN <= viewport.right;
      const fitsLeft = parentRect.left - width - MENU_MARGIN >= viewport.left;
      const left = fitsRight || !fitsLeft
        ? parentRect.right
        : parentRect.left - width;
      const clamped = clampMenuPositionToBounds({ x: left, y: parentRect.top - 6 }, { width, height }, viewport);
      setStyle({
        position: 'fixed', left: clamped.x, top: clamped.y,
        maxHeight: `${Math.max(1, viewport.bottom - viewport.top - MENU_MARGIN * 2)}px`,
        visibility: 'visible',
      });
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [viewport]);

  return <><span ref={anchorRef} hidden />{createPortal(
    <MenuList ref={ref} entries={entries} onClose={onClose} className="context-submenu context-menu-portal" style={style} portal viewport={viewport} />,
    document.body,
  )}</>;
}

const MenuList = ({ entries, onClose, className = '', style, ref, portal, viewport }: {
  entries: ContextMenuEntry[];
  onClose(): void;
  className?: string;
  style?: React.CSSProperties;
  ref?: React.Ref<HTMLUListElement>;
  portal?: boolean;
  viewport?: MenuViewport;
}) => {
  const [openIndex, setOpenIndex] = useState<number>();
  return <ul ref={ref} className={`context-menu-list ${className}`} style={style} role="menu"
    data-context-menu-portal={portal ? 'true' : undefined}>
    {entries.map((entry, index) => entry.type === 'separator'
      ? <li className="context-separator" key={`separator-${index}`} />
      : entry.type === 'range'
        ? <li className="context-range" key={`${entry.label}-${index}`} onClick={(event) => event.stopPropagation()}>
            <div><span>{entry.label}</span><output>{Math.round(entry.value)}%</output></div>
            <input type="range" min={entry.min} max={entry.max} step={entry.step ?? 1} value={entry.value}
              onPointerDown={entry.onInteractionStart}
              onPointerUp={entry.onInteractionEnd}
              onPointerCancel={entry.onInteractionEnd}
              onKeyDown={(event) => {
                if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'].includes(event.key)) {
                  entry.onInteractionStart?.();
                }
              }}
              onKeyUp={(event) => {
                if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'].includes(event.key)) {
                  entry.onInteractionEnd?.();
                }
              }}
              onBlur={entry.onInteractionEnd}
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
          <span className="context-check">{entry.checked ? <UiIcon name="check" size={13} /> : null}</span>
          <span className="context-label">{entry.label}</span>
          {entry.shortcut && <span className="context-shortcut">{entry.shortcut}</span>}
          {entry.children && <span className="context-arrow"><UiIcon name="chevron-right" size={14} /></span>}
          {!entry.disabled && entry.children && openIndex === index && <Submenu entries={entry.children} onClose={onClose}
            viewport={viewport ?? { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight, ready: true }} />}
        </li>)}
  </ul>;
};

export function ContextMenu({ position, entries, onClose, variant = 'default' }: {
  position: MenuPosition;
  entries: ContextMenuEntry[];
  onClose(): void;
  variant?: 'default' | 'group';
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [clamped, setClamped] = useState(position);
  const [ready, setReady] = useState(false);
  const viewport = useMenuViewport(position);

  useLayoutEffect(() => {
    const place = () => {
      if (!ref.current || !viewport.ready) return;
      setClamped(clampMenuPositionToBounds(position, {
        width: ref.current.offsetWidth,
        height: ref.current.offsetHeight,
      }, viewport));
      setReady(true);
    };
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [position, viewport]);

  useEffect(() => {
    const closePointer = (event: PointerEvent) => {
      if (ref.current?.contains(event.target as Node)) return;
      if ((event.target as Element | null)?.closest?.('[data-context-menu-portal="true"]')) return;
      onClose();
    };
    const closeWindow = () => onClose();
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    // Canvas menus are opened from native Pixi pointer handlers. Register on
    // the next task so the opening pointerdown cannot close the new menu while
    // it continues bubbling to window.
    const listenerTimer = window.setTimeout(() => {
      document.addEventListener('pointerdown', closePointer, true);
      window.addEventListener('blur', closeWindow);
      window.addEventListener('keydown', key);
    }, 0);
    return () => {
      window.clearTimeout(listenerTimer);
      document.removeEventListener('pointerdown', closePointer, true);
      window.removeEventListener('blur', closeWindow);
      window.removeEventListener('keydown', key);
    };
  }, [onClose]);

  return <div
    ref={ref}
    className={`context-menu-root no-drag${variant === 'group' ? ' group-context-menu' : ''}`}
    style={{
      left: clamped.x,
      top: clamped.y,
      visibility: ready ? 'visible' : 'hidden',
      '--context-menu-max-height': `${Math.max(1, viewport.bottom - viewport.top - MENU_MARGIN * 2)}px`,
    } as React.CSSProperties}
    onPointerDown={(event) => event.stopPropagation()}
    onContextMenu={(event) => event.preventDefault()}
  >
    <MenuList entries={entries} onClose={onClose} viewport={viewport} />
  </div>;
}
