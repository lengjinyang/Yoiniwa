# PixiJS 画布最终验收报告

日期：2026-07-29  
分支：`refactor/pixi-canvas`

## 1. 结论

本轮没有新增产品功能，完成了独立审查、真实 Electron 运行、旧工程迁移、冷/热图片缓存、压力、资源生命周期和 Windows NSIS 打包验证。验收中发现并修复了以下真实问题：

- 工程在新机器/新缓存根目录打开时，包内原图已注册但缺失的磁盘 Mip 金字塔不会重建，Renderer 会永久请求不存在的 Manifest。
- 4K 图片已经生成 Tile，却因渲染条件仍使用旧的 `>8192 && required>4096` 判断而上传整张纹理；实测单帧峰值 33,177,600 bytes。
- 框选、滚轮和标注橡皮的高频路径仍会向 React 提交状态。
- GPU 上传完成后错误地从 CPU LRU 删除并关闭 `ImageBitmap`，使 CPU 缓存名义存在但无法命中。
- 工程打包资源失败时，临时归档的清理和原文件保护不完整。
- Project Zoom 验收工具仍依赖旧 Renderer 的 `webgl2/lodCoverage/renderInstances` 指标，无法验证 Pixi Runtime。

修复后 4K 高倍率测试的单帧上传峰值为 4,755,456 bytes，低于 8 MiB；目标 Tile 集合完整后才在帧边界隐藏稳定底图，等待期间不会清空当前纹理。

## 2. 旧画布残留

命令：

```powershell
rg -n -i "legacy.?canvas|canvas.?v2|old.?canvas|useLegacyCanvas|enableCanvasV2" . \
  -g "!node_modules/**" -g "!dist/**" -g "!dist-electron/**" \
  -g "!release/**" -g "!performance-results/**"
```

结果仅命中历史文档：

- `docs/canvas-legacy-audit.md`
- `docs/canvas-rewrite/legacy-architecture.md`
- `docs/canvas-rewrite/legacy-feature-inventory.md`

生产源码不存在 Legacy Canvas 入口、旧 Canvas 组件、旧 Camera/选择/变换 Store、Legacy/V2 开关、DOM 图片画布或同步 Adapter。Knip 无死代码报告。

## 3. 唯一入口、状态边界和调用链

唯一入口：

```text
src/main.tsx:6
→ src/App.tsx:1417 CanvasView
→ src/canvas/CanvasView.tsx:82 CanvasRuntime
→ src/canvas/runtime/CanvasRuntime.ts:50 PixiRenderer
→ src/canvas/renderer/PixiRenderer.ts:104 Application.render()
```

输入到渲染：

```text
InputRouter (CanvasRuntime.ts:76)
→ CameraController / SelectionController (77 / 84)
→ ImageTransformCommand (96)
→ SceneStore (167)
→ PixiRenderer.setScene/render (PixiRenderer.ts:65 / 84)
→ RenderObjectRegistry (RenderObjectRegistry.ts:1)
→ PixiJS Application.render (PixiRenderer.ts:104)
```

业务持久真值是 Scene v2 的已提交快照；`useSceneHistory` 持有撤销/重做快照。Canvas Runtime 的 `SceneStore` 是当前手势的工作副本和空间索引：Pointer Move 只改变该工作副本，Pointer Up 通过一个 Command 向历史提交一次。Pixi Sprite/Texture/Container 从不参与保存，也不反向覆盖 Scene。

严格来说，已提交历史快照和手势中的工作副本是两个生命周期不同的 Scene 表示；它们不是两个可独立写入的业务 Store，也没有三方同步 Adapter。若后续要求字面意义上的“同一个对象实例”，需要把历史服务也迁入 Runtime Store；本轮未做这项再次架构重写。

## 4. React 与 Pixi 边界

- Pan、Wheel、拖动、缩放、旋转、框选、Hover、Pointer Move 均在 Runtime/Controller 内处理。
- 框选只在 Pointer Up 发一次 `selectionChanged`。
- Wheel 每次输入仅更新 Camera 和请求帧，120 ms 静默后提交一次 viewport 摘要。
- 橡皮轨迹在 Runtime 累积，Pointer Up 只产生一个 `history.commit`。
- React 接收选择、持久 viewport、最终变换、dirty/revision 和面板状态；不参与 Pixi 每帧绘制。

## 5. 保存和加载

```text
保存：App.tsx:457
→ flushViewport
→ ProjectSerializer.serializeProjectScene
→ preload scene:save
→ application.ts:1889
→ enqueueSceneSave
→ scene-packages.ts:104 writeScenePackage
→ 临时 ZIP 完成后 rename，失败则删除 temp 并恢复 backup

加载：App.tsx:479
→ preload scene:open
→ application.ts:1906
→ scene-packages.ts:141 readScenePackage
→ 校验 ZIP/Manifest/Hash/大小并原子安装资源
→ Scene v1/v2 migrate/normalize
→ history.load
→ CanvasRuntime.setScene
```

