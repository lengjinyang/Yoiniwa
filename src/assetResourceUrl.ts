const ASSET_RESOURCE_ORIGIN = 'http://refcanvas-asset.localhost';

export function assetResourceUrl(assetId: string, query: URLSearchParams) {
  const search = query.toString();
  return `${ASSET_RESOURCE_ORIGIN}/asset/${encodeURIComponent(assetId)}${search ? `?${search}` : ''}`;
}

export function isAssetResourceUrl(value: string) {
  return value.startsWith(`${ASSET_RESOURCE_ORIGIN}/`) || value.startsWith('refcanvas-asset:');
}
