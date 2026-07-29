# Canvas Rewrite 迁移进度

| 阶段 | 状态 | 提交 | 验证 |
| --- | --- | --- | --- |
| 基线冻结与全面审计 | 已完成 | `39afdf5`, `6baf834` | Legacy smoke 已通过，五份迁移文档已建立 |
| 1. Pixi Runtime 与 Camera | 已完成 | 待本阶段提交 | typecheck/lint，51 files/194 tests，production build |
| 2. Scene 与真实图片 | 未开始 | — | — |
| 3. 选择与变换 | 未开始 | — | — |
| 4. Command/Undo/Redo | 未开始 | — | — |
| 5. 图片流送与缓存 | 未开始 | — | — |
| 6. 剩余功能 | 未开始 | — | — |
| 7. 工程兼容 | 未开始 | — | — |
| 唯一入口与删除 Legacy | 未开始 | — | — |

## 当前约束

- 当前分支：`refactor/pixi-canvas`。
- Legacy 只作为对照，不接受新补丁。
- 每阶段完成后运行 typecheck、lint、test、build 并独立提交。

## 阶段 1 结果

- PixiJS v8 `Application` 具有独立挂载、ResizeObserver 和显式销毁生命周期。
- Camera 成为唯一坐标变换来源，支持屏幕/世界坐标往返、指针锚点缩放、平移、缩放上下限。
- 连续输入只请求一帧；React 只接收手势结束后的 viewport 提交，不参与逐帧渲染。
- 当前通过 `?pixi-canvas` 临时迁移开关进入新画布；最终阶段删除该开关与 Legacy 路径。
