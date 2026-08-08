# Yoiniwa（宵庭）项目完整报告

> 用途：提供给外部模型或工程师进行独立评审和提出建议。  
> 报告依据：2026-08-08 本地工作区当前代码、`README.md`、架构/调试文档、测试与 Git 状态。  
> 注意：本报告描述的是当前工作区快照，不等同于某个已发布版本；工作区中已有未提交修改。

## 1. 项目概述

Yoiniwa（宵庭）是一款 Windows 优先、完全离线的参考图画板，产品定位接近面向绘画工作流的无限画布参考工具。它不是 PureRef 的分支，不使用 PureRef 的名称、素材、快捷键全集或 `.pur` 文件格式。

项目当前版本号为 `0.1.0`，技术栈为：

- Electron 43
- React 19
- TypeScript 5.9
- PixiJS 8
- Vite 8
- Sharp 0.34
- Immer 11
- Vitest 4
- Archiver + Unzipper，用于 `.refcanvas` 工程包
- electron-builder + NSIS，用于 Windows 安装包

项目强调三个方向：

1. 大量、大尺寸参考图在无限画布上的流畅浏览和组织。
2. Windows 无边框、置顶、锁定、穿透等桌面窗口体验。
3. 与 Photoshop 和 Windows Ink 数位板协作，尤其是无焦点取色后立即继续绘画。

## 2. 最高优先级产品不变量

项目最重要且不可破坏的不变量是：

> 在协作模式中从 Yoiniwa 取色后，回到 Photoshop 的第一笔必须能够正常绘画。

这条不变量高于置顶方式、任务栏层级、窗口外观和其他交互优化。任何涉及以下区域的方案都必须首先保护它：

- 协作模式、始终置顶、锁定、鼠标穿透和任务栏层级。
- `WS_EX_NOACTIVATE`、`SetWindowPos`、`setAlwaysOnTop`、焦点和 DWM 状态。
- Windows Ink、Pointer Events、原生输入 Hook 和 Pointer Capture。
- Photoshop COM 同步、颜色提交队列、Alt + 笔尖状态机。

明确禁止的折中包括：

- 通过模拟点击或移动系统光标恢复 Photoshop。
- 注入键盘、Alt 松开或笔输入。
- 在取色松笔或颜色提交期间切换焦点、反复调整 Z 序或刷新非客户区。
- 接受偶发丢失第一笔、任务栏闪烁，或要求用户多画一笔。
- 仅凭自动检查或鼠标模拟宣称数位板问题已完全修复。

对外部评审者的要求：凡是窗口、输入、取色或 Photoshop 桥接建议，都必须逐条说明如何保护这一不变量；没有真实 Windows Ink 数位板证据时，只能称为“代码层面建议”或“候选方案”。

## 3. 当前已实现的用户功能

### 3.1 无限画布与浏览

- 无限画布。
- 以光标为中心缩放。
- 空格、Alt 或中键平移，具体行为会受取色快捷键和协作模式影响。
- 聚焦选中项、适合整个画板、重置缩放。
- 画布即时相机状态与历史提交分离，高频 pointermove/wheel 不直接写 Scene history。

### 3.2 图片导入与资源

- 文件选择导入。
- 拖放导入。
- 剪贴板图片导入。
- URL 图片注册。
- 原图、缩略图、Mip 金字塔和 tile 派生缓存。
- 内容哈希标识资源，工程场景只保留稳定资产记录。
- 源文件丢失后，已嵌入或已缓存资源仍可用于工程恢复。

### 3.3 对象编辑

- 单选、框选、Shift 多选。
- 移动、缩放、旋转、翻转、透明度和锁定。
- 非破坏性裁剪与恢复完整原图。
- 边缘/中心吸附。
- 紧密排列、对齐、分布和统一尺寸。
- 图层顺序调整。
- 复制、剪切、粘贴、复制选中项和删除。
- 200 步撤销/重做。

### 3.4 分组、标注和评论

- 分组框和嵌套分组关系。
- 分组命名、折叠/展开、自动隐藏标题等展示逻辑。
- 视觉标注模式：画笔、箭头、矩形、椭圆和连续橡皮擦。
- 标注颜色、线宽和可见性。
- 图片气泡评论。
- 大纲视图展示图片、标注与分组层级。

