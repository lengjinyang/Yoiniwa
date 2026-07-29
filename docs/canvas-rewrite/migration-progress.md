# Canvas Rewrite 迁移进度

| 阶段 | 状态 | 提交 | 验证 |
| --- | --- | --- | --- |
| 基线冻结与全面审计 | 已完成 | `39afdf5`, `6baf834` | Legacy smoke 已通过，五份迁移文档已建立 |
| 1. Pixi Runtime 与 Camera | 已完成 | `5c47eae` | typecheck/lint，51 files/194 tests，production build |
| 2. Scene 与真实图片 | 已完成 | `b961ba5` | typecheck/lint，53 files/196 tests，production build |
| 3. 选择与变换 | 已完成 | `71cab90` | typecheck/lint，55 files/199 tests，production build |
| 4. Command/Undo/Redo | 已完成 | 待本阶段提交 | typecheck/lint，56 files/201 tests，production build |
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

## 阶段 2 结果

- `SceneStore` 是新 Runtime 内唯一的场景索引，渲染顺序与命中顺序都基于 `zIndex`。
- `ImageRenderer` 维护 `ImageItem.id -> Sprite` 的稳定映射，场景更新不会重建整棵显示树。
- 图片 URL 每次由 `assetId + variant + cacheVersion` 动态解析，不保存缓存绝对路径。
- 裁切使用独立 Texture frame；位置、旋转、翻转、透明度、隐藏、灰度均由 Pixi 对象属性表达。
- 异步加载结果带对象 token；对象删除或请求替换后，旧结果不会写回。

## 阶段 3 结果

- `InputRouter` 是 DOM pointer/wheel 的唯一分发入口；中键/Alt+左键平移，普通左键进入选择系统。
- 命中测试对旋转对象执行局部坐标反变换，并按 `zIndex` 返回最上层可见图片。
- 支持单选、修饰键增减选、空白取消、框选、锁定对象不变换，以及多对象移动。
- Pixi overlay 绘制选择边框、四角缩放点、旋转点和框选矩形；所有控制点保持屏幕恒定尺寸。
- 移动/缩放/旋转在 Runtime SceneStore 内逐帧预览，pointerup 仅向 React 提交一次变更。

## 阶段 4 结果

- 新增不依赖 React 的 `CanvasCommand`、`CommandStack`、`CommandManager` 与 `ImageTransformCommand`。
- 手势结束时用持久场景快照构造 before/after；逐帧 preview 从不进入 undo 栈。
- Undo/Redo 执行不可变场景替换，并在执行新命令后清空 redo 分支。
- 工程 epoch 改变时清空 Runtime 命令历史，防止跨工程撤销。
- 应用层现有 history 仍负责项目级快捷键与保存 dirty 状态；新画布内部所有变换先经过 CommandManager 再提交应用快照。
