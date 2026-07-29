# Pixi Canvas 目标架构

```text
React CanvasView
  └─ CanvasRuntime
      ├─ RuntimeLifecycle / FrameScheduler
      ├─ SceneStore（唯一业务状态）
      ├─ Camera（唯一即时相机）
      ├─ InputRouter
      │   └─ Pan / Selection / Transform / BoxSelect Controllers
      ├─ CommandStack
      ├─ SpatialIndex / HitTestService
      ├─ PixiRenderer
      │   ├─ World / Images / Groups / Annotations / Overlay Layers
      │   └─ RenderObjectRegistry
      ├─ AssetPipeline / TextureManager
      └─ PerformanceMetrics
```

## 边界

- React 只创建/销毁 Runtime，发送低频 Scene snapshot/命令，接收低频摘要。
- Pointer/Wheel/RAF 内不调用 React `setState`。
- SceneNode 只保存可序列化数据，不保存 Pixi/DOM/GPU/Promise/绝对路径。
- Pixi 对象仅由 RenderObjectRegistry 管理。
- 数据流固定为 `Input -> Controller -> Command -> SceneStore -> Renderer`。
- 相机即时值只存在 Camera；App viewport 更新是节流后的持久化副作用。
- 资源请求使用结构化 `{assetId,mip,tile}`，不从字符串后缀推断语义。

## 允许复用

- Scene/Asset 持久化类型：工程兼容的事实来源。
- `scene.ts`、布局和坐标类纯函数：无渲染副作用且已有测试。
- 图片缓存协议、Worker、Manifest、generation：独立 Electron 服务。
- Mip/迟滞、LRU、上传预算算法：无框架依赖且已有测试。

## 禁止复用

- `CanvasBoard.tsx`、`usePixelRenderer.ts`、`usePixelScenePlan.ts`。
- PixelImageLoader/PixelUrlLoader React 生命周期。
- Legacy Konva 交互节点和 viewport Ref 状态机。
- Legacy WebGL Renderer 的整体类；仅可提取纯算法。
