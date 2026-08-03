import {
  forwardRef, useEffect, useImperativeHandle, useRef, useState, type CSSProperties,
} from 'react';

const PRESET_COLORS = [
  '#20242b', '#536778', '#2677ff', '#16a4b8', '#2da66f', '#8bad38',
  '#e0a12f', '#dc683f', '#d94f68', '#a061d1', '#8b929c', '#e8edf2',
];

const DEFAULT_GROUP_ALPHA = 0.2;
const DEFAULT_GROUP_COLOR = '#3a4955';

const GROUP_COLORS = [
  ['石墨灰', '#42474d', DEFAULT_GROUP_ALPHA], ['蓝灰', DEFAULT_GROUP_COLOR, DEFAULT_GROUP_ALPHA],
  ['墨绿', '#3b544b', DEFAULT_GROUP_ALPHA], ['暗红', '#553a3e', DEFAULT_GROUP_ALPHA],
  ['褐色', '#564639', DEFAULT_GROUP_ALPHA], ['灰紫', '#46404f', DEFAULT_GROUP_ALPHA],
  ['暖灰', '#4c4843', DEFAULT_GROUP_ALPHA],
] as const;

type ColorToolIconKind = 'lightness' | 'saturation' | 'opacity' | 'reset';

function ColorToolIcon({ kind }: { kind: ColorToolIconKind }) {
  return <svg className="color-tool-icon" viewBox="0 0 16 16" aria-hidden="true">
    {kind === 'lightness' && <>
      <circle cx="8" cy="8" r="2.7" />
      <path d="M8 1.5v1.6M8 12.9v1.6M1.5 8h1.6M12.9 8h1.6M3.4 3.4l1.1 1.1M11.5 11.5l1.1 1.1M12.6 3.4l-1.1 1.1M4.5 11.5l-1.1 1.1" />
    </>}
    {kind === 'saturation' && <path d="M8 1.7S3.8 6.2 3.8 9.5A4.2 4.2 0 0 0 12.2 9.5C12.2 6.2 8 1.7 8 1.7Z" />}
    {kind === 'opacity' && <>
      <circle cx="8" cy="8" r="5.1" />
      <path d="M8 2.9v10.2A5.1 5.1 0 0 0 8 2.9Z" className="filled" />
    </>}
    {kind === 'reset' && <path d="M3.1 5.5A5.2 5.2 0 1 1 3 10.3M3.1 5.5V2.7M3.1 5.5h2.8" />}
  </svg>;
}

function inputHex(value: string) {
  if (/^#[0-9a-f]{6}$/i.test(value)) return value.toLowerCase();
  const context = document.createElement('canvas').getContext('2d');
  if (!context) return '#000000';
  context.fillStyle = '#000000';
  context.fillStyle = value;
  return /^#[0-9a-f]{6}$/i.test(context.fillStyle) ? context.fillStyle : '#000000';
}

function hexToHsl(value: string) {
  const hex = inputHex(value).slice(1);
  const [r, g, b] = [0, 2, 4].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255);
  const max = Math.max(r, g, b); const min = Math.min(r, g, b); const delta = max - min;
  const lightness = (max + min) / 2;
  const saturation = delta === 0 ? 0 : delta / (1 - Math.abs(2 * lightness - 1));
  let hue = 0;
  if (delta) {
    if (max === r) hue = 60 * (((g - b) / delta) % 6);
    else if (max === g) hue = 60 * ((b - r) / delta + 2);
    else hue = 60 * ((r - g) / delta + 4);
  }
  return { h: hue < 0 ? hue + 360 : hue, s: saturation * 100, l: lightness * 100 };
}

function hslToHex(h: number, s: number, l: number) {
  const saturation = s / 100; const lightness = l / 100;
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const section = h / 60; const x = chroma * (1 - Math.abs(section % 2 - 1));
  const [red, green, blue] = section < 1 ? [chroma, x, 0] : section < 2 ? [x, chroma, 0]
    : section < 3 ? [0, chroma, x] : section < 4 ? [0, x, chroma]
      : section < 5 ? [x, 0, chroma] : [chroma, 0, x];
  const match = lightness - chroma / 2;
  return `#${[red, green, blue].map((channel) => Math.round((channel + match) * 255).toString(16).padStart(2, '0')).join('')}`;
}

