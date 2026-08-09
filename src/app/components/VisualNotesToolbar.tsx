import type { CSSProperties } from 'react';
import type { EraserSize, VisualNoteTool, VisualNoteWidth } from '../../types';
import { UiIcon, type UiIconName } from './UiIcon';

const TOOL_OPTIONS: ReadonlyArray<{ tool: VisualNoteTool; label: string; shortcut: string; icon: UiIconName }> = [
  { tool: 'brush', label: '画笔', shortcut: '1 / B', icon: 'pen' },
  { tool: 'arrow', label: '箭头', shortcut: '2', icon: 'note-arrow' },
  { tool: 'eraser', label: '橡皮擦', shortcut: '3 / E', icon: 'eraser' },
];

const COLOR_OPTIONS = [
  ['#d5d8dc', '白色'], ['#c97c80', '暖红'], ['#c6a15b', '暖黄'],
  ['#78a089', '青绿'], ['#7595b8', '冷蓝'], ['#9383ae', '灰紫'],
] as const;

interface VisualNotesToolbarProps {
  enabled: boolean;
  tool: VisualNoteTool;
  color: string;
  opacity: number;
  width: VisualNoteWidth;
  pressureEnabled: boolean;
  eraserSize: EraserSize;
  selectedMarkId?: string;
  notesVisible: boolean;
  onToolChange(tool: VisualNoteTool): void;
  onColorChange(color: string): void;
  onOpacityChange(opacity: number): void;
  onWidthChange(width: VisualNoteWidth): void;
  onEraserSizeChange(size: EraserSize): void;
  onPressureToggle(): void;
  onOpacityInteractionStart(): void;
  onOpacityInteractionEnd(): void;
  onDeleteSelected(): void;
  onToggleNotesVisible(): void;
  onExit(): void;
}