用包含 500 节点、100 个 4K Asset 的 v1 工程实际完成：迁移为 v2、另存、重读、位置/尺寸/旋转/zIndex/opacity/crop/assetId/viewport 对比、再次交给 Pixi 绘制。另存 870.66 ms，重读 1,019.70 ms，`rendererReopen=true`，原 v1 文件未覆盖。

## 6. 图片到 Texture

```text
App.prepareAndAddImages (App.tsx:400)
→ registerImagePaths / clipboard / URL
→ prewarmImages (application.ts:625)
→ ensureImagePyramid (application.ts:518)
→ image-worker buildPyramid (image-worker.ts:228)
→ 临时目录 + 校验 + Manifest 最后写入 + 原子目录替换
→ refcanvas-asset://assetId?variant=mip/tile
→ TextureManager.request (TextureManager.ts:25)
→ createImageBitmap + CPU byte LRU
→ GpuUploadQueue.processFrame
→ GPU byte LRU
→ ImageRenderer.pendingSwap / TileRenderer.pending
→ commitPendingSwaps (ImageRenderer.ts:113)
→ Sprite/Tile Container
```

工程重开时若 Manifest 缺失或损坏，协议层现在先调用 `ensureImagePyramid`，再返回请求的 Mip；这修复了旧工程在新缓存根目录永久空白的问题。

大于 2048px 的资源已经有 Tile 金字塔。当屏幕需求超过 1024px 时，Renderer 使用 512px Tile；已有整图继续作为稳定底图，完整 Tile 集合在同一帧提交后才隐藏底图。透明图因此不会在过渡帧被底图重复叠加。

## 7. 撤销重做

```text
Controller preview
→ Runtime SceneStore（不写 React）
→ Pointer Up
→ ImageTransformCommand
→ App onItemsChanged
→ useSceneHistory.commit
→ past/future snapshot
→ Ctrl+Z / Ctrl+Y
→ useSceneHistory.undo/redo
→ CanvasView.setScene
```

真实输入 Smoke 验证多选整体拖动只产生一次提交，并可一次 Undo/Redo。删除、层级、旋转、整体缩放、属性变化由 Scene command/transform 单元测试覆盖。

## 8. 实际命令与结果

```powershell
npm run check
# PASS: typecheck + eslint + knip + 48 files / 155 tests

npm run build
# PASS: renderer/electron typecheck、Electron TS、Vite production build

npm run smoke
# PASS: 真实 sendInputEvent；单选、多选、整体移动、Undo/Redo、锁定、框选、锚点缩放、上下限、10 次场景生命周期

npm run smoke:pixi
# PASS: 唯一 Pixi canvas、上下文恢复、纹理释放

$env:REFCANVAS_PERF_INTERACTION_MS='30000'; npm run smoke:perf:after
# PASS: 最终代码上的 30s pan + 30s zoom + 30s drag + box select + save/reopen

node tools/benchmarks/image-pipeline-benchmark.mjs --profile=full
# PASS: 620 个混合格式资源，冷导入、热重开、重复解码检查

npm ls pixi.js
# PASS: 只有 pixi.js@8.19.0

npm run dist
# PASS: Windows x64 NSIS
```

安装包：`release/RefCanvas-0.1.0-Setup.exe`，121,717,579 bytes。

## 9. 功能验收

自动化/真实输入通过：

- 画布平移、鼠标锚点缩放、快速缩放、0.02/32 上下限、viewport 提交、工程重开视图。
- 单选、Ctrl 多选、框选、取消、多对象移动、锁定对象保护。
- 新增图片、移动的撤销重做；一次拖动一条历史。
- 场景重复加载 10 次始终只有一个 Pixi Canvas；清空后 GPU Texture 为 0。
- v1 工程迁移、原子另存、重开和几何/层级/资源身份一致性。
- 冷缓存重建、热缓存命中、缓存目录迁移后 Worker 从新根目录生成缩略图，旧 Asset 目录删除后不再读取。
- 混合 JPEG/PNG/WebP、透明、4K/8K+ 和大量小图的磁盘金字塔生成。

由单元/集成测试通过、但本轮未通过 OS UI 逐项人工点击的项目：

- Shift 多选、重叠对象选择、旋转/缩放 Handle、复制/剪贴板系统格式、图层按钮、透明度滑块、适应全部/聚焦按钮。
- 源文件删除后的 UI 提示文案；包内 Asset 与已有磁盘缓存路径已有自动化覆盖。

## 10. 性能结果

设备：Windows x64，Electron 43.2.0，DPR 1.25，ANGLE D3D11，NVIDIA GeForce RTX 3080。