### 3.5 导出

- PNG/JPEG 画板导出。
- 选中内容导出。
- 复制合成图到剪贴板。
- 导出路径包含单独 worker，避免主 UI 承担全部合成工作。

### 3.6 桌面窗口行为

- Windows 无边框窗口。
- 始终置顶。
- 窗口透明度。
- 锁定窗口位置。
- 鼠标穿透。
- 全局兜底快捷键退出鼠标穿透。
- 协作模式中使用 Windows 原生窗口层级和输入辅助逻辑。

### 3.7 Photoshop 协作

- 默认按住 `S` 从参考图原始像素取色，也可设置为 `Alt`。
- 取色松开后同步 Photoshop 前景色；失败时复制 HEX。
- 支持将渲染结果或选中分层发送到 Photoshop。
- 支持读取当前 Photoshop 文档信息。
- 支持把完整分层 PSD/PSB 作为版本嵌入 `.refcanvas`。
- 支持在 Photoshop 中打开历史版本。
- 支持将历史版本预览拖入或放入画板。

## 4. 总体架构

### 4.1 进程边界

项目采用标准 Electron 主进程/预加载/渲染进程边界：

1. `electron/main.ts` 是生产入口，加载 `electron/application.ts`。
2. `electron/application.ts` 组装窗口生命周期、图片任务、缓存、持久化、Photoshop 桥接、原生协作输入和 IPC。
3. `electron/preload.cts` 通过 `contextBridge` 暴露 `window.refCanvas`。
4. `src/shared/ipcContracts.ts` 集中约束 IPC 参数和返回类型。
5. React 渲染层不直接使用 Node 文件系统或任意 Electron API。

这一边界总体合理，IPC 契约有类型测试覆盖，适合继续保持。

### 4.2 应用层

`src/App.tsx` 当前仍承担较多职责，包括：

- 工程新建、打开、保存和自动保存。
- Scene history 与 dirty revision。
- 菜单、快捷键、面板和窗口状态。
- Photoshop 操作和版本库 UI。
- 导入、导出和选择相关命令装配。

可复用场景变更逐步下沉到 `src/domain/sceneCommands.ts`，菜单、快捷键和按钮通过 `src/app/AppCommand.ts` 共享命令入口。方向正确，但 `App.tsx` 仍是当前最明显的聚合点。

### 4.3 画布运行时

当前生产环境只有 PixiJS 画布入口，没有 Legacy/V2 双写或双入口：

- `CanvasView` 是 React 与画布的低频 Scene/命令边界。
- `CanvasRuntime` 独立持有 Camera、输入路由、空间索引和帧调度。
- Pixi 渲染器绘制图片、分组、标注、评论与选择层。
- 手势预览和即时 viewport 使用 ref/rAF，不在每次 pointermove 时触发 React Scene 更新。
- 交互事务完成后才提交 Scene history。

这套结构的目标是把高频路径留在命令式 runtime 内，把可持久化语义留在 Scene 中。

### 4.4 Scene 与缓存边界

Scene 是唯一业务真相；以下内容被视为可重建缓存，不写回场景语义：

- GPU texture。
- CPU 解码结果。
- Mip 金字塔。
- Tile。
- 缩略图。

场景格式当前实际使用 `version: 3`，读取逻辑兼容 1、2、3，并迁移到当前格式。现有架构文档仍写“Scene v2”，因此存在文档滞后。

## 5. 图片管线与性能设计

图片管线是项目中工程化程度较高的部分：

- 基于内容哈希的稳定 `assetId`。
- 磁盘 Mip/tile 金字塔。
- Worker 解码和派生缓存生成。
- 纹理请求去重。
- CPU/GPU 按字节 LRU。
- 分帧纹理上传预算。
- 根据可见范围、缩放和 DPR 选择纹理层级。
- 高清升级完成后在帧边界稳定替换，避免中间态闪烁。
- 空间索引减少不可见对象参与命中和渲染计划。
- 缓存格式版本和 Mip 算法版本独立管理。

已有性能/压力入口包括：

