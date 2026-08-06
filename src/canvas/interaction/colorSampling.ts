import type { PickedColor } from '../../types';

interface RgbaBytes { r: number; g: number; b: number; a: number }

const clampByte = (value: number) => Math.max(0, Math.min(255, Math.round(value)));

export function compositeDisplayedColor(
  rgba: RgbaBytes,
  surface: Pick<RgbaBytes, 'r' | 'g' | 'b'>,
  premultipliedAlpha: boolean,
): PickedColor {
  const alpha = Math.max(0, Math.min(1, rgba.a / 255));
  const composite = (foreground: number, background: number) => premultipliedAlpha
    ? foreground + background * (1 - alpha)
    : foreground * alpha + background * (1 - alpha);
  const r = clampByte(composite(rgba.r, surface.r));
  const g = clampByte(composite(rgba.g, surface.g));
  const b = clampByte(composite(rgba.b, surface.b));
  const hex = `#${[r, g, b].map((value) => value.toString(16).padStart(2, '0')).join('').toUpperCase()}`;
  return { r, g, b, a: 1, hex };
}
