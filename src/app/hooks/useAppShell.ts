import { useEffect, useRef, useState } from 'react';

export function useAppShell() {
  const [propertiesOpen, setPropertiesOpen] = useState(false);
  const [outlineOpen, setOutlineOpen] = useState(false);
  const [sceneNameVisible, setSceneNameVisible] = useState(false);
  const sceneNameVisibleRef = useRef(false);
  const lastPointerRef = useRef({ x: window.innerWidth / 2, y: window.innerHeight / 2 });

  useEffect(() => {
    const rememberPointer = (event: MouseEvent) => {
      lastPointerRef.current = { x: event.clientX, y: event.clientY };
      const visible = event.clientY <= 40;
      if (visible === sceneNameVisibleRef.current) return;
      sceneNameVisibleRef.current = visible;
      setSceneNameVisible(visible);
    };
    const hideSceneName = () => {
      if (!sceneNameVisibleRef.current) return;
      sceneNameVisibleRef.current = false;
      setSceneNameVisible(false);
    };
    window.addEventListener('mousemove', rememberPointer);
    window.addEventListener('mousedown', rememberPointer);
    window.addEventListener('mouseleave', hideSceneName);
    return () => {
      window.removeEventListener('mousemove', rememberPointer);
      window.removeEventListener('mousedown', rememberPointer);
      window.removeEventListener('mouseleave', hideSceneName);
    };
  }, []);

  return {
    panels: { propertiesOpen, setPropertiesOpen, outlineOpen, setOutlineOpen },
    sceneNameVisible,
    lastPointerRef,
  };
}

export function useNativeZoom(api: Window['refCanvas'], zoomBy: (factor: number) => void) {
  useEffect(() => {
    if (!api) return undefined;
    return api.onNativeZoom((direction) => zoomBy(direction === 'in' ? 1.15 : 1 / 1.15));
  }, [api, zoomBy]);
}