- 2,000 对象 stress scene。
- 真实工程缩放往返 benchmark。
- 极端放大 benchmark。
- 冷/热缓存图片管线 benchmark。
- thumbnail fallback、真实图片和 Pixi smoke。
- FPS、CPU 帧耗时、draw call、纹理绑定/上传、缓存、heap、输入频率、React render 和空间查询监控。

需要外部评审重点判断的是：当前复杂度是否已与真实数据规模匹配，还是仍存在可删除的机制；以及缓存、tile、完整纹理三类路径是否有清晰且可证明的状态机。

## 6. 工程持久化

### 6.1 `.refcanvas` 格式

`.refcanvas` 是 ZIP64 工程包，核心内容包括：

- `manifest.json`：Scene、资产记录和 Photoshop 版本元数据。
- `assets/<hash>.<ext>`：画板使用的图片与 Photoshop 版本预览。
- `photoshop-versions/<uuid>.psd|psb`：完整分层历史版本。

工程保存时会：

1. 序列化 Scene，并只保留实际引用的资产。
2. 生成同目录临时包。
3. 新版本 PSD/PSB 从临时捕获文件加入；旧版本从原工程包流式复制。
4. 将原工程重命名为 `.bak`。
5. 将临时包重命名为目标工程。
6. 成功后删除 `.bak`；失败则尝试恢复。

工程读取有 manifest、资源数量、单项大小、总大小、路径、资源哈希等校验，降低损坏包和 ZIP 解压滥用风险。

### 6.2 保存队列与 dirty revision

主进程通过 recovering persistence queue 串行化保存操作。renderer 为 Scene 维护 revision：

- 旧 revision 保存完成时，不会把保存期间的新改动误标记为已保存。
- 显式保存有 `saveInFlight` 防重入。
- Photoshop 版本创建和删除也经持久化队列提交。

### 6.3 自动保存的实际状态

这是当前文档与实现的明显不一致：

- `README.md` 和 `docs/DEBUGGING.md` 写“自动保存关闭”。
- 当前 `App.tsx` 实际创建了 `AutosaveCoordinator`。
- dirty Scene 会在 2 秒稳定期后自动保存。
- 自动保存只覆盖已有工程路径；未命名工程不会弹出保存对话框。

因此，“自动保存是否应启用”需要产品层明确决定，并同步代码、设置界面、README、调试文档和测试。

### 6.4 当前持久化风险

1. 工程内嵌多个大 PSD/PSB 后，每次 Scene 保存都需要重建 ZIP 并复制全部历史版本，保存成本随版本库体积线性增长。
2. 自动保存当前也走完整工程重写；如果工程包含大量 PSD/PSB，2 秒防抖仍可能产生较高磁盘写入量。
3. `.bak` 提供单次写入回退，但未看到应用启动时对遗留 `.bak`/`.tmp` 的自动发现、验证和恢复 UI。
4. 工程打开时会确认版本条目存在且声明大小一致，但 PSD/PSB 的 SHA-256 是在真正提取打开时才完整校验。
5. Scene v3 已实际使用，而架构文档还描述 Scene v2。

## 7. Photoshop 版本控制功能

### 7.1 已实现流程

用户可以打开“版本视图”，对当前 Photoshop 文档执行“保存版本”：

1. 读取当前 Photoshop 文档名称。
2. 用户输入版本名称和可选备注。
3. Photoshop 桥接将当前完整文档捕获为 PSD 或 PSB，同时生成 PNG 预览。
4. 主进程计算分层文件字节数和 SHA-256。
5. 版本记录与完整分层文件嵌入当前 `.refcanvas`。

每条版本记录目前包含：

- UUID。
- 用户名称和备注。
- 创建时间。
- Photoshop 文档名称。
- 宽高、色彩模式、位深、图层数。
- PSD/PSB 格式和字节数。
- SHA-256。
- 工程包内路径。
- PNG 预览资产。

版本面板支持：

- 倒序展示版本。
- 显示预览、格式、尺寸、色彩、位深、图层数、体积和时间。
- 在 Photoshop 中打开历史版本。
- 将预览放入画板。
- 删除历史版本。

### 7.2 安全和一致性

