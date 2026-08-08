import type { PhotoshopProjectMetadata, PhotoshopVersionRecord, Scene } from '../../src/types.js';
import { createScenePackages, type ScenePackageServices } from './scene-packages.js';

export interface LegacyZipProjectReaderDependencies {
  readScenePackage(filePath: string, options?: { registerAssets?: boolean }): Promise<{
    scene: Scene;
    metadata: PhotoshopProjectMetadata;
  }>;
  readSceneAssetIds(filePath: string): Promise<string[]>;
  extractPhotoshopVersion(filePath: string, version: PhotoshopVersionRecord, targetPath: string): Promise<string>;
}

/**
 * The ZIP implementation is intentionally isolated here. New projects never
 * write ZIP files; this adapter exists only to open and migrate old packages.
 */
export class LegacyZipProjectReader {
  constructor(private readonly dependencies: LegacyZipProjectReaderDependencies) {}

  async open(filePath: string, options?: { registerAssets?: boolean }) {
    return this.dependencies.readScenePackage(filePath, options);
  }

  async assetIds(filePath: string) {
    return this.dependencies.readSceneAssetIds(filePath);
  }

  async extractVersion(filePath: string, version: PhotoshopVersionRecord, targetPath: string) {
    return this.dependencies.extractPhotoshopVersion(filePath, version, targetPath);
  }
}

export function createLegacyZipProjectReader(services: ScenePackageServices) {
  const packages = createScenePackages(services);
  return {
    reader: new LegacyZipProjectReader({
      readScenePackage: packages.readScenePackage,
      readSceneAssetIds: packages.readSceneAssetIds,
      extractPhotoshopVersion: packages.extractPhotoshopVersion,
    }),
    packages,
  };
}
