import { useCallback, useState } from 'react';
import type { MenuPosition } from '../components/ContextMenu';

export function useContextMenu() {
  const [position, setPosition] = useState<MenuPosition>();
  const open = useCallback((nextPosition: MenuPosition) => setPosition(nextPosition), []);
  const close = useCallback(() => setPosition(undefined), []);
  return { position, open, close };
}