- 元数据会规范化并拒绝非法 UUID、非法路径、非法哈希、重复 ID 和异常尺寸。
- archive entry 必须严格匹配 `photoshop-versions/<id>.<format>`，可防止路径逃逸。
- 从工程提取 PSD/PSB 时会流式验证大小和 SHA-256。
- 创建/删除版本会带 Scene revision，避免错误清除较新的 dirty 状态。
- 捕获完成后如果用户已经切换画板，版本不会写入错误工程。

### 7.3 协作模式边界

在协作模式或无焦点取色窗口状态下，读取 Photoshop 文档、创建版本、打开版本和删除版本都会被阻止。相关操作在进入 Photoshop 队列前和队列执行时再次检查。

这个限制应继续保留。不要为了让版本操作“更方便”而在协作模式中激活 Photoshop、改变窗口层级或借助输入注入完成操作。

### 7.4 当前版本控制局限

1. `sha256` 已计算但尚未用于版本内容去重；相同 PSD 连续保存会重复嵌入。
2. 版本记录是平铺数组，没有 `parentVersionId`、分支、标签或状态。
3. 没有保存关联的画板 revision 或 Scene 摘要，无法明确知道某个 Photoshop 版本对应哪一版画板布局。
4. 没有“与上一版本比较”的自动摘要。
5. 删除是物理移除，没有版本回收站或软删除。
6. 没有自动命名规则，例如 `v001`、`v002`。
7. 没有容量上限、保留策略或版本库健康检查 UI。
8. 每次添加/删除版本都重写整个 `.refcanvas`。
9. “在 PS 打开”本质上是提取到临时目录后作为文档打开；它不覆盖当前文档，这是较安全的行为，但 UI 可以更明确说明。

## 8. Photoshop 取色、窗口与原生输入

这是项目风险最高的部分。

当前实现组合了：

- Electron `BrowserWindow` 状态。
- `setAlwaysOnTop` 和 `setIgnoreMouseEvents`。
- PowerShell/C# 原生辅助代码。
- `WS_EX_NOACTIVATE`。
- `SetWindowPos`。
- 任务栏后方窗口层级。
- 低级鼠标/笔输入处理。
- Windows Ink Pointer Events。
- 原生 pointer 数据转发到 renderer。
- React/Pixi 侧取色状态机和 Pointer Capture。
- Photoshop 颜色提交队列。

已有若干保护设计：

- 协作手势进行中不重新排列窗口层级。
- 进入/退出协作模式使用明确 transition，并在失败时回滚。
- 协作模式下禁用会冲突的窗口设置。
- 全局快捷键可退出协作/穿透状态。
- Photoshop 文档操作在协作模式中被阻断。
- 针对 Windows Ink 的 `button=-1`、短暂 `buttons=0`、pointer cancel 等行为有状态机和测试。

自动测试仍无法替代真实数位板验证。建议任何外部方案先给出状态转换表和失败回滚逻辑，再讨论实现。

## 9. 撤销/重做与编辑事务

`useSceneHistory` 维护：

- 当前 Scene。
- 最多 200 个过去状态。
- redo 栈。
- revision 与 saved revision。
- project epoch，用于新建/打开工程后重置跨工程 UI 状态。
- viewport flush，用于在保存前提交即时相机位置。

当前策略是完整 Scene 快照历史，而不是命令日志或持久化事件溯源。由于图片二进制不直接存在每个 Scene 快照中，成本主要来自对象/元数据结构；但在 2,000+ 对象和复杂标注下仍需要关注内存和 Immer 复制成本。

值得评审的问题：是否继续保持简单可靠的 200 步快照，还是改成事务 patch；如果改成 patch，必须证明不会破坏 viewport、分组、裁剪、标注和 dirty revision 的一致性。

## 10. 测试、质量门禁与诊断

### 10.1 静态与自动检查

标准质量命令为：

```powershell
npm run check
npm run build
npm run smoke
npm run smoke:stress
```

`npm run check` 包含：

- renderer TypeScript 检查。
- Electron TypeScript 检查。
- ESLint，零 warning。
- Knip 死代码检查。
- Vitest 单元/集成测试。

### 10.2 已有测试领域

当前测试覆盖至少包括：

