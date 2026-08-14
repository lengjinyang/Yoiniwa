/** Native Space key query. App wires this from `window.refCanvas`; canvas never reads the desktop API. */
export type SpaceKeyQuery = () => boolean | Promise<boolean>;

export function spaceKeyQueryFromApi(api: Window['refCanvas'] | undefined): SpaceKeyQuery | undefined {
  if (!api?.isKeyDown) return undefined;
  return () => api.isKeyDown('Space').catch(() => false);
}
