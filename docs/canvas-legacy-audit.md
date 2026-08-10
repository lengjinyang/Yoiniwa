# Legacy Canvas 审计与 Canvas V2 隔离边界

## 冻结状态

- 冻结提交：`d34da2c checkpoint: freeze legacy canvas before canvas v2`
- 冻结标签：`canvas-legacy-freeze`
- V2 开发分支：`canvas-v2`
- 冻结时旧画布可以通过现有应用入口启动；后续不得以 Canvas V2 名义继续修改旧画布核心。
- 旧画布是功能参考和回退实现，不是 Canvas V2 的渐进重构目录。

## 审计范围

本审计只描述 Renderer 画布核心及其直接边界。Electron 图片导入、磁盘金字塔、Asset Registry、场景包持久化继续作为应用级服务存在，不纳入画布重写范围。

主要入口和规模：

| 模块 | 规模 | 当前职责 |
| --- | ---: | --- |
| `src/App.tsx` | 1742 行 | 应用状态、命令、历史、导入导出、面板，并组装旧画布 |
| `src/CanvasBoard.tsx` | 2184 行 | 画布编排、交互、剔除、选择、分组、标注、Konva overlay、像素渲染协调 |
| `src/rendering/usePixelRenderer.ts` | 702 行 | React 到渲染后端的桥接、资源同步、稳定 LOD、相机预览、统计与重试 |
| `src/rendering/WebGL2ImageRenderer.ts` | 547 行 | WebGL2 图集、纹理预算、上传队列、实例绘制与 GPU 统计 |
| `src/imageResources.ts` | 415 行 | HTMLImageElement 解码缓存、引用计数、变体选择和协议 URL |
| `src/canvas/usePixelScenePlan.ts` | 165 行 | 可见/预加载资源、固定 Mip/Tile 和 quality focus 计划 |

`CanvasBoard` 当前至少包含 36 个 `useRef`、25 个 `useMemo`、16 个 `useEffect` 和多个命令式帧循环。单看 Hook 数量不是缺陷，但这里的 Ref 同时承载相机真值、手势状态、资源状态、统计采样和 Konva 节点状态，形成了难以验证的隐式状态机。

## 当前调用拓扑

```text
App / useSceneHistory
  │ scene + selection + 30 余个 callback
  ▼
CanvasBoard (legacy orchestrator)
  ├─ SpatialIndex / viewport culling
  ├─ usePixelScenePlan
  │    ├─ imageResources / Mip variant
  │    ├─ tileSelection
  │    └─ renderPlan / tileRenderPlan
  ├─ PixelImageLoader / PixelUrlLoader (React 生命周期)
  ├─ usePixelRenderer
  │    ├─ stableRenderCommands
  │    ├─ WebGL2ImageRenderer
  │    ├─ Canvas2DImageRenderer
  │    └─ Konva Stage fallback / gesture preview
  ├─ 独立 group-background canvas
  └─ Konva Stage（6 个 Layer）
       ├─ 图片 fallback / 命中代理
       ├─ comments / annotations
       ├─ groups / headers
       └─ selection / transformer / rotation handles
```

实际画面由三个系统叠加：背景 Canvas、图片 WebGL/Canvas2D Canvas、Konva Canvas Layers。它们共享场景坐标，但各自拥有重绘、尺寸、DPR、命中和生命周期逻辑。

## 旧画布的状态所有权

### App 所有

- `Scene`、历史和 dirty revision。
- 图片、标注、分组的最终提交。
- 选择集合、选中分组、工具模式和窗口模式。
- 导入、保存、导出和应用命令。

### CanvasBoard 所有或临时覆盖

- DOM 尺寸和空间索引。
- `props.scene.viewport` 之外的 live、settled、quality、rendered viewport。
- pointer gesture、window move、selection box、auto-pan、rotation 和 transform preview。
- hover、comment、group header、picker HUD、eraser cursor。
- pixel renderer backend、交互暂停、资源失败和 tile level。
- 性能采样、manual wheel session 和大量 benchmark data attribute。

### 渲染 Hook / Backend 所有

- command 对应的 HTMLImageElement、pending image、retry timer。
- last drawable commands、stable LOD 和 viewport commit guard。
- GPU atlas、texture residency、upload queue 和 instance buffer。
- backend fallback 和 WebGL context recovery。

这些状态没有统一 store 或显式事件协议。同一用户动作会同时修改 React state、多个 Ref、Konva node transform、GPU gesture matrix 和延迟提交 timer。

## 主要耦合与回归来源

### 1. 一个组件同时承担领域逻辑、交互状态机和渲染调度

