import { useCallback, useState } from 'react';
import type { PoseDocumentV1, PoseItem, SceneItem } from '../../types';
import { createDefaultPoseDocument } from '../../pose/domain/defaultPoseDocument';
import { parsePoseDocument } from '../../pose/domain/poseDocument';
import { itemBounds, reconcileMemberBounds } from '../../domain/scene';
import type { SceneHistoryController } from './useSceneHistory';

interface PoseStudioSession {
  itemId: string;
  draft: PoseDocumentV1;
  isNew: boolean;
  readOnly: boolean;
  placement?: { x: number; y: number };
}

function isPoseItem(item: SceneItem | undefined): item is PoseItem {
  return item?.contentKind === 'pose' && Boolean(item.pose);
}

export function usePoseStudioController({
  api, history, lastPointerRef, setSelectedIds, setSelectedGroupId, setStatus,
}: {
  api: Window['refCanvas'];
  history: SceneHistoryController;
  lastPointerRef: { current: { x: number; y: number } };
  setSelectedIds(ids: string[]): void;
  setSelectedGroupId(id?: string): void;
  setStatus(message: string): void;
}) {
  const [session, setSession] = useState<PoseStudioSession>();
  const [submitting, setSubmitting] = useState(false);

  const openNew = useCallback(() => {
    const viewport = history.scene.viewport;
    const pointer = lastPointerRef.current;
    const clientX = Number.isFinite(pointer.x) ? pointer.x : window.innerWidth / 2;
    const clientY = Number.isFinite(pointer.y) ? pointer.y : window.innerHeight / 2;
    setSession({
      itemId: crypto.randomUUID(), draft: createDefaultPoseDocument(), isNew: true, readOnly: false,
      placement: { x: (clientX - viewport.x) / viewport.scale, y: (clientY - viewport.y) / viewport.scale },
    });
  }, [history.scene.viewport, lastPointerRef]);

  const openItem = useCallback((item: SceneItem) => {
    if (!isPoseItem(item)) return false;
    const parsed = parsePoseDocument(item.pose);
    if (!parsed) {
      setStatus('姿势数据损坏或模型版本不受支持；仍可作为静态图片查看');
      return true;
    }
    setSession({ itemId: item.id, draft: structuredClone(parsed), isNew: false, readOnly: item.locked });
    return true;
  }, [setStatus]);

  const close = useCallback(() => setSession(undefined), []);

  const apply = useCallback(async (pose: PoseDocumentV1, png: Blob) => {
    if (!session || session.readOnly || submitting) return;
    if (!api?.registerImageBytes) {
      setStatus('当前环境不支持注册生成的 PNG');
      return;
    }
    setSubmitting(true);
    try {
      const nextRevision = pose.poseRevision + 1;
      const appliedPose = structuredClone({ ...pose, poseRevision: nextRevision, renderedRevision: nextRevision });
      const registered = await api.registerImageBytes(`pose-${session.itemId}.png`, await png.arrayBuffer(), 'generated');
      const naturalWidth = registered.asset.naturalWidth;
      const naturalHeight = registered.asset.naturalHeight;
      if (session.isNew) {
        const center = session.placement ?? {
          x: (window.innerWidth / 2 - history.scene.viewport.x) / history.scene.viewport.scale,
          y: (window.innerHeight / 2 - history.scene.viewport.y) / history.scene.viewport.scale,
        };
        const scale = 480 / Math.max(naturalWidth, naturalHeight);
        history.commit((scene) => {
          scene.assets[registered.assetId] = registered.asset;
          scene.items.push({
            id: session.itemId, name: '3D Pose Studio', sourceType: 'generated', assetId: registered.assetId,
            naturalWidth, naturalHeight, x: center.x - naturalWidth * scale / 2, y: center.y - naturalHeight * scale / 2,
            width: naturalWidth * scale, height: naturalHeight * scale, rotation: 0, flipX: false, flipY: false,
            opacity: 1, zIndex: scene.items.reduce((max, item) => Math.max(max, item.zIndex), -1) + 1,
            locked: false, crop: { x: 0, y: 0, width: naturalWidth, height: naturalHeight },
            mediaKind: 'image', contentKind: 'pose', pose: appliedPose,
          });
        });
      } else {
        history.commit((scene) => {
          const item = scene.items.find((value) => value.id === session.itemId);
          if (!item || item.contentKind !== 'pose' || item.locked) return;
          scene.assets[registered.assetId] = registered.asset;
          const centerX = item.x + item.width / 2;
          const centerY = item.y + item.height / 2;
          const longEdge = Math.max(item.width, item.height);
          const normalizedCrop = {
            x: item.crop.x / Math.max(1, item.naturalWidth),
            y: item.crop.y / Math.max(1, item.naturalHeight),
            width: item.crop.width / Math.max(1, item.naturalWidth),
            height: item.crop.height / Math.max(1, item.naturalHeight),
          };
          const sourceScaleX = naturalWidth / Math.max(1, item.naturalWidth);
          const sourceScaleY = naturalHeight / Math.max(1, item.naturalHeight);
          const remapPoint = <T extends { x: number; y: number }>(point: T): T =>
            ({ ...point, x: point.x * sourceScaleX, y: point.y * sourceScaleY });
          scene.visualNotes.marks.forEach((mark) => {
            if (mark.anchor.type !== 'image' || mark.anchor.imageId !== item.id) return;
            if (mark.kind === 'stroke') mark.points = mark.points.map(remapPoint);
            else if (mark.kind === 'arrow') { mark.start = remapPoint(mark.start); mark.end = remapPoint(mark.end); }
            else mark.point = remapPoint(mark.point);
          });
          const nextCrop = {
            x: normalizedCrop.x * naturalWidth,
            y: normalizedCrop.y * naturalHeight,
            width: Math.max(1, normalizedCrop.width * naturalWidth),
            height: Math.max(1, normalizedCrop.height * naturalHeight),
          };
          const scale = longEdge / Math.max(nextCrop.width, nextCrop.height);
          item.assetId = registered.assetId;
          item.naturalWidth = naturalWidth;
          item.naturalHeight = naturalHeight;
          item.width = nextCrop.width * scale;
          item.height = nextCrop.height * scale;
          item.x = centerX - item.width / 2;
          item.y = centerY - item.height / 2;
          item.crop = nextCrop;
          item.pose = appliedPose;
          reconcileMemberBounds(scene, { type: 'image', id: item.id }, itemBounds(item));
        });
      }
      setSelectedGroupId(undefined);
      setSelectedIds([session.itemId]);
      setSession(undefined);
      setStatus(session.isNew ? '已添加 3D Pose Studio 姿势参考' : '已更新 3D Pose Studio 姿势参考');
    } catch (error) {
      setStatus(`无法应用姿势：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setSubmitting(false);
    }
  }, [api, history, session, setSelectedGroupId, setSelectedIds, setStatus, submitting]);

  return { session, submitting, openNew, openItem, close, apply };
}

export type PoseStudioController = ReturnType<typeof usePoseStudioController>;
