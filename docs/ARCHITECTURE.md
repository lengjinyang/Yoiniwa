# RefCanvas 架构

RefCanvas 使用 Electron、React 与 PixiJS v8。Scene v2 是唯一的业务真相；GPU 纹理、图片金字塔、tile 和缩略图都是可重建缓存，不写回场景语义。画布没有 Legacy/V2 双入口。

## 数据流

1. `electron/main.ts` 是生产入口，并加载 `electron/application.ts`。
2. application 解析 `electron/runtime/runtime-flags.ts`，组装日志、场景包、资产缓存、图片任务和窗口生命周期。
3. `electron/preload.cts` 只通过 `contextBridge` 暴露 `window.refCanvas`。共享 channel 类型集中在 `src/shared/ipcContracts.ts`。
4. `src/App.tsx` 连接项目生命周期、Scene history 和页面布局。可复用场景变更位于 `src/domain/sceneCommands.ts`，菜单、快捷键与按钮共享 `src/app/AppCommand.ts`。
5. `src/canvas/CanvasView.tsx` 是应用与画布的低频 Scene/命令边界；`CanvasRuntime` 独立拥有 Camera、输入、空间查询和帧调度。
6. PixiJS 单一画布绘制图片、分组、标注、评论和选择层。`TextureManager` 管理解码请求、CPU/GPU LRU 与分帧上传，目标纹理完整就绪后才在帧边界替换。

## 目录职责

- `src/domain`：不依赖 React/Electron 的 Scene command。
- `src/app`：App command、稳定展示组件和 UI 几何工具。
- `src/canvas/runtime`：画布生命周期、帧调度、Camera 与 Scene bridge。
- `src/canvas/renderer`：Pixi 图层、图片/分组/标注/评论和选择绘制。
- `src/canvas/textures`：Mip 选择、去重、CPU/GPU 字节 LRU、Tile 与上传预算。
- `src/canvas/interaction`、`selection`、`commands`：输入路由、命中/变换与事务命令。
- `src/rendering/textureSelection.ts`：应用 UI 图片预览共用的尺寸选择工具，不属于画布后端。
- `src/shared`：renderer、preload、main 共用的 IPC 与统计契约。
- `electron/services`：缓存、图片任务、日志、持久化队列和场景包。
- `electron/runtime`：运行模式解析。
- `electron/benchmarks`：生产代码之外的性能与真实画板基准入口。
- `tools/benchmarks`：基准结果分析脚本。

## 不变量

- Scene v2 不增加必需字段，不因屏幕 LOD 改写原图信息。
- `window.refCanvas` 的公开方法由 `IpcContractMap` 约束。
- viewport 与手势预览的高频路径使用 ref/rAF；不得在 pointermove 或 wheel 中提交 Scene history。
- 自动保存只覆盖已有工程路径；未命名工程不会隐式选择保存位置。
- 生产环境只挂载 Pixi Runtime；不得重新引入按 URL 或环境变量切换画布的分支。
- 删除或修改动态 Electron 入口、worker、benchmark 前，必须同时更新 Knip 配置和对应测试。

## 修改检查

```powershell
npm run check
npm run build
npm run smoke
npm run smoke:stress
```

`npm run dist` 会生成 NSIS 安装包，不属于日常验证步骤。
