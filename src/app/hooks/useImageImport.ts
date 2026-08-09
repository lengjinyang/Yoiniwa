import { useCallback, useEffect, useState } from 'react';
import { arrangeImportedItems } from '../../importPlacement';
import { preloadImagePreview } from '../../imageResources';
import { memberBounds, reconcileMemberBounds } from '../../scene';
import type { ImageItem, ImagePrewarmProgress, ImportedImage, Scene } from '../../types';

export type InternalImageDropHandler = (
  value: string,
  placement: { screenX: number; screenY: number },
) => Promise<boolean>;

interface UseImageImportOptions {
  api: Window['refCanvas'];
  scene: Scene;
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
  commit,
  setSelectedIds,
  setSelectedGroupId,
  setStatus,
  internalDropMime,
  internalDropHandlerRef,
  lastPointerRef,
}: UseImageImportOptions) {
  const [progress, setProgress] = useState<ImagePrewarmProgress>();

  useEffect(() => {
    if (!api) return undefined;
    return api.onPrewarmProgress((nextProgress) => {
      setProgress((current) => current?.requestId === nextProgress.requestId ? nextProgress : current);
    });
  }, [api]);

  const addImages = useCallback(async (
    sources: ImportedImage[],
    placement?: { screenX: number; screenY: number; pack?: boolean },
  ) => {
    if (!sources.length) return;
    setStatus(`正在载入 ${sources.length} 张图片…`);
    const decodedResults = await Promise.all(sources.map(async (source, index) => {
      try {
        // Registration in the main process already validates and records dimensions.
        // Re-decoding every original in Chromium makes large batch imports hitch badly.
        if (source.asset.naturalWidth < 1 || source.asset.naturalHeight < 1) {
          throw new Error('主进程未返回有效的图片尺寸');
        }
        const dimensions = { width: source.asset.naturalWidth, height: source.asset.naturalHeight };
        const scale = Math.min(1, 480 / Math.max(dimensions.width, dimensions.height));
        const width = dimensions.width * scale;
        const height = dimensions.height * scale;
        return { source, item: {
          id: crypto.randomUUID(),
          name: source.name,
          sourcePath: source.path,
          sourceType: source.sourceType ?? 'drop',
          assetId: source.assetId,
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
          zIndex: scene.items.length + index,
          locked: false,
          crop: { x: 0, y: 0, width: dimensions.width, height: dimensions.height },
        } satisfies ImageItem };
      } catch {
        return undefined;
      }
    }));
    const decoded = decodedResults.filter((value): value is NonNullable<typeof value> => Boolean(value));
    if (!decoded.length) {
      setStatus('图片无法解码，请检查文件格式或完整性');
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
      decoded.forEach(({ item, source }) => { nextScene.assets[item.assetId!] = source.asset; });
      nextScene.items.push(...placed);
      placed.forEach((item) => reconcileMemberBounds(
        nextScene,
        { type: 'image', id: item.id },
        memberBounds(nextScene, { type: 'image', id: item.id })!,
      ));
    });
    setSelectedIds(placed.map((item) => item.id));
    setSelectedGroupId(undefined);
    setStatus(decoded.length === sources.length
      ? `已添加 ${decoded.length} 张图片`
      : `已添加 ${decoded.length} 张图片，${sources.length - decoded.length} 张无法解码`);
  }, [commit, scene, setSelectedGroupId, setSelectedIds, setStatus]);

  const prepareAndAddImages = useCallback(async (
    sources: ImportedImage[],
    placement?: { screenX: number; screenY: number; pack?: boolean },
    existingRequestId?: string,
  ) => {
    if (!sources.length) return;
    if (!api) {
      await addImages(sources, placement);
      return;
    }
    const requestId = existingRequestId ?? crypto.randomUUID();
    setProgress((current) => current?.requestId === requestId
      ? current : { requestId, completed: 0, total: sources.length });
    const decodePreviewsInBackground = () => {
      void Promise.all(sources.map((source) => preloadImagePreview({ assetId: source.assetId }))).then((previewResults) => {
        if (new URLSearchParams(window.location.search).get('smoke') === '1') {
          document.documentElement.dataset.importPreviewPreloads = String(previewResults.filter(Boolean).length);
        }
      });
    };
    try {
      const result = await api.prewarmImages(sources.map((source) => source.assetId), requestId);
      if (result.canceled) {
        setStatus('已取消导入');
        return;
      }
      // React-side thumbnails warm opportunistically; the Pixi canvas owns its
      // own bounded decode/upload pipeline and must not wait on duplicate work.
      decodePreviewsInBackground();
      if (result.failed) setStatus(`${result.failed} 张图片预览生成失败，将在显示时重试`);
      await addImages(sources, placement);
    } catch {
      // A cache failure must not make a supported image impossible to import.
      decodePreviewsInBackground();
      await addImages(sources, placement);
    } finally {
      setProgress((current) => current?.requestId === requestId ? undefined : current);
    }
  }, [addImages, api, setStatus]);

  const importImages = useCallback(async () => {
    if (!api) return;
    const requestId = crypto.randomUUID();
    setProgress({ requestId, completed: 0, total: 1, stage: 'hash', fraction: 0 });
    try {
      const sources = await api.importImages(requestId);
      if (sources.length) await prepareAndAddImages(sources, undefined, requestId);
      else setProgress((current) => current?.requestId === requestId ? undefined : current);
    } catch (error) {
      setProgress((current) => current?.requestId === requestId ? undefined : current);
      setStatus(`导入失败：${String(error)}`);
    }
  }, [api, prepareAndAddImages, setStatus]);

  const pasteSystemClipboard = useCallback(async () => {
    if (!api) return;
    try {
      const sources = await api.registerClipboardImage();
      if (!sources.length) {
        setStatus('剪贴板中没有可粘贴的图片');
        return;
      }
      await prepareAndAddImages(sources, {
        screenX: lastPointerRef.current.x,
        screenY: lastPointerRef.current.y,
        pack: sources.length > 1,
      });
    } catch (error) {
      setStatus(`粘贴图片失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }, [api, lastPointerRef, prepareAndAddImages, setStatus]);

  useEffect(() => {
    const over = (event: DragEvent) => {
      event.preventDefault();
      if (event.dataTransfer?.types.includes(internalDropMime)) event.dataTransfer.dropEffect = 'copy';
    };
    const drop = async (event: DragEvent) => {
      event.preventDefault();
      const internalValue = event.dataTransfer?.getData(internalDropMime);
      if (internalValue && await internalDropHandlerRef.current(internalValue, {
        screenX: event.clientX,
        screenY: event.clientY,
      })) return;
      const supported = /\.(png|jpe?g|webp|bmp|gif)$/i;
      const files = [...(event.dataTransfer?.files ?? [])]
        .filter((file) => file.type.startsWith('image/') || supported.test(file.name));
      if (!api) return;
      try {
        let sources: ImportedImage[] = [];
        if (files.length) {
          const localPaths = files.map((file) => api.pathForFile(file));
          if (!localPaths.every((value): value is string => Boolean(value))) {
            throw new Error('无法取得拖入文件的本地路径');
          }
          sources = await api.registerImagePaths(localPaths, 'drop');
        } else {
          const html = event.dataTransfer?.getData('text/html') ?? '';
          const uriList = event.dataTransfer?.getData('text/uri-list') ?? '';
          const plain = event.dataTransfer?.getData('text/plain') ?? '';
          const htmlSource = html.match(/<img[^>]+src=["']([^"']+)/i)?.[1];
          const urls = [...new Set([...uriList.split(/\r?\n/), plain, htmlSource]
            .filter((value): value is string => Boolean(value && !value.startsWith('#')))
            .filter((value) => /^https?:\/\//i.test(value.trim())).map((value) => value.trim()))];
          if (urls.length) sources = await api.registerImageUrls(urls);
        }
        if (!sources.length) {
          setStatus('没有识别到可导入的图片');
          return;
        }
        await prepareAndAddImages(sources, {
          screenX: event.clientX,
          screenY: event.clientY,
          pack: sources.length > 1,
        });
      } catch (error) {
        setStatus(`拖入图片失败：${error instanceof Error ? error.message : String(error)}`);
      }
    };
    const paste = async (event: ClipboardEvent) => {
      if (!api) return;
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
      const supported = /\.(png|jpe?g|webp|bmp|gif)$/i;
      const files = [...(event.clipboardData?.files ?? [])]
        .filter((file) => file.type.startsWith('image/') || supported.test(file.name));
      try {
        let sources: ImportedImage[];
        if (files.length) {
          event.preventDefault();
          const localPaths = files.map((file) => api.pathForFile(file));
          sources = localPaths.every((value): value is string => Boolean(value))
            ? await api.registerImagePaths(localPaths, 'clipboard')
            : await api.registerClipboardImage();
        } else {
          // Bitmap clipboard (PS / browser / Win+Shift+S) often has no File entries.
          // Prevent default synchronously so Ctrl+V is not dropped on the floor while we read Electron clipboard.
          event.preventDefault();
          sources = await api.registerClipboardImage();
          if (!sources.length) {
            setStatus('剪贴板中没有可粘贴的图片');
            return;
          }
        }
        await prepareAndAddImages(sources, {
          screenX: lastPointerRef.current.x,
          screenY: lastPointerRef.current.y,
          pack: sources.length > 1,
        });
      } catch (error) {
        setStatus(`粘贴图片失败：${error instanceof Error ? error.message : String(error)}`);
      }
    };
    window.addEventListener('dragover', over);
    window.addEventListener('drop', drop);
    window.addEventListener('paste', paste);
    return () => {
      window.removeEventListener('dragover', over);
      window.removeEventListener('drop', drop);
      window.removeEventListener('paste', paste);
    };
  }, [api, internalDropHandlerRef, internalDropMime, lastPointerRef, prepareAndAddImages, setStatus]);

  useEffect(() => {
    if (!api || new URLSearchParams(window.location.search).get('smoke') !== '1') return undefined;
    const addTestPaths = (event: Event) => {
      const paths = (event as CustomEvent<string[]>).detail;
      void api.registerImagePaths(paths, 'drop').then((sources) => prepareAndAddImages(sources, {
        screenX: window.innerWidth / 2,
        screenY: window.innerHeight / 2,
        pack: sources.length > 1,
      })).catch((error) => setStatus(`冒烟图片载入失败：${String(error)}`));
    };
    window.addEventListener('refcanvas-smoke-add-paths', addTestPaths);
    return () => window.removeEventListener('refcanvas-smoke-add-paths', addTestPaths);
  }, [api, prepareAndAddImages, setStatus]);

  return { progress, importImages, prepareAndAddImages, pasteSystemClipboard };
}