export function VisualNotesToolbar({
  enabled, tool, color, opacity, width, pressureEnabled, eraserSize, selectedMarkId, notesVisible,
  onToolChange, onColorChange, onOpacityChange, onWidthChange, onEraserSizeChange, onPressureToggle,
  onOpacityInteractionStart, onOpacityInteractionEnd, onDeleteSelected, onToggleNotesVisible, onExit,
}: VisualNotesToolbarProps) {
  if (!enabled) return null;
  return <div className="visual-notes-toolbar no-drag" role="toolbar" aria-label="视觉标注工具">
    <div className="visual-note-tools">
      {TOOL_OPTIONS.map((option) => <button key={option.tool}
        className={`visual-note-tool${tool === option.tool ? ' active' : ''}`}
        data-tooltip={`${option.label}　${option.shortcut}`} aria-label={`${option.label}，快捷键 ${option.shortcut}`}
        onClick={() => onToolChange(option.tool)}><UiIcon name={option.icon} size={17} /></button>)}
    </div>
    <span className="visual-note-divider" />
    <details className="visual-note-fold visual-note-width-fold">
      <summary data-tooltip={tool === 'eraser' ? '橡皮尺寸' : `${width === 'thin' ? '细线' : width === 'medium' ? '中线' : '粗线'}`}
        aria-label={tool === 'eraser' ? '选择橡皮尺寸' : '选择线宽'}>
        <i style={{ width: '16px', height: tool === 'eraser'
          ? `${({ small: 2, medium: 4, large: 6 } as const)[eraserSize]}px`
          : `${({ thin: 1, medium: 2.5, thick: 5 } as const)[width]}px` }} />
        <UiIcon className="visual-note-fold-caret" name="caret-down" size={11} />
      </summary>
      <div className="visual-note-fold-panel visual-note-width-list">
        {tool === 'eraser' ? (['small', 'medium', 'large'] as const).map((size, index) => <button key={size}
          className={eraserSize === size ? 'active' : ''} onClick={(event) => {
            onEraserSizeChange(size); event.currentTarget.closest('details')?.removeAttribute('open');
          }}><i style={{ width: `${[10, 16, 22][index]}px`, height: `${[2, 4, 6][index]}px` }} /><span>{['小', '中', '大'][index]}</span></button>)
          : (['thin', 'medium', 'thick'] as const).map((value, index) => <button key={value}
            className={width === value ? 'active' : ''} onClick={(event) => {
              onWidthChange(value); event.currentTarget.closest('details')?.removeAttribute('open');
            }}><i style={{ height: `${[1, 2.5, 5][index]}px` }} /><span>{['细线', '中线', '粗线'][index]}</span></button>)}
      </div>
    </details>
    {tool !== 'eraser' && <>
      <span className="visual-note-divider" />
      <details className="visual-note-fold visual-note-color-fold">
        <summary data-tooltip="标注颜色" aria-label="选择标注颜色">
          <i className="visual-note-current-color" style={{ '--note-color': color } as CSSProperties} />
          <UiIcon className="visual-note-fold-caret" name="caret-down" size={11} />
        </summary>
        <div className="visual-note-fold-panel visual-note-color-list">
          {COLOR_OPTIONS.map(([optionColor, name]) => <button key={optionColor} className={color === optionColor ? 'active' : ''}
            onClick={(event) => {
              onColorChange(optionColor); event.currentTarget.closest('details')?.removeAttribute('open');
            }}><i style={{ '--note-color': optionColor } as CSSProperties} /><span>{name}</span><UiIcon name="check" size={13} /></button>)}
          <label className="visual-note-color-custom"><UiIcon name="palette" size={16} /><span>更多颜色</span>
            <input type="color" value={color} onChange={(event) => {
              onColorChange(event.target.value); event.currentTarget.closest('details')?.removeAttribute('open');
            }} />
          </label>
        </div>
      </details>
      <span className="visual-note-divider" />
      <details className="visual-note-fold visual-note-opacity-fold">
        <summary data-tooltip={`不透明度　${Math.round(opacity * 100)}%`} aria-label={`不透明度 ${Math.round(opacity * 100)}%`}>
          <UiIcon name="opacity" size={16} />
        </summary>
        <div className="visual-note-fold-panel visual-note-opacity-panel">
          <div className="visual-note-opacity-heading"><span>不透明度</span><output>{Math.round(opacity * 100)}%</output></div>
          <input aria-label="不透明度" type="range" min="20" max="100" step="5" value={Math.round(opacity * 100)}
            style={{ '--opacity-progress': `${(opacity - 0.2) / 0.8 * 100}%` } as CSSProperties}
            onPointerDown={onOpacityInteractionStart}
            onChange={(event) => onOpacityChange(Number(event.target.value) / 100)}
            onPointerUp={onOpacityInteractionEnd}
            onPointerCancel={onOpacityInteractionEnd} />
          <div className="visual-note-opacity-scale"><span>20</span><span>100</span></div>
        </div>
      </details>
    </>}
    <span className="visual-note-divider" />
    <div className="visual-note-auxiliary">
      {tool !== 'eraser' && <button className={pressureEnabled ? 'active compact' : 'compact'} data-tooltip="笔迹平滑" aria-label="笔迹平滑"
        onClick={onPressureToggle}><UiIcon name="smooth" /></button>}
      {selectedMarkId && <button className="compact" data-tooltip="删除选中标注　Delete" aria-label="删除选中标注"
        onClick={onDeleteSelected}><UiIcon name="trash" /></button>}
    </div>
    <span className="visual-note-divider" />
    <button className={notesVisible ? 'compact' : 'compact active'}
      data-tooltip={`${notesVisible ? '隐藏' : '显示'}标注　H（按住临时隐藏）`}
      aria-label={notesVisible ? '隐藏标注' : '显示标注'} onClick={onToggleNotesVisible}>
      <UiIcon name={notesVisible ? 'eye' : 'eye-off'} />
    </button>
    <button className="compact visual-note-exit" data-tooltip="退出标注模式　Esc" aria-label="退出标注模式"
      onClick={onExit}><UiIcon name="close" /></button>
  </div>;
}