interface ColorControlProps {
  label?: string;
  value: string;
  onChange(value: string): void;
  onPreviewChange?(value: string): void;
  onPresetChange?(value: string, alpha: number): void;
  alpha?: number;
  onAlphaChange?(value: number): void;
  onInteractionStart?(): void;
  onInteractionEnd?(): void;
  compact?: boolean;
  anchor?: { x: number; y: number };
  onClose?(): void;
  groupPalette?: boolean;
}

export interface ColorControlHandle {
  setAnchor(anchor: { x: number; y: number }): void;
}

function clampedPopupAnchor(anchor: { x: number; y: number }, height = 286, width = 238) {
  return {
    left: Math.max(8, Math.min(anchor.x, window.innerWidth - width - 8)),
    top: Math.max(8, Math.min(anchor.y, window.innerHeight - height)),
  };
}

export const ColorControl = forwardRef<ColorControlHandle, ColorControlProps>(function ColorControl({
  label, value, onChange, onPreviewChange, onPresetChange, alpha, onAlphaChange, onInteractionStart, onInteractionEnd, compact = false, anchor, onClose,
  groupPalette = false,
}, forwardedRef) {
  const nativeValue = inputHex(value);
  const [open, setOpen] = useState(Boolean(anchor));
  const [draft, setDraft] = useState(nativeValue.toUpperCase());
  const [popupAnchor, setPopupAnchor] = useState<{ x: number; y: number }>();
  const rootRef = useRef<HTMLDivElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const liveAnchorRef = useRef(anchor);
  const visible = anchor ? true : open;

  useImperativeHandle(forwardedRef, () => ({
    setAnchor(nextAnchor) {
      liveAnchorRef.current = nextAnchor;
      const popover = popoverRef.current;
      if (!popover) return;
      const next = clampedPopupAnchor(nextAnchor, groupPalette ? 240 : 286, groupPalette ? 232 : 238);
      popover.style.left = `${next.left}px`;
      popover.style.top = `${next.top}px`;
    },
  }), [groupPalette]);

  useEffect(() => setDraft(nativeValue.toUpperCase()), [nativeValue]);
  useEffect(() => {
    if (!visible) return undefined;
    const close = (event: PointerEvent) => {
      if (rootRef.current?.contains(event.target as Node)) return;
      // Canvas interactions decide closure from the selected group. This keeps
      // the editor alive while its own group is dragged, but still closes it
      // when the canvas selects empty space, an image, or another group.
      if (event.target instanceof Element && event.target.closest('.canvas-runtime-root')) return;
      setOpen(false);
      onClose?.();
    };
    const key = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setOpen(false);
      onClose?.();
    };
    // A floating editor can be mounted by the canvas' native pointerdown
    // handler. Defer the outside listener so that opening pointer cannot bubble
    // to window and immediately close the editor again.
    const listenerTimer = window.setTimeout(() => {
      window.addEventListener('pointerdown', close);
      window.addEventListener('keydown', key);
    }, 0);
    return () => {
      window.clearTimeout(listenerTimer);
      window.removeEventListener('pointerdown', close);
      window.removeEventListener('keydown', key);
    };
  }, [onClose, visible]);

  const commitDraft = () => {
    const normalized = draft.startsWith('#') ? draft : `#${draft}`;
    if (/^#[0-9a-f]{6}$/i.test(normalized)) onChange(normalized);
    else setDraft(nativeValue.toUpperCase());
  };
  const effectiveAnchor = anchor ? (liveAnchorRef.current ?? anchor) : popupAnchor;
  const clampedAnchor = effectiveAnchor
    ? clampedPopupAnchor(effectiveAnchor, groupPalette ? 240 : 286, groupPalette ? 232 : 238)
    : undefined;
  const popupStyle: CSSProperties | undefined = clampedAnchor ? {
    position: 'fixed',
    left: clampedAnchor.left,
    top: clampedAnchor.top,
    right: 'auto',
  } : undefined;
  const toggle = () => {
    if (!open) {
      const bounds = rootRef.current?.getBoundingClientRect();
      if (bounds) setPopupAnchor({ x: bounds.right - 238, y: bounds.bottom + 6 });
    }
    setOpen((current) => !current);
  };
  const hsl = hexToHsl(nativeValue);
  const applyPreset = (preset: string, presetAlpha: number) => {
    if (onPresetChange) onPresetChange(preset, presetAlpha);
    else {
      onChange(preset);
      onAlphaChange?.(presetAlpha);
    }
  };

  return <div ref={rootRef} className={`color-control${compact ? ' compact' : ''}${anchor ? ' floating' : ''}`}
    style={{ '--color-control-value': value } as CSSProperties}
    onPointerDown={(event) => event.stopPropagation()}>
    {!anchor && <button type="button" className="color-control-trigger" onClick={toggle}>
      <span className="color-control-checker"><i style={{ backgroundColor: value, opacity: alpha ?? 1 }} /></span>
      {label && <span>{label}</span>}
      {!compact && <code>{nativeValue.toUpperCase()}</code>}
      <b>⌄</b>
    </button>}
    {visible && <div ref={popoverRef} className={`color-control-popover${groupPalette ? ' group-palette' : ''}`} style={popupStyle}>
      <header>
        <div className="color-control-heading">
          <strong>{groupPalette ? '组颜色' : label ?? '颜色'}</strong>
        </div>
        <div className="color-control-header-actions">
          {groupPalette && <button type="button" title="恢复默认" aria-label="恢复默认"
            onClick={() => applyPreset(DEFAULT_GROUP_COLOR, DEFAULT_GROUP_ALPHA)}><ColorToolIcon kind="reset" /></button>}
          <button type="button" aria-label="关闭颜色面板" onClick={() => { setOpen(false); onClose?.(); }}>×</button>
        </div>
      </header>
      <div className="color-control-current">
        <label className="color-control-native" title="自定义颜色">
          <span className="color-control-checker"><i style={{ backgroundColor: value, opacity: alpha ?? 1 }} /></span>
          <input type="color" value={nativeValue} onChange={(event) => onChange(event.target.value)} />
        </label>
        <label className="color-control-hex">HEX
          <input value={draft} maxLength={7} spellCheck={false}
            onChange={(event) => setDraft(event.target.value)} onBlur={commitDraft}
            onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); commitDraft(); } }} />
        </label>
      </div>
      {groupPalette ? <>
        <div className="group-color-presets">{GROUP_COLORS.map(([name, preset, presetAlpha]) => <button type="button" key={name}
          title={name} aria-label={name}
          className={preset === nativeValue && Math.abs((alpha ?? DEFAULT_GROUP_ALPHA) - presetAlpha) < 0.001 ? 'selected' : ''}
          onClick={() => applyPreset(preset, presetAlpha)}>
          <i style={{ backgroundColor: preset }} /><span>{name}</span></button>)}</div>
        <label className="color-control-adjustment"><span><b><ColorToolIcon kind="lightness" />明度</b><output>{Math.round(hsl.l)}%</output></span>
          <input type="range" min="12" max="72" value={Math.round(hsl.l)}
            onPointerDown={() => onInteractionStart?.()} onPointerUp={() => onInteractionEnd?.()}
            onPointerCancel={() => onInteractionEnd?.()} onBlur={() => onInteractionEnd?.()}
            onChange={(event) => (onPreviewChange ?? onChange)(hslToHex(hsl.h, hsl.s, Number(event.target.value)))} /></label>
        <label className="color-control-adjustment"><span><b><ColorToolIcon kind="saturation" />饱和度</b><output>{Math.round(hsl.s)}%</output></span>
          <input type="range" min="0" max="65" value={Math.round(hsl.s)}
            onPointerDown={() => onInteractionStart?.()} onPointerUp={() => onInteractionEnd?.()}
            onPointerCancel={() => onInteractionEnd?.()} onBlur={() => onInteractionEnd?.()}
            onChange={(event) => (onPreviewChange ?? onChange)(hslToHex(hsl.h, Number(event.target.value), hsl.l))} /></label>
      </> : <div className="color-control-presets">{PRESET_COLORS.map((preset) => <button type="button" key={preset}
        className={preset.toLowerCase() === nativeValue ? 'selected' : ''}
        style={{ backgroundColor: preset }} title={preset} onClick={() => onChange(preset)} />)}</div>}
      {alpha !== undefined && onAlphaChange && <label className="color-control-alpha">
        <span><b>{groupPalette && <ColorToolIcon kind="opacity" />}不透明度</b><output>{Math.round(alpha * 100)}%</output></span>
        <input type="range" min="0" max="100" value={Math.round(alpha * 100)}
          style={{ background: `linear-gradient(90deg, transparent, ${value})` }}
          onPointerDown={() => onInteractionStart?.()} onPointerUp={() => onInteractionEnd?.()}
          onPointerCancel={() => onInteractionEnd?.()} onBlur={() => onInteractionEnd?.()}
          onChange={(event) => onAlphaChange(Number(event.target.value) / 100)} />
      </label>}
    </div>}
  </div>;
});