`CanvasBoard` 内部直接实现图片拖动、多选缩放、旋转、框选、自动平移、分组移动、标注、擦除、取色、窗口拖动和上下文菜单。任何 pointer 分支都可能影响 viewport、selection、Konva listening、GPU upload pause 和 App callback。

结果是增加一种手势或修复一种工具时，必须理解几乎全部画布状态。

### 2. 相机存在多个时间域

当前同时存在：

- `props.scene.viewport`：React/历史中的已提交值；
- `viewportRef` / live viewport：事件期间即时值；
- delayed/quality viewport：用于 LOD 和 Tile；
- rendered viewport：后端最后实际绘制值；
- viewport commit guard：避免 React 回写旧值造成回滚。

这些值通过 RAF、timer、effect 和 imperative render 协调。此前出现的平移释放回滚、纹理晚一拍和缩放 LOD 抖动都与多时间域协调有关。

### 3. 图片资源加载由 React 组件生命周期驱动

每个 render command 会实例化 `PixelImageLoader` 或 `PixelUrlLoader`。command ID 后缀（`:preview`、`:detail`、`:tile:`）同时被当作资源身份、优先级规则和稳定 LOD 语义。

这使场景计划、网络/协议请求、HTMLImage 解码和 GPU residency 通过字符串约定耦合。一次 command 数组变化可能触发组件卸载、请求取消、图片 Map 更新和 GPU 同步。

### 4. 图片显示与交互由不同渲染树表达

WebGL 模式下图片由像素 Canvas 绘制，但选择、拖动和 Transformer 仍依赖 Konva 节点或透明 proxy。图片变换预览需要同时更新 Konva 和 GPU gesture matrix；结束时再提交 Scene。

这造成视觉状态、命中状态和持久状态可能短暂不一致。

### 5. Group 具有三套表达

Group 同时存在于：

- 独立背景 Canvas；
- Konva `GroupFrame`；
- Konva `GroupCompactHeader`。

移动、折叠、成员隐藏、标题 hover 和背景预览分别触发不同路径。嵌套成员遍历还依赖对 Konva node ID 的递归查找。

### 6. 性能与 smoke 接口侵入核心 JSX

`CanvasBoard` 根节点暴露大量 `data-*` 属性，Benchmark 直接读取这些内部统计。测试很有价值，但目前这些属性与组件内部字段一一绑定，使实现细节难以替换。

V2 应提供稳定的 diagnostics snapshot 接口，DOM 只保留一个版本化入口。

### 7. Backend 抽象仍泄漏 Konva 和 DOM 图片类型

`ImageRenderBackend` 接收 `HTMLImageElement/CanvasImageSource`；`usePixelRenderer` 还直接持有 `Konva.Stage`，并负责 fallback 到 Konva。它不是独立的渲染内核边界，而是旧画布适配层。

### 8. 测试集中于纯函数和渲染器，缺少 CanvasBoard 状态机测试

已有测试很好地覆盖 atlas、LRU、Mip、Tile、稳定 command、上传预算和 viewport guard，但没有直接覆盖 2184 行的 `CanvasBoard` 组合状态机。多数交互回归只能由 Electron smoke/project-zoom 发现，定位成本较高。

## 已有优点，应作为行为参考

- 场景数据和 `assetId` 已与缓存路径分离。
- 图片导入、Mip 生成和缓存迁移已在 Renderer 外执行。
- WebGL2 主图片平面、实例绘制、GPU/CPU 字节预算已存在。
- 目标纹理未完成时保留稳定纹理的行为已经实现。
- 上传数量、字节和时间均有帧预算。
- Uniform Grid/SpatialIndex 已提供基础视口剔除。
- 交互覆盖层不需要全部迁入 WebGL；独立 UI overlay 是合理方向。
- `scene.ts` 中多数几何函数、图片管线配置和 Electron 服务可被 V2 复用。

这些能力只能按稳定 API 复用，不应把旧 Hook 或旧组件整体复制进 V2。

## Canvas V2 可复用边界

允许 V2 通过明确适配器复用：

- `src/types.ts` 中持久化 Scene/Asset 类型；
- `src/scene.ts` 中无副作用的几何计算，后续可再提取到共享 domain；
- `src/shared/imagePipelineConfig.ts` 的缓存和预算常量；
- `src/rendering/textureSelection.ts`、`byteLru.ts`、`uploadBudget.ts` 等纯算法；
- Electron `refcanvas-asset` 协议、Asset Registry、磁盘金字塔和 Worker 服务；
- 现有 `.refcanvas` 场景格式；
- 现有 benchmark 数据集和验收阈值。