- Scene 命令、布局、分组和视觉标注。
- 画布 Camera、空间索引、选择和变换。
- 颜色采样与 Windows Ink 取色状态机。
- 图片资源选择、Mip、缓存、tile 和 LRU。
- 工程序列化、迁移、场景包、资产校验和版本提取。
- dirty revision 与自动保存协调。
- IPC 契约。
- 日志和缓存清理。
- smoke、stress、真实图片与 Photoshop fake bridge。

### 10.3 诊断

- JSONL 日志位于 Electron `userData/logs`。
- 单日志 5 MB，保留 3 份轮转备份。
- 应用内诊断可打开日志目录或复制 session/GPU/图片任务等信息。
- 性能面板提供 FPS、帧 CPU、draw call、纹理上传、缓存、heap、输入频率和空间查询等数据。

## 11. 当前仓库状态

检查时：

- 当前版本：`0.1.0`。
- `src` 与 `electron` 合计约 178 个源文件。
- 最近提交集中在 Pixi 画布迁移、工程持久化、Photoshop 交互、协作快捷键和版本功能。
- 工作区并非 clean；已有未提交修改位于：
  - `src/App.tsx`
  - `src/canvas/CanvasView.tsx`
  - `src/canvas/renderer/PixiRenderer.ts`
  - `src/canvas/runtime/CanvasRuntime.ts`
  - `src/canvas/selection/SelectionController.ts`
  - `src/canvas/selection/SelectionOverlay.ts`
  - `src/exportScene.ts`
  - `src/workers/exportScene.worker.ts`

这些修改不应被外部评审者假定为已完成、已测试或属于某个提交。本报告也没有改动这些文件。

## 12. 已识别的主要优势

1. 产品核心约束非常明确，尤其是 Photoshop 第一笔不变量。
2. Scene 语义和派生缓存边界清晰。
3. Pixi Runtime 已成为单一生产画布，避免双后端长期分叉。
4. 图片管线有稳定纹理替换、LRU、上传预算和真实工程 benchmark。
5. Electron IPC 有集中契约，preload 边界较克制。
6. 工程包采用临时文件、备份和原子重命名思路。
7. Photoshop 版本文件有 SHA-256、大小和路径安全校验。
8. dirty revision 能处理“保存期间又有新修改”的竞态。
9. 原生协作输入对进入/退出失败有回滚意识。
10. 自动检查、smoke、stress、诊断和性能观测已经形成体系。

## 13. 已识别的主要风险和技术债

### P0：必须保护

1. Photoshop 取色后的真实数位板第一笔，仍需每次相关改动后实机回归。
2. 原生窗口层级、输入 Hook、Electron 状态和 renderer 状态共同构成跨层状态机，修改局部代码可能产生系统级副作用。
3. 协作模式相关逻辑分布在 React、主进程、PowerShell/C# 和 Pixi 输入控制器中，契约若不明确容易发生时序回归。

### P1：高价值改进

1. 大型 `.refcanvas` 中嵌入多个 PSD/PSB 后，普通保存和自动保存的全包重写成本。
2. Photoshop 版本内容未按 SHA-256 去重。
3. 遗留 `.bak`/`.tmp` 缺少可见的启动恢复流程。
4. 文档与代码在自动保存、Scene 版本号方面不一致。
5. `App.tsx` 仍连接过多领域，后续功能容易扩大耦合。

### P2：中期演进

1. Photoshop 版本缺少谱系、画板 revision 和差异摘要。
2. 版本删除不可恢复，缺少容量与保留策略。
3. 200 步完整 Scene 快照在超大工程中的内存成本需要量化。
4. 工程格式迁移规则需要一份面向长期兼容的正式规范。
5. Windows 原生 helper 通过 PowerShell/C# 承载复杂输入逻辑，部署、安全软件兼容和可调试性需要长期评估。

## 14. 建议的近期优先级

### 第一阶段：建立基线，不改变高风险行为

1. 固化真实 Windows Ink 数位板回归清单和机型/驱动记录。
2. 修正文档中的自动保存和 Scene v3 描述。
3. 为版本库建立体积、保存耗时和磁盘写入 benchmark。
4. 增加 `.bak`/`.tmp` 恢复测试和可见恢复流程。
5. 给 Photoshop 版本增加完整性检查入口，不改变协作输入路径。

