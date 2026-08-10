export function clampGroupToolbarX(x: number, viewportWidth = window.innerWidth) {
  return viewportWidth < 320 ? viewportWidth / 2 : Math.max(150, Math.min(viewportWidth - 150, x));
}
