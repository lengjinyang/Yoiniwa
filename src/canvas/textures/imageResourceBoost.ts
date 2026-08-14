/** Native mip/tile generation boost. App wires this from `window.refCanvas`. */
export type ImageResourceBoost = (url: string, priority: number) => void;

export function imageResourceBoostFromApi(api: Window['refCanvas'] | undefined): ImageResourceBoost | undefined {
  return api?.boostImageResource?.bind(api);
}