V2 不应直接依赖：

- `CanvasBoard.tsx` 及其内部组件；
- `usePixelRenderer.ts`；
- `usePixelScenePlan.ts`；
- `PixelImageLoader` / `PixelUrlLoader`；
- command ID 后缀的隐式语义；
- Konva Stage 作为图片渲染、命中或相机真值；
- 旧画布 DOM `data-*` 字段的内部布局；
- 旧画布的 timer/ref 状态机。

`WebGL2ImageRenderer` 可以作为算法参考，但不应原样作为 V2 核心：它把图集分配、上传调度、resource ownership、绘制和统计放在一个类中。若复用代码，必须通过复制后拆分或小型无状态模块复用，不能从 V2 反向 import legacy orchestrator。

## Canvas V2 需要建立的独立契约

建议 V2 核心只接受以下类别输入：

```text
SceneSnapshot       持久场景的只读快照
CanvasCommand       明确的领域命令，不直接调用 App callback 集合
ViewportState       单一即时相机状态，提交历史是外部副作用
PointerInput        归一化 pointer/wheel/keyboard 输入
ResourceDescriptor  结构化 assetId/mip/tile，不使用字符串后缀推断
DiagnosticsSnapshot 版本化性能与资源统计
```

输出只允许：

```text
ScenePatch / Transaction
SelectionChanged
ViewportCommitted
ContextMenuRequested
ColorPicked
DiagnosticsSnapshot
```

渲染、命中测试、交互状态机和 App 历史必须通过上述契约连接，不能互相持有实现对象。

## V2 最小分层建议

```text
canvas-v2/
  entry/            独立 React 入口和 legacy/v2 开关
  model/            CanvasSnapshot、选择和 transaction
  camera/           单一 camera state 与坐标转换
  interaction/      可测试的显式状态机
  spatial/          增量空间索引与 hit testing
  resources/        结构化 Mip/Tile 请求、CPU residency
  renderer/         WebGL renderer、GPU cache、upload scheduler
  overlays/         选择框、控制点、标注等轻量 UI
  diagnostics/      稳定 snapshot 接口
```

目录名称仅表达隔离要求，实际创建应在 Canvas V2 设计步骤确认后进行。本审计阶段不创建 V2 实现。

## Legacy 必须保持可启动

- 默认旧入口和现有 `CanvasBoard` 不得被删除或重命名。
- V2 应使用独立入口或显式 feature flag；切换失败必须能回退 legacy。
- Legacy 和 V2 不得共享可变单例、GPU context、相机 Ref 或 React loader Map。
- 两者可以读取同一 Scene snapshot 和 Asset 服务，但不能同时写同一交互事务。
- 新测试不得通过修改 legacy 行为来迁就 V2。

## 功能参考清单

V2 后续按小阶段逐项对齐，不要求第一版同时完成：

1. 空画布启动、Resize、DPR 和背景。
2. Scene snapshot 渲染与视口剔除。
3. 平移和指针中心缩放。
4. 单选、多选、框选和命中顺序。
5. 图片移动、缩放、翻转、旋转和裁切显示。
6. 稳定 Mip、Tile、预加载和 GPU 分帧上传。
7. 分组、嵌套分组、折叠、隐藏和锁定。
8. 标注、擦除、评论和取色。
9. 上下文菜单、窗口拖动和快捷键协作。
10. 历史事务、工程重开和资源释放。

## V2 首批验收基线

- Legacy 入口继续通过当前 smoke。
- V2 入口失败时不影响 Legacy 启动。
- V2 核心模块不 import `CanvasBoard.tsx`、`usePixelRenderer.ts` 或 Konva Stage。
- 相机只有一个即时真值；历史提交不参与当前帧渲染。
- pointer handler 不直接解码图片、上传纹理或执行 React scene 深拷贝。
- 目标纹理未完成时保持当前可绘制纹理。
- GPU 上传仍满足 4 项 / 8 MiB / 约 2 ms 的帧预算。
- 所有可取消资源请求携带 generation/request identity。
- 核心 interaction state machine 可以在无 DOM、无 React 环境下单元测试。
- diagnostics 通过版本化对象暴露，不依赖几十个 DOM 属性。

## 审计结论

旧画布已经具备较完整功能和经过验证的图片管线，但画布协调层同时维护太多状态所有权与渲染时间域。继续添加兼容分支会扩大回归面。

Canvas V2 应重建“相机、交互状态机、资源描述、渲染调度”四个核心边界；App、场景格式和 Electron 图片服务保持不动。Legacy 作为冻结参考，通过独立入口长期保留，V2 只按可测试的垂直切片逐步接入。
