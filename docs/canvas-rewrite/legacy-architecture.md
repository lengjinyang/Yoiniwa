# Legacy Canvas 架构

详细审计见 `docs/canvas-legacy-audit.md`。

## 入口

`App.tsx -> CanvasBoard.tsx -> usePixelScenePlan/usePixelRenderer -> WebGL2ImageRenderer | Canvas2DImageRenderer | Konva fallback`。

## 关键结构问题

- `CanvasBoard.tsx` 2184 行，领域操作、输入状态机、相机、资源、渲染和 overlay 共处。
- React Scene、命令式 Ref、Konva node 和 GPU gesture 同时表达当前状态。
- committed/live/settled/quality/rendered 五类 viewport 通过 timer/effect 协调。
- 图片加载依赖 React Loader 组件挂载和 command ID 后缀协议。
- 图片、背景和交互由多个 Canvas/Konva Layer 叠加。
- `usePixelRenderer` 既管理后端和资源，又依赖 Konva Stage，抽象边界泄漏。

## 冻结规则

- Tag `canvas-legacy-freeze` 是行为参考。
- 新 Runtime 不 import Legacy Canvas、Legacy Hook 或 Konva Stage。
- 迁移期间只允许从冻结点运行对照测试，不向旧画布添加兼容逻辑。
