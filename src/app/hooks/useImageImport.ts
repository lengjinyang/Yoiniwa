import { useCallback, useEffect, useRef, useState } from 'react';
import { arrangeImportedItems } from '../../domain/importPlacement';
import { preloadImagePreview } from '../../runtime/imageResources';
import { isSupportedMediaFile, isVideoAsset, MEDIA_FILE_PATTERN, toSceneItem } from '../../domain/media';
import { memberBounds, reconcileMemberBounds } from '../../domain/scene';
import type { ImagePrewarmProgress, ImportedImage, Scene, SceneItem } from '../../types';
import { enrichImportedMedia, enrichImportedMediaBatch, mapWithConcurrency } from '../../runtime/videoProbe';
import type { ProjectContext } from './useProjectLifecycle';

export type InternalImageDropHandler = (
  value: string,
  placement: { screenX: number; screenY: number },
) => Promise<boolean>;

interface UseImageImportOptions {
  api: Window['refCanvas'];
  scene: Scene;
  captureProjectContext(): ProjectContext | undefined;
  defaultVideoSoundEnabled: boolean;
  commit(updater: (scene: Scene) => void): void;
  setSelectedIds(ids: string[]): void;
  setSelectedGroupId(id?: string): void;
  setStatus(message: string): void;
  internalDropMime: string;
  internalDropHandlerRef: { current: InternalImageDropHandler };
  lastPointerRef: { current: { x: number; y: number } };
}