最终交互基准（`performance-results/2026-07-29T08-57-03-826Z-after/summary.json`）：

| 场景 | 时长/帧 | P95 | P99 | >50ms Long Task |
| --- | ---: | ---: | ---: | ---: |
| 快速平移 | 30.01s / 2251 | 13.4ms | 13.5ms | 0 |
| 连续缩放 | 30.01s / 2249 | 13.4ms | 13.5ms | 0 |
| 20 图连续拖动 | 30.01s / 2250 | 13.4ms | 13.5ms | 0 |
| 500 图框选 | 1.61s / 121 | 13.4ms | 13.4ms | 0 |

稳定缩放阶段：GPU 463,393,336 bytes，CPU 图片缓存 463,393,336 bytes，命中率 82.59%，队列最终均为 0。保存 1,393.50 ms，重开 1,775.03 ms。Renderer private memory 100,980 KiB（Electron 指标）。

最终 4K Tile 专项（`performance-results/2026-07-29T08-54-25-930Z-project-v1-migration-roundtrip/summary.json`）：

- 热工程首个可用帧：1,392.38 ms。
- GPU/CPU 峰值：439,111,148 / 439,111,148 bytes。
- 单帧上传峰值：4,755,456 bytes。
- 高倍 Alt-pan P95/P99：13.4/13.5 ms；首移动误差 0；释放回滚帧 0。
- 资源峰值队列：decode 423，upload 390；最终均归零。

完整图片管线（`performance-results/image-pipeline-full-latest.json`）：

| 数据集 | 首次导入 |
| --- | ---: |
| 100×4K | 275,263.60 ms |
| 500×2K | 205,097.39 ms |
| 20×8K+ | 241,895.12 ms |
| 合计 620 Asset | 722,258.58 ms |

第二次打开 69.92 ms；磁盘命中率 100%；重复并发解码 0；Node 进程采样峰值 RSS 1,055,236,096 bytes，稳定 RSS 372,137,984 bytes。Node 基准没有 GPU 上下文，因此 GPU 数据以 Electron 专项为准。

## 11. 内存与资源生命周期

正常应用 Smoke 重复 10 次“有图场景→空场景→有图场景”：

- `singleCanvas=true`，没有重复 Pixi Application Canvas。
- `allReleased=true`，空场景时 `gpuTextures=0`。
- Chromium 暴露的 JS heap 采样首尾均为 10,000,000 bytes；该 API 粒度较粗，只能用于检测明显增长。
- Runtime `destroy()` 依次注销 Input、Camera、Selection、ResizeObserver、FrameScheduler，销毁 RenderObjectRegistry、TextureManager、Pixi Application。
- CPU LRU 驱逐/销毁会调用 `ImageBitmap.close()`；上传期间由 pinCount 保护。

## 12. 风险和未自动验证项

- 本轮没有机器视觉连续帧判定，无法自动证明所有显示器/驱动上绝无一帧色差或闪烁；代码保证旧纹理保留到完整目标纹理/Tile 集合在帧边界提交。
- 2048px 或更小资源仍允许作为单个整图任务；上传队列至少受每帧 4 项限制，但单个 2048² RGBA 的估算值可超过 8 MiB。实际 4K Tile 场景峰值低于 8 MiB。
- 500 节点首次聚焦会瞬时排入数百个 Tile 请求，虽有去重、generation、LRU 和分帧上传且最终收敛，队列峰值仍高；后续可增加可见 Tile 请求窗口背压。
- 性能机器为 RTX 3080；低端集显、HDR/ICC、多显示器 DPR 切换需要用户设备复测。
- Benchmark 强制退出 Electron 后曾见 Chromium `GPU state invalid after WaitForGetOffsetInRange` 日志；正常 Smoke、构建和退出码均通过，未观察到持久资源或数据损坏。
- Vite 报告单个入口 chunk 约 513 kB；不影响本轮正确性。electron-builder 还提示缺少自定义图标/author 和若干传递依赖重复引用。

## 13. 建议用户亲自验证

1. 安装 `release/RefCanvas-0.1.0-Setup.exe`，打开一份真实旧版工程，先另存为副本。
2. 在 100%、150%、200% Windows 缩放和目标显示器上，快速滚轮往返观察透明 PNG 边缘和高对比细线。
3. 对重叠图执行 Shift/Ctrl 多选、旋转 Handle、多对象缩放/旋转，逐项 Undo/Redo。
4. 从资源管理器拖入、系统剪贴板粘贴、复制到其他应用，验证 OS 集成格式。
5. 更改缓存目录后立即重开工程，再删除旧缓存目录，确认图片仍可恢复。
6. 在集显设备上打开 500×2K 工程，观察开发性能面板的 GPU/CPU 预算、队列峰值和 P95。