### 第二阶段：解决版本库扩张

1. 利用现有 SHA-256 对 PSD/PSB 内容寻址和去重。
2. 评估单文件可移植模式与日常增量存储模式的产品取舍。
3. 若继续单文件，设计可取消的保存进度和磁盘空间预检。
4. 增加容量统计、重复内容提示和保留策略。

### 第三阶段：改善版本体验

1. 自动递增版本名称。
2. 增加 parent、标签、画板 revision 和 Scene 摘要。
3. 增加版本差异摘要，但不要把“打开历史版本”改成静默覆盖当前 Photoshop 文档。
4. 增加软删除或安全恢复设计。

### 第四阶段：降低架构耦合

1. 把项目生命周期与 Photoshop 版本编排从 `App.tsx` 提取为明确 controller/hook。
2. 为协作模式建立跨进程状态图、IPC 不变量和错误码。
3. 保持 Scene command、CanvasRuntime 和 Electron service 的单向依赖。
4. 仅在有基准数据支持时优化撤销历史或缓存路径。

## 15. 希望外部模型重点回答的问题

请不要只给通用建议；尽量针对下面问题给出可执行方案、迁移步骤、失败模式和验证方式。

1. 在保持 `.refcanvas` 可移植性的前提下，如何避免每次保存重写全部 PSD/PSB？
2. 应继续使用单 ZIP 工程包，还是采用目录/SQLite/内容寻址旁车仓库，并提供“导出为单文件”？请比较崩溃恢复、性能、迁移和用户心智成本。
3. 如何利用现有 SHA-256 对 Photoshop 版本去重，同时允许用户为相同内容保存多个命名节点？
4. `.bak`、`.tmp` 和目标工程同时存在时，应采用怎样的验证与恢复决策表？
5. 2 秒防抖自动保存面对数 GB 工程是否合理？建议的触发策略、退避、取消和 UI 状态是什么？
6. Photoshop 版本记录应增加哪些字段，才能支持谱系、分支、画板关联和未来迁移，又不会过度设计？
7. 200 步完整 Scene 快照是否足够稳妥？在什么量级下才值得改为 Immer patches 或命令日志？
8. `App.tsx` 的职责应如何分拆，才能减少耦合而不进行高风险大重构？
9. 如何为 Windows 原生协作输入建立可验证的状态机模型，同时承认自动化无法替代真实数位板？
10. 当前图片管线中哪些机制最可能重复或过度复杂？需要哪些数据才能安全删减？
11. 哪些安全校验仍缺失，特别是 ZIP、PSD/PSB 提取、临时文件、IPC 输入和 URL 图片导入？
12. 如果只能选择未来四周的三个改进，应该选哪三个？请给出收益、风险和验收标准。

## 16. 对外部建议的约束格式

为了便于判断建议质量，希望外部模型按以下结构回答：

1. **观察到的事实**：引用本报告中的具体实现，而非猜测。
2. **建议**：说明目标和最小改动范围。
3. **失败模式**：列出磁盘损坏、保存竞态、焦点变化、Windows Ink 丢笔等风险。
4. **迁移与兼容**：说明旧 `.refcanvas` 如何读取、升级和回滚。
5. **验证**：区分单元测试、集成测试、性能 benchmark 与真实数位板实机验证。
6. **优先级**：标为 P0/P1/P2，并说明不做的成本。

特别要求：任何涉及协作模式、焦点、窗口层级、Pointer、Windows Ink 或 Photoshop 自动化的建议，必须明确回答“为什么不会破坏取色后 Photoshop 第一笔正常绘画”。无法证明时，应标记为实验性方案，不能直接作为修复结论。

## 17. 一句话总结

Yoiniwa 已经从基础参考图工具演进为具备高性能图片管线、Windows 原生协作输入和 Photoshop 分层版本库的专用绘画辅助应用；当前最需要解决的不是继续堆叠功能，而是保护数位板第一笔不变量、消除文档与实现偏差，并让工程持久化和 Photoshop 版本库在大文件规模下仍然可恢复、可验证、可扩展。
