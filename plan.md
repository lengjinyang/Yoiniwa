# Magic Poser 核心姿势工作流复刻方案

## 总结

目标是让当前姿势工作室具备 Magic Poser 的核心操作逻辑，同时：

- 保留当前 BJD 模型。
- 保留 Three.js 实现，不引入独立 WASM。
- 保留“应用到画布”、PNG 生成、姿势存档和再次编辑。
- 复刻选中、移动、旋转、手指、锁定、预设、相机、撤销/重做和预览。
- 不复刻完整模型库、道具、头发、材质库等扩展功能。

Magic Poser 网页本身采用 React 工具栏 + WebAssembly/WebGL 核心；公开页面和 source map 可参考：[Magic Poser Web](https://webapp.magicposer.com/)、[公开前端 source map](https://webapp.magicposer.com/static/js/main.52d6b3df.chunk.js.map)。

## 主要改动

### 1. 复刻 Magic Poser 的选择和工具状态

在 [PoseRuntime.ts](D:/Code/PureRefLike/src/pose/runtime/PoseRuntime.ts) 中建立统一的选中状态：

```ts
type PoseSelectedPart =
  | 'none'
  | 'model'
  | 'joint'
  | 'hand'
  | 'finger'
  | 'head';
```

选中结果包含：

```ts
interface PoseSelection {
  part: PoseSelectedPart;
  jointId?: BjdJointId;
  branch?: PoseBranchId;
  dof: 'none' | 'translate' | 'rotate' | 'both';
  locked: boolean;
}
```

交互优先级固定为：

1. 控制器命中。
2. 身体分件命中。
3. 通过父节点映射到关节。
4. 点击空白取消选中并关闭上下文工具。

默认模式为平移。点击“旋转”后切换为旋转模式，工具栏根据当前选中部件显示可用操作。

不再把“蓝色控制块、固定末端”作为主操作模型；控制点可以继续作为视觉反馈，但操作入口以“选中模型/关节后直接拖动”为主。

### 2. 复刻 Magic Poser 的移动和旋转逻辑

#### 平移模式

- 点击手腕、脚踝或身体分件后直接拖动。
- 手脚使用现有两段 IK。
- 骨盆、胸部、头部使用现有躯干链解算。
- 所有拖动使用经过目标点、朝向当前相机的交互平面。
- 鼠标按下后立即开始操作，不需要先点击一次再点击控制轴。
- 保持骨骼长度，不允许拉伸。
- 超出可达范围时将目标夹到最大距离，并显示关节限制反馈。

#### 旋转模式

- 普通球关节使用屏幕空间旋转控制。
- 肘、膝、手指中节和末节只允许 rig 中定义的铰链轴。
- 旋转值统一经过 `axisBasis` 和 `jointLimits` 限制。
- 内圈负责摆动，外圈负责沿骨骼轴扭转。
- 当前选中部件高亮，其他可选关节降低视觉优先级，减少误选。

#### 拖动状态机

继续使用窗口级 `pointermove/pointerup`、`setPointerCapture`、`lostpointercapture` 和 `blur` 收尾，保证：

- 按住左键可以持续拖动。
- 鼠标移出小控制点后仍然跟随。
- 鼠标移出画布后仍然跟随。
- 切换移动/旋转模式时自动结束旧拖动。
- 相机在姿势拖动期间完全禁用。

### 3. 手部和手指操作

增加 Magic Poser 风格的手部模式：

- 选中左手或右手后进入对应手部上下文。
- 提供左手/右手切换。
- 移动模式下拖动五个指尖。
- 使用三段 CCD IK 调整整根手指。
- 旋转模式下显示指根、中节、末节控制环。
- 手指关节仍受 `jointLimits` 限制。
- 提供当前手指、当前手部和全身重置。

现有手部放大视口继续保留，但改成手部模式的一部分，而不是独立的隐藏功能。

### 4. 锁定语义

按照你的选择，只复刻 Magic Poser 的“锁定对象”语义：

- 锁定当前选中的身体分支或关节。
- 被锁定内容不可选中、不可拖动、不可旋转。
- 锁定状态在界面中显示。
- 解锁后恢复编辑。
- 不再把“固定末端”作为新的用户操作入口。

数据层增加可选的锁定字段，例如：

```ts
lockedBranches?: Partial<Record<PoseBranchId, boolean>>;
```

旧姿势没有该字段时默认全部解锁。旧版本已经存在的 `ikState.pinned` 继续允许解析，以保证历史文件不损坏，但新界面不再创建或显示该功能。

### 5. 工具栏和界面

在 [PoseStudio.tsx](D:/Code/PureRefLike/src/pose/components/PoseStudio.tsx) 中增加 Magic Poser 风格的两层工具：

#### 全局工具

- 预览。
- 撤销。
- 重做。
- 视角。
- 居中人物。
- 正交/透视切换。
- 焦距/FOV 调整。

#### 选中部件工具

- 移动。
- 旋转。
- 锁定/解锁。
- 重置当前关节。
- 重置当前部位。
- 手部模式。
- 身体姿势预设。

现有左侧姿势预设可以继续保留，但通过选中模型后的上下文按钮进入，避免界面出现两套互相独立的操作入口。

不新增 Magic Poser 的模型、道具、头发、材质库；当前 BJD 的外观、灯光和画幅设置继续保留。

### 6. 相机和预览

相机行为统一为：

- 右键拖动：旋转视角。
- 中键拖动：平移。
- 滚轮：缩放。
- 视角菜单提供左、右、底、顶、正面、背面。
- “居中”对应 Magic Poser 的 `FrameSelected`。
- 透视模式提供 FOV 调整。
- 预览时隐藏所有控制器、辅助线、锁定标记和手部放大框。
- 退出预览后恢复编辑状态。

### 7. 数据和画布集成

继续使用当前数据流：

1. 姿势编辑器内部以 `jointRotations` 作为最终姿势真值。
2. IK 目标、选择状态、模式状态属于运行时临时状态。
3. 应用时生成 PNG。
4. PNG 注册为画布资源。
5. 姿势文档和 PNG 同步写回 `PoseItem`。
6. 继续支持已存在姿势的再次编辑。
7. 不升级现有 Pose Document 版本，只增加可选字段并保持旧数据兼容。
8. PNG 渲染过程中隐藏所有操控 UI。

## 接口调整

`PoseRuntime` 对外增加或统一为：

```ts
setManipulatorMode(mode: 'translate' | 'rotate'): void;
setHandMode(enabled: boolean): void;
toggleSelectedLock(): void;
getSelection(): PoseSelection | undefined;
```

现有 `setEditMode` 可以保留为兼容别名，内部统一映射到 `setManipulatorMode`。

事件回调统一携带选中部件、关节、分支、可用自由度和锁定状态，避免 UI 通过多个零散回调推断当前状态。

## 验证方案

按照“适度测试”执行，不做无关的全量重复测试。

### 单元测试

覆盖：

- 模型表面到关节/分支的选择映射。
- `translate/rotate/both/none` 自由度判断。
- 锁定和解锁状态。
- 两段 IK 最大/最小可达范围。
- 铰链关节限位。
- 手指 CCD。
- 相机六向视图和 FOV。
- 姿势文档旧数据兼容。

### 浏览器人工验证

只验证关键路径：

- 默认正面模型。
- 点击身体分件后出现正确上下文工具。
- 移动模式拖动手脚、骨盆和胸部。
- 旋转模式调整肩、髋、肘、膝和头部。
- 长按拖动并把鼠标移出控制点、画布。
- 手部模式分别调整左右手和五根手指。
- 锁定后无法继续编辑，解锁后恢复。
- 姿势预设、撤销、重做。
- 正面/背面/侧面/顶部视角。
- 预览隐藏控制器。
- 应用到画布后关闭并重新打开，姿势保持一致。

### 工具检查

执行：

- `npm run typecheck:renderer`
- `npm run typecheck:tests`
- `npm exec eslint -- src/pose`
- 仅运行姿势领域相关 Vitest。

## 明确不包含

本阶段不实现：

- Magic Poser 的男女模型库。
- 道具几何体添加、复制、删除。
- 头发资源库。
- 材质资源库和完整换肤逻辑。
- Magic Poser 的原始 WASM 核心。
- Magic Poser 的像素级布局、图标和品牌素材。

实现目标是复刻它的核心操作心智模型和交互反馈，而不是复制其专有代码或完整资产。
