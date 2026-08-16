import type { EraserSize, VisualNoteTool, VisualNoteWidth } from '../types';

export type LassoPoint = { x: number; y: number };

export type GroupResizeHandle =
  | 'north-west' | 'north' | 'north-east'
  | 'west' | 'east'
  | 'south-west' | 'south' | 'south-east'
  | 'rotate';

export interface GroupFrameBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface VisualNotesToolState {
  enabled: boolean;
  tool: VisualNoteTool;
  color: string;
  opacity: number;
  width: VisualNoteWidth;
  pressureEnabled: boolean;
  eraserSize: EraserSize;
  selectedMarkId?: string;
}