export function useImageImport({
  api,
  scene,
  captureProjectContext,
  defaultVideoSoundEnabled,
  commit,
  setSelectedIds,
  setSelectedGroupId,
  setStatus,
  internalDropMime,
  internalDropHandlerRef,
  lastPointerRef,
}: UseImageImportOptions) {
  const [progress, setProgress] = useState<ImagePrewarmProgress>();
  const prepareRef = useRef<(
    sources: ImportedImage[],
    placement?: { screenX: number; screenY: number; pack?: boolean },
    existingRequestId?: string,
    context?: ProjectContext,
  ) => Promise<void>>(async () => undefined);
  const setStatusRef = useRef(setStatus);
  setStatusRef.current = setStatus;
  useEffect(() => {
    if (!api) return undefined;
    return api.onPrewarmProgress((nextProgress) => {
      setProgress((current) => current?.requestId === nextProgress.requestId ? nextProgress : current);
    });
  }, [api]);

  const addImages = useCallback(async (
    sources: ImportedImage[],
    placement?: { screenX: number; screenY: number; pack?: boolean },
    context?: ProjectContext,
  ) => {
    if (!sources.length || !context?.isCurrent()) return;
    const videoCount = sources.filter((source) => isVideoAsset(source.asset)).length;
    const imageCount = sources.length - videoCount;
    setStatus(videoCount && !imageCount
      ? `正在载入 ${videoCount} 个视频…`
      : videoCount
        ? `正在载入 ${sources.length} 个媒体…`
        : `正在载入 ${sources.length} 张图片…`);
    const decodedResults = await mapWithConcurrency(sources, 2, async (source, index): Promise<
      { ok: true; source: ImportedImage; item: SceneItem } | { ok: false; error: string }
    > => {
      try {
        const needsEnrich = isVideoAsset(source.asset)
          ? source.asset.naturalWidth <= 1 || source.asset.naturalHeight <= 1
          : source.asset.naturalWidth < 1 || source.asset.naturalHeight < 1;
        const enriched = needsEnrich && api ? await enrichImportedMedia(source, api) : source;
        if (enriched.asset.naturalWidth < 1 || enriched.asset.naturalHeight < 1) {
          throw new Error('主进程未返回有效的媒体尺寸');
        }
        const dimensions = { width: enriched.asset.naturalWidth, height: enriched.asset.naturalHeight };
        const scale = Math.min(1, 480 / Math.max(dimensions.width, dimensions.height));
        const width = dimensions.width * scale;
        const height = dimensions.height * scale;
        const video = isVideoAsset(enriched.asset);
        const item = toSceneItem({
          id: crypto.randomUUID(),
          name: enriched.name,
          sourcePath: enriched.path,
          sourceType: enriched.sourceType ?? 'drop',
          assetId: enriched.assetId,
          posterAssetId: enriched.poster?.assetId,
          mediaKind: video ? 'video' : 'image',
          durationSec: enriched.asset.durationSec,
          muted: video ? !defaultVideoSoundEnabled : undefined,
          loop: video ? true : undefined,
          naturalWidth: dimensions.width,
          naturalHeight: dimensions.height,
          x: 0,
          y: 0,
          width,
          height,
          rotation: 0,
          flipX: false,
          flipY: false,
          opacity: 1,
          zIndex: index,
          locked: false,
          crop: { x: 0, y: 0, width: dimensions.width, height: dimensions.height },
        });
        return { ok: true, source: enriched, item };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    });
    if (!context.isCurrent()) return;
    const decoded = decodedResults.filter(
      (value): value is { ok: true; source: ImportedImage; item: SceneItem } => value.ok,
    );
    const failures = decodedResults.flatMap((value) => (value.ok ? [] : [value.error]));
    if (!decoded.length) {
      setStatus(failures[0]
        ? `媒体无法导入：${failures[0]}`
        : '媒体无法解码，请检查文件格式或完整性');
      return;
    }
    const screenX = placement?.screenX ?? window.innerWidth * 0.5;
    const screenY = placement?.screenY ?? window.innerHeight * 0.5;
    const placed = arrangeImportedItems(
      decoded.map((value) => value.item),
      scene.viewport,
      screenX,
      screenY,
      Boolean(placement?.pack),
      scene.canvas.padding,
      window.innerWidth / Math.max(1, window.innerHeight),
    );
    commit((nextScene) => {
      const firstZ = nextScene.items.reduce((next, item) => Math.max(next, item.zIndex + 1), 0);
      decoded.forEach(({ item, source }) => {
        nextScene.assets[item.assetId!] = source.asset;
        if (source.poster) nextScene.assets[source.poster.assetId] = source.poster.asset;
      });
      nextScene.items.push(...placed.map((item, index) => ({ ...item, zIndex: firstZ + index })));
      placed.forEach((item) => reconcileMemberBounds(
        nextScene,
        { type: 'image', id: item.id },
        memberBounds(nextScene, { type: 'image', id: item.id })!,
      ));
    });
    setSelectedIds(placed.map((item) => item.id));
    setSelectedGroupId(undefined);
    const addedVideos = placed.filter((item) => item.mediaKind === 'video').length;
    const addedImages = placed.length - addedVideos;
    const label = addedVideos && !addedImages
      ? `已添加 ${addedVideos} 个视频`
      : addedVideos
        ? `已添加 ${addedImages} 张图片、${addedVideos} 个视频`
        : `已添加 ${addedImages} 张图片`;
    setStatus(decoded.length === sources.length
      ? label
      : `${label}，${sources.length - decoded.length} 个无法解码`);
  }, [api, commit, defaultVideoSoundEnabled, scene, setSelectedGroupId, setSelectedIds, setStatus]);

  const prepareAndAddImages = useCallback(async (
    sources: ImportedImage[],
    placement?: { screenX: number; screenY: number; pack?: boolean },
    existingRequestId?: string,
    context = captureProjectContext(),
  ) => {
    if (!sources.length || !context?.isCurrent()) return;
    if (!api) {
      await addImages(sources, placement, context);
      return;
    }
    const requestId = existingRequestId ?? crypto.randomUUID();
    setProgress((current) => current?.requestId === requestId
      ? current : { requestId, completed: 0, total: sources.length });
    const decodePreviewsInBackground = (previewSources: ImportedImage[]) => {
      void Promise.all(previewSources.map((source) => {
        const previewId = isVideoAsset(source.asset) ? undefined : source.assetId;
        return previewId ? preloadImagePreview({ assetId: previewId }) : Promise.resolve(false);
      })).then((previewResults) => {
        if (new URLSearchParams(window.location.search).get('smoke') === '1') {
          document.documentElement.dataset.importPreviewPreloads = String(previewResults.filter(Boolean).length);
        }
      });
    };
    try {
      const enriched = await enrichImportedMediaBatch(sources, api);
      if (!context.isCurrent()) return;
      const warmIds = [...new Set(enriched.flatMap((source) => {
        if (isVideoAsset(source.asset)) return [];
        return [source.assetId];
      }))];
      const result = warmIds.length
        ? await api.prewarmImages(warmIds, requestId)
        : { canceled: false, completed: 0, total: 0, failed: 0 };
      if (!context.isCurrent()) return;
      if (result.canceled) {
        setStatus('已取消导入');
        return;
      }
      decodePreviewsInBackground(enriched);
      if (result.failed) setStatus(`${result.failed} 个预览生成失败，将在显示时重试`);
      await addImages(enriched, placement, context);
    } catch {
      if (!context.isCurrent()) return;
      // A cache failure must not make a supported image impossible to import.
      decodePreviewsInBackground(sources);
      await addImages(sources, placement, context);
    } finally {
      setProgress((current) => current?.requestId === requestId ? undefined : current);
    }
  }, [addImages, api, captureProjectContext, setStatus]);

  prepareRef.current = prepareAndAddImages;

  const importImages = useCallback(async () => {
    if (!api) return;
    const context = captureProjectContext();
    if (!context) return;
    const requestId = crypto.randomUUID();
    setProgress({ requestId, completed: 0, total: 1, stage: 'hash', fraction: 0 });
    try {
      const result = await api.importImages(requestId);
      await prepareAndAddImages(result.images, undefined, requestId, context);
      if (result.failures.length && context.isCurrent()) {
        setStatus(`${result.failures.length} 个文件导入失败：${result.failures.join('；')}`);
      }
    } catch (error) {
      if (context.isCurrent()) setStatus(`导入失败：${String(error)}`);
    } finally {
      setProgress((current) => current?.requestId === requestId ? undefined : current);
    }
  }, [api, captureProjectContext, prepareAndAddImages, setStatus]);

  useEffect(() => {
    const filePath = (file: File) => {
      const direct = api?.pathForFile(file);
      if (direct) return direct;
      // Some WebView builds expose path only on the raw object.
      const raw = file as File & { path?: string; mozFullPath?: string };
      return raw.path || raw.mozFullPath || undefined;
    };

    const over = (event: DragEvent) => {
      event.preventDefault();
      if (event.dataTransfer) {
        event.dataTransfer.dropEffect = event.dataTransfer.types.includes(internalDropMime) ? 'copy' : 'copy';
      }
    };
    const drop = async (event: DragEvent) => {
      event.preventDefault();
      event.stopPropagation();
      const context = captureProjectContext();
      if (!context) return;
      const internalValue = event.dataTransfer?.getData(internalDropMime);
      if (internalValue && await internalDropHandlerRef.current(internalValue, {
        screenX: event.clientX,
        screenY: event.clientY,
      })) return;
      if (!context.isCurrent()) return;
      const files = [...(event.dataTransfer?.files ?? [])].filter(isSupportedMediaFile);
      if (!api) return;
      const requestId = files.length ? crypto.randomUUID() : undefined;
      if (requestId) setProgress({ requestId, completed: 0, total: files.length, stage: 'metadata' });
      try {
        let sources: ImportedImage[] = [];
        if (files.length) {
          const localPaths = files.map((file) => filePath(file)).filter((value): value is string => Boolean(value));
          if (localPaths.length === files.length) {
            sources = await api.registerImagePaths(localPaths, 'drop', requestId);
          } else if (localPaths.length) {
            sources = await api.registerImagePaths(localPaths, 'drop', requestId);
            if (api.registerImageBytes) {
              for (const file of files) {
                if (filePath(file)) continue;
                if (file.size > 120 * 1024 * 1024) {
                  setStatusRef.current(`文件过大且无法取得路径：${file.name}`);
                  continue;
                }
                sources.push(await api.registerImageBytes(file.name, await file.arrayBuffer(), 'drop'));
              }
            }
          } else if (api.registerImageBytes) {
            // Tauri's native drop handler is disabled on Windows so WebView2 can
            // expose File objects here. Import their bytes when no path is exposed.
            for (const file of files) {
              if (file.size > 120 * 1024 * 1024) {
                setStatusRef.current(`文件过大，请用「选择图片/视频」导入：${file.name}`);
                continue;
              }
              sources.push(await api.registerImageBytes(file.name, await file.arrayBuffer(), 'drop'));
            }
          } else {
            return;
          }
        } else {
          const html = event.dataTransfer?.getData('text/html') ?? '';
          const uriList = event.dataTransfer?.getData('text/uri-list') ?? '';
          const plain = event.dataTransfer?.getData('text/plain') ?? '';
          const htmlSource = html.match(/<(?:img|video|source)[^>]+src=["']([^"']+)/i)?.[1];
          const urls = [...new Set([...uriList.split(/\r?\n/), plain, htmlSource]
            .filter((value): value is string => Boolean(value && !value.startsWith('#')))
            .filter((value) => /^https?:\/\//i.test(value.trim())).map((value) => value.trim()))];
          if (urls.length) sources = await api.registerImageUrls(urls);
          else {
            setStatusRef.current('未收到系统文件路径，请再拖一次或用「选择图片/视频」导入');
            return;
          }
        }
        if (!context.isCurrent()) return;
        if (!sources.length) {
          setStatusRef.current('没有识别到可导入的图片或视频');
          return;
        }
        await prepareRef.current(sources, {
          screenX: event.clientX,
          screenY: event.clientY,
          pack: sources.length > 1,
        }, requestId, context);
      } catch (error) {
        if (context.isCurrent()) setStatusRef.current(`拖入媒体失败：${error instanceof Error ? error.message : String(error)}`);
      } finally {
        setProgress((current) => current?.requestId === requestId ? undefined : current);
      }
    };
    const paste = async (event: ClipboardEvent) => {
      const context = captureProjectContext();
      if (!context) return;
      const requestId = crypto.randomUUID();
      const files = [...(event.clipboardData?.files ?? [])].filter(isSupportedMediaFile);
      if (api) try {
        if (files.length) setProgress({ requestId, completed: 0, total: files.length, stage: 'metadata' });
        const localPaths = files.map((file) => filePath(file));
        const sources = files.length && localPaths.every((value): value is string => Boolean(value))
          ? await api.registerImagePaths(localPaths, 'clipboard', requestId)
          : await api.registerClipboardImage();
        if (!context.isCurrent()) return;
        if (!sources.length) {
          setProgress((current) => current?.requestId === requestId ? undefined : current);
          return;
        }
        event.preventDefault();
        await prepareRef.current(sources, {
          screenX: lastPointerRef.current.x,
          screenY: lastPointerRef.current.y,
          pack: sources.length > 1,
        }, requestId, context);
      } catch (error) {
        if (context.isCurrent()) setStatusRef.current(`粘贴媒体失败：${error instanceof Error ? error.message : String(error)}`);
      } finally {
        setProgress((current) => current?.requestId === requestId ? undefined : current);
      }
    };
    window.addEventListener('dragenter', over, true);
    window.addEventListener('dragover', over, true);
    window.addEventListener('drop', drop, true);
    window.addEventListener('paste', paste);
    const disposeNativeDrop = api?.onFilesDropped(({ paths, clientX, clientY }) => {
      const context = captureProjectContext();
      if (!context) return;
      try {
        const mediaPaths = paths.filter((path) => MEDIA_FILE_PATTERN.test(path));
        if (!mediaPaths.length) {
          const rejected = paths.length
            ? `不支持的文件类型（目前支持 png/jpg/webp/gif/mp4/webm/mov）`
            : '没有识别到可导入的图片或视频';
          setStatusRef.current(rejected);
          return;
        }
        setStatusRef.current(mediaPaths.length === 1
          ? `正在导入 ${mediaPaths[0].split(/[/\\]/).pop()}…`
          : `正在导入 ${mediaPaths.length} 个文件…`);
        const requestId = crypto.randomUUID();
        setProgress({ requestId, completed: 0, total: mediaPaths.length, stage: 'metadata' });
        void api.registerImagePaths(mediaPaths, 'drop', requestId).then(async (sources) => {
          if (!context.isCurrent()) return;
          if (!sources.length) {
            setStatusRef.current('媒体注册失败，请确认格式为 png/jpg/webp/mp4/webm/mov');
            return;
          }
          await prepareRef.current(sources, { screenX: clientX, screenY: clientY, pack: sources.length > 1 }, requestId, context);
        }).catch((error) => {
          if (context.isCurrent()) setStatusRef.current(`拖入媒体失败：${error instanceof Error ? error.message : String(error)}`);
        }).finally(() => setProgress((current) => current?.requestId === requestId ? undefined : current));
      } catch (error) {
        setStatusRef.current(`拖入媒体失败：${error instanceof Error ? error.message : String(error)}`);
      }
    });
    return () => {
      window.removeEventListener('dragenter', over, true);
      window.removeEventListener('dragover', over, true);
      window.removeEventListener('drop', drop, true);
      window.removeEventListener('paste', paste);
      disposeNativeDrop?.();
    };
  }, [api, captureProjectContext, internalDropHandlerRef, internalDropMime, lastPointerRef]);

  useEffect(() => {
    if (!api || new URLSearchParams(window.location.search).get('smoke') !== '1') return undefined;
    const addTestPaths = (event: Event) => {
      const context = captureProjectContext();
      if (!context) return;
      const paths = (event as CustomEvent<string[]>).detail;
      void api.registerImagePaths(paths, 'drop').then((sources) => prepareRef.current(sources, {
        screenX: window.innerWidth / 2,
        screenY: window.innerHeight / 2,
        pack: sources.length > 1,
      }, undefined, context)).catch((error) => {
        if (context.isCurrent()) setStatusRef.current(`冒烟媒体载入失败：${String(error)}`);
      });
    };
    window.addEventListener('refcanvas-smoke-add-paths', addTestPaths);
    return () => window.removeEventListener('refcanvas-smoke-add-paths', addTestPaths);
  }, [api, captureProjectContext]);

  return { progress, importImages, prepareAndAddImages };
}
