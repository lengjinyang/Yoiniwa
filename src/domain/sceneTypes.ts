export type CropRect = { x: number; y: number; width: number; height: number };

export type MediaKind = 'image' | 'video';

/** Video-only optional fields. Serialized on video nodes; omitted from still images. */
export interface VideoClipFields {
  /** Still-frame image asset used for board LOD, outline thumbs, and export. */
  posterAssetId?: string;
  durationSec?: number;
  muted?: boolean;
  loop?: boolean;
}

/** Shared board-node geometry. Scene v3 JSON still uses one item object shape. */
export interface BoardItem {
  id: string;
  name: string;
  sourcePath?: string;
  sourceType: 'file' | 'clipboard' | 'drop' | 'generated';
  assetId?: string;
  /** Only used by small unit-test fixtures. Version 2 scene files never persist data URLs. */
  dataUrl?: string;
  naturalWidth: number;
  naturalHeight: number;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  flipX: boolean;
  flipY: boolean;
  opacity: number;
  zIndex: number;
  locked: boolean;
  hidden?: boolean;
  grayscale?: boolean;
  grayscaleContrast?: number;
  tags?: string[];
  groupId?: string;
  crop: CropRect;
}

export interface ImageItem extends BoardItem {
  /** Defaults to image when omitted (legacy scenes). */
  mediaKind?: 'image';
}

export interface VideoItem extends BoardItem, VideoClipFields {
  mediaKind: 'video';
}

export type SceneItem = ImageItem | VideoItem;

/** Patch applied to a board node. Video-only keys are ignored on still images. */
export type SceneItemPatch = Partial<BoardItem> & Partial<VideoClipFields> & {
  id: string;
};

/** Still-display lookup for outline, export, and UI thumbs. */
export type DisplayableMedia = {
  assetId?: string;
  dataUrl?: string;
  mediaKind?: MediaKind;
  posterAssetId?: string;
  width?: number;
  height?: number;
};

export interface AssetRecord {
  id: string;
  /** Canonical identity. `id` remains serialized for version-2 scene compatibility. */
  assetId?: string;
  hash: string;
  mimeType: string;
  byteLength: number;
  sourceSize?: number;
  sourceMtimeMs?: number;
  naturalWidth: number;
  naturalHeight: number;
  orientation?: number;
  hasAlpha?: boolean;
  contentHash?: string;
  cacheVersion?: number;
  originalName: string;
  sourcePath?: string;
  /** Defaults to image when omitted (legacy scenes). */
  kind?: MediaKind;
  durationSec?: number;
}

type GroupMemberType = 'image' | 'group' | 'mark';

export interface GroupMember {
  type: GroupMemberType;
  id: string;
}

export interface ImageGroup {
  /** Version 2 stores the content-frame bounds; the expanded header lives outside them. */
  headerLayoutVersion?: 2;
  id: string;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  color: string;
  opacity: number;
  titleColor: string;
  titleOpacity?: number;
  collapsed: boolean;
  sizeLocked: boolean;
  contentsHidden: boolean;
  /** Default layout mode keeps the content frame fitted to its members. */
  autoFit?: boolean;
  /** Images explicitly detached while still inside this frame. */
  detachedImageIds?: string[];
  /** Legacy fields read by the scene migrator. */
  locked?: boolean;
  hidden?: boolean;
  parentId?: string;
  tags?: string[];
  members: GroupMember[];
}

export interface Viewport { x: number; y: number; scale: number }

export type VisualNoteTool = 'brush' | 'arrow' | 'eraser';
export type VisualNoteWidth = 'thin' | 'medium' | 'thick';
export type EraserSize = 'small' | 'medium' | 'large';

interface VisualNoteStyle {
  color: string;
  opacity: number;
  width: VisualNoteWidth;
  baseWidth: number;
}

export interface VisualNotePoint { x: number; y: number; widthFactor: number }

export type VisualNoteAnchor =
  | { type: 'scene' }
  | { type: 'image'; imageId: string };

interface VisualNoteBase {
  id: string;
  anchor: VisualNoteAnchor;
  createdAt: number;
  style: VisualNoteStyle;
}

export interface BrushVisualMark extends VisualNoteBase {
  kind: 'stroke';
  points: VisualNotePoint[];
}

export interface ArrowVisualMark extends VisualNoteBase {
  kind: 'arrow';
  start: VisualNotePoint;
  end: VisualNotePoint;
}

interface NumberVisualMark extends VisualNoteBase {
  kind: 'number';
  point: VisualNotePoint;
  number: number;
}

export type VisualMark = BrushVisualMark | ArrowVisualMark | NumberVisualMark;

export interface VisualNotesState {
  visible: boolean;
  nextNumber: number;
  marks: VisualMark[];
}

interface CanvasSettings {
  background: string;
  backgroundOpacity?: number;
  padding: number;
  snap: boolean;
  includeBackgroundOnExport: boolean;
}

export interface Scene {
  format: 'refcanvas';
  version: 4;
  name: string;
  savedAt: string;
  viewport: Viewport;
  canvas: CanvasSettings;
  assets: Record<string, AssetRecord>;
  items: SceneItem[];
  groups: ImageGroup[];
  visualNotes: VisualNotesState;
}
