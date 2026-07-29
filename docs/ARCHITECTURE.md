# RefCanvas 架构

RefCanvas 保持 Electron、React、Konva 与 WebGL2 的现有技术栈。Scene v2 是唯一的业务真相；GPU 纹理、图片金字塔、tile 和缩略图都是可重建缓存，不写回场景语义。

## 数据流

1. `electron/main.ts` 是生产入口，并加载 `electron/application.ts`。
2. application 解析 `electron/runtime/runtime-flags.ts`，组装日志、场景包、资产缓存、图片任务和窗口生命周期。
3. `electron/preload.cts` 只通过 `contextBridge` 暴露 `window.refCanvas`。共享 channel 类型集中在 `src/shared/ipcContracts.ts`。
4. `src/App.tsx` 连接项目生命周期、Scene history 和页面布局。可复用场景变更位于 `src/domain/sceneCommands.ts`，菜单、快捷键与按钮共享 `src/app/AppCommand.ts`。
5. `src/CanvasBoard.tsx` 负责输入协调和 Konva 覆盖层。图片 LOD 计划位于 `src/canvas/usePixelScenePlan.ts`，资源加载器位于 `src/canvas/PixelLoaders.tsx`。
6. 普通图片由 `src/rendering/usePixelRenderer.ts` 驱动 WebGL2 或 Canvas2D fallback；标注、分组、HUD 与交互代理仍由 Konva 绘制。

## 目录职责

- `src/domain`：不依赖 React/Electron 的 Scene command。
- `src/app`：App command、稳定展示组件和 UI 几何工具。
- `src/canvas`：画布计划、资源加载和覆盖层。
- `src/rendering`：WebGL2/Canvas2D 后端、render plan 和预览变换。
- `src/shared`：renderer、preload、main 共用的 IPC 与统计契约。
- `electron/services`：缓存、图片任务、日志、持久化队列和场景包。
- `electron/runtime`：运行模式解析。
- `electron/benchmarks`：生产代码之外的性能与真实画板基准入口。
- `tools/benchmarks`：基准结果分析脚本。

## 不变量

- Scene v2 不增加必需字段，不因屏幕 LOD 改写原图信息。
- `window.refCanvas` 的公开方法由 `IpcContractMap` 约束。
- viewport 与手势预览的高频路径使用 ref/rAF；不得在 pointermove 或 wheel 中提交 Scene history。
- 自动保存关闭。只有明确保存动作进入场景保存队列。
- `REFCANVAS_LEGACY_RENDERER=1` 必须继续提供旧渲染降级路径。
- 删除或修改动态 Electron 入口、worker、benchmark 前，必须同时更新 Knip 配置和对应测试。

## 修改检查

```powershell
npm run check
npm run build
npm run smoke
npm run smoke:stress
```

`npm run dist` 会生成 NSIS 安装包，不属于日常验证步骤。
