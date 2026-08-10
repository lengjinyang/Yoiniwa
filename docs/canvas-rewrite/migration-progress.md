# Canvas Rewrite 迁移进度

| 阶段 | 状态 | 提交 | 验证 |
| --- | --- | --- | --- |
| 基线冻结与全面审计 | 已完成 | `39afdf5`, `6baf834` | Legacy smoke 已通过，五份迁移文档已建立 |
| 1. Pixi Runtime 与 Camera | 已完成 | `5c47eae` | typecheck/lint，51 files/194 tests，production build |
| 2. Scene 与真实图片 | 已完成 | `b961ba5` | typecheck/lint，53 files/196 tests，production build |
| 3. 选择与变换 | 已完成 | `71cab90` | typecheck/lint，55 files/199 tests，production build |
| 4. Command/Undo/Redo | 已完成 | `53fe3ef` | typecheck/lint，56 files/201 tests，production build |
| 5. 图片流送与缓存 | 已完成 | `b2234b7` | typecheck/lint，62 files/209 tests，production build，Pixi 真图片 smoke |
| 6. 剩余功能 | 已完成 | `2d48f0f` | 62 files/210 tests，production build，Pixi smoke，quick benchmark |
| 7. 工程兼容 | 已完成 | `48bf833` | persistence integration，production build，Pixi smoke |
| 唯一入口与删除 Legacy | 已完成 | 待本阶段提交 | 46 files/151 tests，typecheck/lint/knip/build，normal + Pixi smoke |

## 当前约束

- 当前分支：`refactor/pixi-canvas`。
- Legacy 冻结点保留在 tag `canvas-legacy-freeze`，生产工作树已删除旧画布源码。
- 每阶段完成后运行 typecheck、lint、test、build 并独立提交。

## 阶段 1 结果

- PixiJS v8 `Application` 具有独立挂载、ResizeObserver 和显式销毁生命周期。
- Camera 成为唯一坐标变换来源，支持屏幕/世界坐标往返、指针锚点缩放、平移、缩放上下限。
- 连续输入只请求一帧；React 只接收手势结束后的 viewport 提交，不参与逐帧渲染。
- Pixi Runtime 现为唯一入口；迁移期 `?pixi-canvas` 与 legacy renderer 环境开关已删除。

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

## 阶段 5 结果

- 新 MipSelector 以旋转后屏幕占用、Camera scale、DPR 和 1.25 超采样计算需求；升级立即、降级需 2 倍冗余且静止 300ms。
- Uniform Grid 每帧仅查询可见区和 0.75 视口预加载区；远区 Sprite 不参与渲染并释放纹理 Pin。
- TextureRequestScheduler 按 `assetId+mip+tile` 合并并发请求，generation 变化后丢弃旧结果。
- CPU ImageBitmap LRU 按真实 RGBA 字节预算回收（设备自适应 256–1024 MiB，默认 512 MiB），释放时调用 `close()`。
- GPU LRU 独立使用 512 MiB 默认预算/1 GiB 硬上限；当前显示与待切换纹理分别 Pin，远区按 LRU 回收。
- 上传统一进入每帧最多 4 项、8 MiB、约 2ms 的队列；直接在预算帧调用 Pixi WebGL texture system，完成后才进入待切换状态。
- ImageRenderer 在帧开始原子提交 pending texture，等待期间不清空当前 Sprite、不退回通用缩略图。
- 超过 8192 的资源只用最大 4096 整图作稳定底图；放大需求超过 4096 时按 512 tile 建立完整目标集合，全部上传后整组切换。
- 开发性能面板接入 Pixi CPU/GPU 字节、队列、上传字节、命中率、可见/预加载数和当前 Mip。
- `npm run smoke:pixi` 已在 Electron production bundle 中导入真实 PNG、完成磁盘金字塔命中、GPU 上传并确认 Pixi canvas 数据。

## 阶段 6 结果

- Pixi 原生绘制分组框/标题/折叠态/锁定提示、pen/arrow/rectangle/ellipse 标注和图片评论气泡。
- 分组 contentsHidden 由 SceneStore 生成只读 render snapshot，不污染持久 Scene；嵌套成员递归隐藏。
- 新 Runtime 接管标注创建/擦除、标注拖动、分组头拖动、框选边缘自动平移、右键菜单、右键窗口移动、双击聚焦和异步源像素取色。
- 对齐/分布/Pack、裁切/翻转/透明/灰度、标签、属性面板、Outline、导入/拖放/粘贴、保存/打开仍由保留的应用服务操作同一 Scene，Pixi 通过低频快照同步。
- Quick 图片管线实测：5 个混合 JPEG/PNG/WebP 资源首次构建 739.15ms，二次 manifest 打开 1.31ms，峰值 RSS 131,330,048 bytes，稳定 RSS 83,058,688 bytes，命中率 100%，重复并发解码 0。
- Quick Node benchmark 没有 GPU 上下文，因此 GPU 占用、zoom 平均/P95/P99 和 Long Task 明确为“未测量”；完整 100×4K/500×2K/20×8K 场景命令为 `node tools/benchmarks/image-pipeline-benchmark.mjs --profile=full`。

## 阶段 7 结果

- `ProjectLoader`、`ProjectMigration`、`ProjectSerializer` 明确隔离 Runtime 状态与 `.refcanvas` Scene v2；选择、GPU handle、请求与 preview 不会进入文件。
- Round-trip 自动化覆盖 viewport、zIndex、crop、assetId，以及原始文件缺失但资产记录仍存在的缓存恢复模型。
- version 1 基础字段安全迁移到 version 2；非法 viewport/节点数值在进入 Runtime 前拒绝。
- 新增安全 autosave IPC：只有已有 `currentScenePath` 时才原子覆盖工程；未命名工程不会弹保存对话框或暗自选路径。
- `AutosaveCoordinator` 在 2 秒稳定边界序列化最新 revision；新改动取消旧计时，工程/组件卸载取消任务，保存 revision 仍经过 dirty revision 边界。
- 手动保存、打开与工程导入也统一经过新 serializer/loader；现有 scene package、最近打开、资产注册和缓存引用格式保持不变。

## 唯一入口与删除 Legacy 结果

- `App` 无条件挂载 `CanvasView`；CanvasBoard、Konva、旧 WebGL2/Canvas2D 后端、Pixel loader/plan 和旧 tile/atlas 代码已删除。
- `konva`、`react-konva` 依赖与 `REFCANVAS_LEGACY_RENDERER`、`pixi-canvas` 迁移开关已删除；生产源码扫描无旧运行时引用。
- Electron 正常 smoke 验证 Pixi 唯一入口、真实资产注册、GPU 驻留、WebGL context loss/restore 和 `.refcanvas` 往返；专用 Pixi smoke 亦通过。
- Benchmark 与真实图片诊断改为读取 `canvas.pixi-canvas` 的版本化数据集，不再依赖旧 DOM 或后端属性。
- 最终 quick 图片管线：5 个混合资源首次导入 740.51ms，二次打开 1.23ms，峰值 RSS 155,361,280 bytes，稳定 RSS 84,750,336 bytes，缓存命中 100%，重复并发解码 0。
