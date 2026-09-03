# Release QA Report

> 后续记录：用户授权修复后，QA-001 至 QA-007 的代码变更及针对性回归见 [Release QA 修复与回归记录](D:/Code/PureRefLike/docs/Release-QA-Fixes-2026-09-03.md)。以下保留修复前的发现和当时发布判断。

**当前是否建议发布：NO。**

本轮记录 **1 个 P1、5 个 P2、1 个 P3**。其中 QA-006 的业务入口复现成立，但真实 UI 手势触发路径尚未验证。没有确认 P0；这不代表所有数据丢失场景已经排除。

最明确的发布阻断项：打开一个能被后端读取、但被前端校验拒绝的工程后，原画板虽然仍显示，普通保存和另存为都会失败。此时继续编辑的内容无法通过这两个入口保存。

测试日期：2026-09-03，主要执行时段为北京时间 14:21–14:32、15:38–16:11，报告与证据校验完成于 16:17。中间暂停不计入连续运行时间。

## 测试对象与证据口径

- 版本：Yoiniwa 0.2.1；HEAD `e7de3c2af88c44b637d2012edf8fbd6fdff7add1`，加测试开始前已有的工作区修改。
- 实际架构：**Tauri 2 / Rust / WebView2 / React / PixiJS 8**。本项目不是 Electron；IPC 专项检查针对实际 Tauri bridge 和工程服务。
- 启动方式：`npm run dev`，真实运行 `src-tauri/target/debug/yoiniwa.exe`。**正式安装包、Release 优化构建、干净系统首次安装均未验证。**
- 环境：Windows 11 专业版，Build 26200；i5-13600KF，32 GB 内存，RTX 3080；2560×1440，约 75 Hz，当前缩放因子 1.25。
- UI 操作：真实 Windows 窗口、系统文件选择/保存对话框、鼠标点击/拖动/滚轮、窗口关闭和最大化/最小化/恢复。
- 自动化：通过仅本机开放的 WebView2 调试入口读取 React、SceneStore、Camera、渲染诊断值，并调用**正在运行的应用业务入口和真实 Rust 后端**。没有替换保存、导入、History 或渲染实现。
- 工具限制：本轮输入工具发送部分字母组合键时，`KeyboardEvent.code` 为空。Ctrl+Z/Y 的物理按键链路因此不能判为通过；Undo/Redo 的结果来自实际 History 入口自动化。文件选择器输入长串多路径也出现工具输入限制，该次尝试没有计作 10 图通过。
- `storeMatches` 比较 React Scene 与运行时 SceneStore 的对象 ID、位置、尺寸、旋转和 Z 值。它**不等同于逐个检查所有 Pixi Sprite 的像素输出**；画面另以真实 UI 截图检查。
- 本轮没有修复问题、修改产品源码、修改既有测试或降低断言。开始时已有的 20 个已修改文件、5 个未跟踪文件均保留；采集的 **236 个源文件哈希无变化**，见 [source-integrity.json](D:/Code/PureRefLike/.dev-runtime/release-qa-20260903/source-integrity.json)。

证据目录：[release-qa-20260903](D:/Code/PureRefLike/.dev-runtime/release-qa-20260903)。该目录受 Git 忽略，包含测试脚本、输入文件、工程副本、JSON 状态和截图；分享报告时需一并保留。以下“调用路径”根据源码定位，不冒充捕获到的异常调用栈。

## P0 阻止上线

**本轮未确认 P0。** 已验证的损坏快照、截断尾部和一次强制退出均未使最后一个完整提交无法读取。磁盘断电、文件系统故障、所有提交阶段的中断和全新缓存恢复仍未验证。

## P1 上线前必须修

### QA-001：打开失败后，原工程失去可保存的后端会话

**严重程度：P1。稳定性：业务入口 3/3；另存为救援失败经真实 Windows 对话框验证 1/1。**

**复现步骤**

1. 打开并保存一个正常工程，本轮使用含 509 张图片、3 个组、2 个标注的工程。
2. 打开 [invalid-camera.refcanvas](D:/Code/PureRefLike/.dev-runtime/release-qa-20260903/invalid-camera.refcanvas)。它是包含 `manifest.json` 的 ZIP 工程，格式和结构可被 Rust 读取，但 `viewport.scale = 0`。
3. 应用提示无法打开，画面仍保留原工程。
4. 移动原工程的一张图片，再保存。
5. 尝试另存为一个全新路径，例如 `尝试挽救.yoi`。

**预期结果**：无效工程被拒绝后，原工程的显示、会话、保存目标和写入权限保持一致；原工程仍可保存或另存为。

**实际结果**：普通保存和另存为都失败，提示 `保存失败：画板会话已切换，请重新打开后保存`。前端保留旧画板，后端已经切换到被前端拒绝的新工程会话。新增编辑留在内存中，测试未观察到原有正常工程文件被破坏。

**影响范围**：前后端校验结果不一致的工程输入；当前会话中的保存、另存为和后续编辑持久化。重新打开旧文件可以恢复编辑能力，但不能据此声称未保存的新编辑已获救。

**相关模块 / 文件**：

- [project.rs:402](D:/Code/PureRefLike/src-tauri/src/project.rs:402)：`open_legacy` 在返回结果前替换 `self.current`；`open_v4` 也有先设置会话的路径。
- [useProjectLifecycle.ts:213](D:/Code/PureRefLike/src/app/hooks/useProjectLifecycle.ts:213)：`openNow` 在前端 `loadProjectScene` 成功后才更新前端 session ID。
- [ProjectLoader.ts:5](D:/Code/PureRefLike/src/persistence/ProjectLoader.ts:5)：拒绝非正数 Camera scale。
- [project.rs:431](D:/Code/PureRefLike/src-tauri/src/project.rs:431)、[project.rs:478](D:/Code/PureRefLike/src-tauri/src/project.rs:478)：保存与另存为拒绝旧 session ID。

**可能原因**：打开操作缺少完整校验后再切换会话的边界，也缺少前端校验失败时的后端回滚。

**日志 / 异常 / 调用路径**：`project.open → Rust open_legacy → current 切换 → loadProjectScene 拒绝 → 保存 session mismatch`。没有捕获到未处理异常栈；失败以返回错误和 UI 提示呈现。

**证据**：[三次复现之一](D:/Code/PureRefLike/.dev-runtime/release-qa-20260903/malformed-camera-open-result3.json)、[另存为失败](D:/Code/PureRefLike/.dev-runtime/release-qa-20260903/invalid-open-saveas-result.json)、[UI 截图](D:/Code/PureRefLike/.dev-runtime/release-qa-20260903/invalid-open-save-error.png)、[复现脚本](D:/Code/PureRefLike/.dev-runtime/release-qa-20260903/malformed-camera-open.js)。

**建议验证方法**：对零倍率、非法对象尺寸、非法引用等分别触发打开失败；逐次验证旧会话 ID、文件锁、普通保存、另存为、自动保存以及重启后的内容。必须断言打开失败后新增的编辑仍可保存并重新读出，不能只断言旧画面还在。

## P2 建议上线前修

### QA-002：并发导入产生相同 Z 值，点击选中被上层图片遮住的对象

**严重程度：P2。稳定性：并发业务入口 3/3；真实鼠标点击确认 1/1。**

**复现步骤**

1. 在同一画板、同一落点，重叠启动两个导入任务，分别导入 `qa-004.png` 和 `qa-005.png`，不做排布。
2. 等待两批图片导入完成。
3. 点击最上层可见图片。本轮最后一组最上层显示紫色的“QA 4”。
4. 读取选中的对象及 `imageAtPoint` 返回值。

**预期结果**：导入顺序对应明确的层级；可见最上层对象应与点击选中的对象一致。

**实际结果**：每轮新增图片成对共享 Z 值，三轮分别为 3、5、7。最后一轮显示 QA 4，但实际选中 `qa-005.png`，`imageAtPoint` 也返回 QA 5。

**影响范围**：重叠的异步导入任务；后续移动、编辑和删除可能作用于用户看不到的下层图片。没有把普通顺序重复导入判为错误：顺序删除后再导入的对照用例没有产生此问题。

**相关模块 / 文件**：[useImageImport.ts:108](D:/Code/PureRefLike/src/app/hooks/useImageImport.ts:108)、[useImageImport.ts:144](D:/Code/PureRefLike/src/app/hooks/useImageImport.ts:144)、[SceneStore.ts:31](D:/Code/PureRefLike/src/canvas/scene/SceneStore.ts:31)。

**可能原因**：异步流程使用闭包里的 `scene.items.length` 分配 Z 值，再向更新后的 Scene 追加对象；命中逻辑只在 Z 值严格更大时替换候选，而显示层对相同 Z 值保留插入顺序。

**日志 / 异常 / 调用路径**：没有未处理异常；这是排序和命中逻辑分歧。证据中同时记录了对象 ID、名称、Z 值和鼠标点击后的选择。

**证据**：[三轮并发结果](D:/Code/PureRefLike/.dev-runtime/release-qa-20260903/concurrent-import-result.json)、[真实点击选中 QA 5](D:/Code/PureRefLike/.dev-runtime/release-qa-20260903/concurrent-native-click.json)、[画面显示 QA 4](D:/Code/PureRefLike/.dev-runtime/release-qa-20260903/concurrent-import-topmost.png)。

**建议验证方法**：交叠启动文件导入、拖入和粘贴，在相同落点连续导入；比较最终渲染顺序、点击命中、删除对象和保存后重开的顺序，不能只检查图片数量。

### QA-003：缩放命令与运行时倍率限制不一致，连续放大后图片消失

**严重程度：P2。稳定性：普通 1.15 倍步进的上下界序列 2/2；从居中可见图片开始的补充放大复现 1/1。**

**复现步骤**

1. 导入一张 320×240 图片，适应画布并恢复 100% 显示，使图片在窗口中心可见。
2. 连续执行 35 次应用“放大”命令，每次倍率为 1.15；本轮调用与快捷键绑定相同的 `workspace.zoomBy` 入口。
3. 对照 Scene viewport、live viewport、运行时 Camera 和可见图片数。
4. 从 100% 开始，连续执行 35 次对应的缩小命令。

**预期结果**：达到倍率边界后各状态使用同一倍率，围绕同一个锚点缩放；继续操作不能让 Scene 与渲染 Camera 分离。

**实际结果**：35 次放大后 Scene scale 为 `133.17552342239196`，Camera scale 被限制为 `32`，居中的图片变为不可见，渲染图片数为 0。35 次缩小后 Scene scale 为 `0.00750888732630175`，Camera scale 为 `0.02`。

**影响范围**：应用缩放命令、相关快捷键业务入口以及 Camera 状态一致性。实际滚轮使用另一条有限制的 Camera 路径；不能把本问题写成“滚轮必然能达到 1e-9”。物理快捷键连续输入链路未验证。

**相关模块 / 文件**：[useSceneViewport.ts:115](D:/Code/PureRefLike/src/app/hooks/useSceneViewport.ts:115)、[pointerPolicy.ts:5](D:/Code/PureRefLike/src/shared/pointerPolicy.ts:5)、[CanvasConfig.ts:2](D:/Code/PureRefLike/src/canvas/runtime/CanvasConfig.ts:2)、[Camera.ts:13](D:/Code/PureRefLike/src/canvas/camera/Camera.ts:13)、[useAppCommands.ts:156](D:/Code/PureRefLike/src/app/hooks/useAppCommands.ts:156)。

**可能原因**：前端命令允许 `1e-9…1e9`，运行时 Camera 允许 `0.02…32`。`Camera.set` 只修正 scale，没有同步重新计算传入的 x/y，也没有把同一个规范化 viewport 返回给上层。

**日志 / 异常 / 调用路径**：无未处理异常；状态快照明确记录了不相等的倍率和 `renderedImages = 0`。

**证据**：[重复步进结果](D:/Code/PureRefLike/.dev-runtime/release-qa-20260903/zoom-limits-result.json)、[从可见图片开始的前后状态](D:/Code/PureRefLike/.dev-runtime/release-qa-20260903/zoom-visible-result.json)、[空画面截图](D:/Code/PureRefLike/.dev-runtime/release-qa-20260903/zoom-limit-blank.png)。

**建议验证方法**：把缩放快捷键、滚轮、适应画布、恢复 100%、保存和重开组合执行；在边界前后断言 Scene、Camera、保存值一致，并检查锚点图片的屏幕中心。低倍率空间索引卡死假设本轮未复现，不作为另一个缺陷报告。

### QA-004：另存为当前工程路径，被自身的文件锁拒绝

**严重程度：P2。稳定性：真实保存对话框 1/1；更多重复次数未验证。**

**复现步骤**

1. 打开已保存的 `测试工程.yoi`。
2. 执行“另存为”，选择当前正在打开的同一路径。
3. 在 Windows 覆盖确认中同意替换。

**预期结果**：识别为当前实例持有的工程，完成明确的覆盖保存，或在提交前给出准确且可执行的说明。

**实际结果**：提示 `保存失败：目标工程已被其他实例写入，请另存为其他文件`。测试时没有第二个应用实例持有目标工程。普通保存可作为绕行方法，已有工程未被本次失败破坏。

**影响范围**：用户在另存为对话框保留默认文件名、主动选择原文件覆盖的流程。

**相关模块 / 文件**：[project.rs:477](D:/Code/PureRefLike/src-tauri/src/project.rs:477)、[project.rs:502](D:/Code/PureRefLike/src-tauri/src/project.rs:502)、[project.rs:1048](D:/Code/PureRefLike/src-tauri/src/project.rs:1048)。

**可能原因**：`save_as_to` 再次获取目标写租约，未复用当前工程的租约；当前进程的有效租约因此被当作其他写入者。

**日志 / 异常 / 调用路径**：`Save As → save_as_to → acquire_lease → 目标已被其他实例写入`；错误返回，没有异常栈。

**证据**：[返回值及提示](D:/Code/PureRefLike/.dev-runtime/release-qa-20260903/save-as-samepath.json)、[错误截图](D:/Code/PureRefLike/.dev-runtime/release-qa-20260903/save-as-current-error.png)。

**建议验证方法**：分别测试当前路径、另一个已有工程、新路径，以及同路径的不同分隔符/大小写形式；区分本进程租约与真实第二实例租约，验证覆盖前后文件可打开。

### QA-005：文件选择器导入损坏图片时静默失败

**严重程度：P2。稳定性：真实文件选择器 1/1；批量有效/损坏混合文件的 UI 提示未验证。**

**复现步骤**

1. 在已有 9 张图片的画板中执行“选择图片/视频”。
2. 在 Windows 打开对话框中选择 [corrupt.png](D:/Code/PureRefLike/.dev-runtime/release-qa-20260903/fixtures/corrupt.png)，文件扩展名为 PNG，但内容不是有效图片。
3. 确认打开，等待导入流程结束。

**预期结果**：明确告知该文件无法解码，保留已有画板内容；批量导入时应能知道哪些文件失败。

**实际结果**：图片数量保持 9，画板没有新增图片，也没有失败提示。相同文件通过 `registerImagePaths` 入口会返回明确的 libvips 解码错误，因此不是文件不存在或测试未选中。

**影响范围**：原生文件选择器中的损坏或不支持内容。混合批次会丢弃错误这一点有代码依据，但本轮没有把混合批次 UI 行为算作已验证。

**相关模块 / 文件**：[bridge.rs:72](D:/Code/PureRefLike/src-tauri/src/bridge.rs:72)、[bridge.rs:84](D:/Code/PureRefLike/src-tauri/src/bridge.rs:84)、[useImageImport.ts:171](D:/Code/PureRefLike/src/app/hooks/useImageImport.ts:171)。

**可能原因**：`images_import` 用 `if let Ok(image)` 忽略逐文件注册错误，返回空数组；后续准备导入入口对空数组直接返回，没有失败信息。

**日志 / 异常 / 调用路径**：独立注册入口返回 `图片无法解码: VipsForeignLoad: … is not a known file format`；空文件另返回 `图片文件大小无效`。文件选择器路径未把对应错误传给用户，没有捕获到未处理异常。

**证据**：[文件选择器操作后状态与界面文本](D:/Code/PureRefLike/.dev-runtime/release-qa-20260903/corrupt-picker-result.json)、[相同文件的后端错误](D:/Code/PureRefLike/.dev-runtime/release-qa-20260903/formats-result.json)。

**建议验证方法**：文件选择器、拖入、粘贴分别测试全失败和部分成功；断言失败文件数、文件名、提示和原画板内容，而不只检查导入 Promise 是否完成。

### QA-006：调整事务中删除选择，下一次 Undo 会复活先前删除的图片

**严重程度：P2，条件性业务入口缺陷。稳定性：业务入口 3/3；真实鼠标/键盘触发整条路径未验证。**

**复现步骤**

1. 选择图片 A，调用实际 `beginSelectedAdjustment`，预览调整 A 的透明度。
2. 在事务未结束时调用实际 `deleteSelected`，再调用 `commitSelectedAdjustment`；此时选择已被清空。
3. 选择图片 B，开始、预览并提交另一次调整。
4. 调用一次 Undo。

**预期结果**：撤销 B 的调整；A 的删除状态应保留，或冲突时明确取消整个调整事务。两个用户操作不能共享旧事务起点。

**实际结果**：A 在 Undo 后复活，数量从 499 回到 500；旧事务起点被带入了 B 的提交。

**影响范围**：可预览的调整事务与删除、选择变更之间的重入。实际菜单中的灰度对比度滑块使用同一组 begin/preview/commit 回调；本轮使用透明度 updater 验证事务机制，不能据此断言普通滑块拖动必然能触发此交错。

**相关模块 / 文件**：[useSceneWorkspaceController.ts:114](D:/Code/PureRefLike/src/app/hooks/useSceneWorkspaceController.ts:114)、[useSceneWorkspaceController.ts:118](D:/Code/PureRefLike/src/app/hooks/useSceneWorkspaceController.ts:118)、[useSceneHistory.ts:75](D:/Code/PureRefLike/src/app/hooks/useSceneHistory.ts:75)、[appMenuEntries.ts:202](D:/Code/PureRefLike/src/app/appMenuEntries.ts:202)、[ContextMenu.tsx:141](D:/Code/PureRefLike/src/app/components/ContextMenu.tsx:141)。

**可能原因**：结束调整被 `selectedIds.length` 条件阻止，`transactionStart` 留存；下一次 begin 不覆盖已有起点，commit 随后将过早的快照压入 History。普通删除和 Undo 也没有处理正在进行的该事务。

**日志 / 异常 / 调用路径**：没有未处理异常；三份结果均记录 `resurrected: true`。这是 History 语义错误，不能因 React/SceneStore 最终一致而视为正确。

**证据**：[第三次复现](D:/Code/PureRefLike/.dev-runtime/release-qa-20260903/transaction-race-result3.json)、[完整调用序列](D:/Code/PureRefLike/.dev-runtime/release-qa-20260903/transaction-race.js)。

**建议验证方法**：优先补真实滑块拖动时 Esc、删除、切换选择、窗口失焦、菜单卸载及 Undo；检查事务总能结束或取消。若 UI 无法产生该交错，应明确记录不可达条件，不能把业务入口复现改写为 UI 已复现。

## P3 后续优化

### QA-007：同一 Windows 工程的不同路径分隔符产生重复最近记录

**严重程度：P3。稳定性：观察到 1 组持续存在的重复记录，重启后仍在；独立重复试验未验证。**

**复现步骤**

1. 通过原生保存对话框保存工程，记录路径为 `D:\Code\PureRefLike\.dev-runtime\release-qa-20260903\测试工程.yoi`。
2. 通过实际打开工程入口，以等价的 `D:/Code/PureRefLike/.dev-runtime/release-qa-20260903/测试工程.yoi` 打开它。
3. 回到空画板的“最近的文件”，并重启后检查。

**预期结果**：同一个实际文件只占一条最近记录。

**实际结果**：出现两个“测试工程”条目，分别保留两种分隔符形式。没有观察到由此造成的文件内容损坏。

**影响范围**：不同入口传入等价 Windows 路径时的最近文件列表。大小写变体是否同样复现未验证。

**相关模块 / 文件**：[state.rs:108](D:/Code/PureRefLike/src-tauri/src/state.rs:108)、[state.rs:114](D:/Code/PureRefLike/src-tauri/src/state.rs:114)。

**可能原因**：加入最近记录时直接比较原始路径字符串，没有按文件系统语义做同一路径识别。

**日志 / 异常 / 调用路径**：无异常栈；持久化状态与真实列表一致地包含重复记录。

**证据**：[最近文件截图](D:/Code/PureRefLike/.dev-runtime/release-qa-20260903/duplicate-recent-paths.png)、[清理前持久化状态](D:/Code/PureRefLike/.dev-runtime/release-qa-20260903/state-after.json)。

**建议验证方法**：对分隔符、盘符大小写、相对/绝对路径、长路径前缀分别重复打开；确认去重和移除使用一致的文件身份规则。

## 已执行的验证及其边界

下表的结论只适用于列出的条件和次数，不代表整个功能获得发布认证。

| 区域 | 实际执行 | 结果 / 证据边界 |
|---|---|---|
| 启动与关闭 | 多次启动当前开发构建；未保存图片时关闭、取消关闭、再次关闭并放弃；正常退出后重新启动 | 实际观察到关闭确认和取消保留内容；没有干净用户目录的首次安装测试 |
| 窗口 | 真实最大化、系统菜单恢复、最小化、激活恢复 | 稳定后画面和 Camera 正常；中间捕获的 Windows 动画叠影未判为渲染 BUG |
| 重复启动 | 调用启动工具后检查进程 | 仍为同一 PID；工具可能仅激活已有应用，不能据此认定第二进程抢占/单实例处理已完整验证 |
| 导入 | 原生选择器单图；实际导入链路 10→100→300→500 个独立图片 | 数量准确，状态比较通过；批量不是 500 次手工对话框操作 |
| 文件输入 | PNG/JPG/WebP/GIF 静态图、1×1、10000×10000、中文/日文/空格/#/&/方括号/emoji、长文件名、重复图片 | 测试文件均完成注册和显示；约 155 字符的长文件名已测，不等于超长路径测试 |
| 伪装与损坏 | PNG 内容使用 `.jpg` 扩展名、损坏 `.png`、零字节 `.jpg` | 伪装扩展名按实际内容成功解码；损坏/空文件的直接注册报错；文件选择器静默失败见 QA-005 |
| 画布与变换 | 真实多图拖动、滚轮；业务入口多图移动/缩放/旋转/Z 顺序 | 常规操作及组合检查未观察到数量丢失；缩放边界失败见 QA-003 |
| 远离原点 | 把图片放到 `(1e9,1e9)`、恢复 100%，再实际鼠标拖动约 `(73,53)` 屏幕像素 | 移动后为 `(1000000072.7999878,1000000052.7999878)`，尺寸保持 320×240；未观察到明显漂移，不推及更远坐标 |
| 组和标注 | 3 个组、中文/日文/emoji 名称；组移动、改变大小、加入/移出图片；真实手绘笔画和箭头；标注样式与删除/撤销 | 已操作并记录；嵌套组所有边界、组与标注完整命中优先级未验证 |
| Undo/Redo | 50 次混合修改→Undo 50→Redo 50，50 轮快速 Undo/Redo 交替，Undo 后新操作 | 对象/组/标注快照精确恢复；新操作清空 Redo；事务交错失败见 QA-006。物理 Ctrl+Z/Y 未验证 |
| 工程往返 | 500 图工程保存再打开；扩充至 509 图、3 组、2 标注后真正退出重启 | 最终 509 图重启前后完整 Scene 比较无差异，无失效组成员或缺失 asset 引用，见 `restart-comparison.json` |
| 路径变化 | 工程复制到中文新目录；500 个测试原图移出原目录；删除测试 WebP 原图后重启打开 | 509 图恢复并完成显示。使用现有资源缓存；**全新机器/空缓存下仅凭工程恢复未验证**。源文件已恢复 |
| 保存冲突 | 保存期间移动图片 | 新编辑保留、dirty 仍为 true，旧保存结果未把新编辑误标成已保存，见 `save-edit-race-result.json` |
| 写入失败 | 把测试工程设为只读，编辑后保存；恢复写权限再保存 | 首次 `拒绝访问。(os error 5)` 且 dirty=true；重试成功且 dirty=false。没有模拟磁盘耗尽 |
| 损坏恢复 | 翻转最新快照字节、截断最新提交尾部、破坏文件头 | 前两者恢复到可读完整版本并提示恢复；无效头被拒绝且原画板保留。不能代替所有损坏组合 |
| 强制退出 | 保存请求未完成时，在文件系统 change 通知后终止测试进程，再重启 | 原提交可重开；当时为随机操作后保存的 505 图、3 组、2 标注，**不是从 509 丢成 505**。前后文件 SHA-256 相同，generation 仍为 13，因此本次没有证明命中了半写阶段 |
| 导入冲突 | 100 图导入中删除已有 10 图；导入中 Undo 已有 10 图；导入中切换新画板 | 前两者最终各为 100 图；切换画板后为 0，旧导入未跨画板写入；三例检查均无悬空/重复 ID 或未处理异常 |
| 随机业务序列 | 固定种子 9032026，130 步，13 种移动/变换/复制/删除/层级/组/标注/撤销组合 | 每步检查有限坐标、唯一 ID、引用和 Store 一致性，通过；不是长时间真实鼠标乱操作测试 |

主要验证证据：[History](D:/Code/PureRefLike/.dev-runtime/release-qa-20260903/history50-result.json)、[重启完整比较](D:/Code/PureRefLike/.dev-runtime/release-qa-20260903/restart-comparison.json)、[重启后截图](D:/Code/PureRefLike/.dev-runtime/release-qa-20260903/complex-after-restart.png)、[随机序列](D:/Code/PureRefLike/.dev-runtime/release-qa-20260903/mixed-operations-result.json)、[导入冲突](D:/Code/PureRefLike/.dev-runtime/release-qa-20260903/import-races-result.json)、[损坏恢复](D:/Code/PureRefLike/.dev-runtime/release-qa-20260903/recovery-result.json)、[强制退出时点](D:/Code/PureRefLike/.dev-runtime/release-qa-20260903/interrupted-save-result.json)。

### 性能与资源观测

测试素材为 500 个不同内容的 320×240 编号图片。以下是单次导入耗时与完成附近的监测样本，不是多轮基准中位数，也不是复杂照片、持续拖动时的帧率保证。

| 总图片数 | 本次新增 | 导入链路耗时 | 监测 FPS | JS Heap | GPU 字节估算 |
|---:|---:|---:|---:|---:|---:|
| 10 | 10 | 357 ms | 未记录用于比较的稳定样本 | — | — |
| 100 | 90 | 1,852 ms | 74.69 | 32.1 MB | 16.1 MB |
| 300 | 200 | 4,088 ms | 74.39 | 35.4 MB | 34.7 MB |
| 500 | 200 | 4,073 ms | 72.29 | 55.9 MB | 44.3 MB |

随后执行 3 轮“导入 500→全删”，每轮删除后等候 2.5 秒：图片数归零，纹理计数均为 520，CPU/GPU 图片缓存估算均为 30,720,000 字节；JS Heap 分别约 38.8、40.4、45.3 MB。这证明本序列里纹理计数没有逐轮增长，**没有证明图片删除即释放全部缓存，更没有证明不存在内存泄漏**。History 和缓存保留也可能影响观察。

FPS 来自应用帧循环监测，GPU 数字来自软件估算；没有测量真实专用显存峰值、进程 CPU 时间曲线、GC 暂停、独立 Worker 数量或完整 Listener/ObjectURL/DisplayObject 存活数。常规样本未捕获未处理 Promise rejection；个别阶段出现 `Canvas texture generation changed` 诊断值，没有确认对应持续黑图，未单独判为缺陷。

证据：[分档导入](D:/Code/PureRefLike/.dev-runtime/release-qa-20260903/batches-result.json)、[资源循环](D:/Code/PureRefLike/.dev-runtime/release-qa-20260903/cycles-result.json)。

### 已有自动化测试

只运行与此次主要风险直接相关的最小集合，没有全量重跑：

```text
npm exec vitest run -- src/app/hooks/useProjectLifecycle.test.ts src/app/hooks/useImageImport.test.ts src/persistence/ProjectPersistence.test.ts src/canvas/runtime/CanvasRuntime.test.ts src/canvas/textures/TextureManager.test.ts src/domain/sceneCommands.test.ts
结果：6 个文件，15 个测试通过。

cargo test --manifest-path src-tauri/Cargo.toml project::tests -- --nocapture
结果：6 个工程相关测试通过，0 failed，0 ignored，其他 21 个不在本次选择范围。
```

Rust 首次尝试被正在运行的应用占用构建 DLL 阻止，关闭应用后重试通过；未更改构建或测试条件。[Rust 日志](D:/Code/PureRefLike/.dev-runtime/release-qa-20260903/rust-project-tests.log)。这些通过结果没有覆盖本报告中的跨前后端会话校验、相同目标另存为、并发 Z 值和缩放边界问题。

另一个精度观察：首次保存/读取比较中，少数几何值变化约 `1e-13`，资源时间戳变化约 `0.000244 ms`；没有确认可见影响或持续累积。该次不能称为“逐字节相等”，但也没有据此判为数据丢失。后续 509 图真实重启比较是零差异，详见 [数值差异记录](D:/Code/PureRefLike/.dev-runtime/release-qa-20260903/roundtrip-differences.json)。

## 最大的 5 个发布风险

1. **打开失败破坏原工程保存会话**：QA-001，用户继续工作的内容无法普通保存或另存为，是本轮 NO 的直接依据。
2. **看到的对象与操作对象不同**：QA-002，可能导致用户误移动、修改或删除遮挡下的图片。
3. **调整事务污染后续 Undo**：QA-006，业务入口会恢复过早状态；真实 UI 可达性需要优先补证。
4. **不同缩放入口让相机状态分离**：QA-003，普通连续命令即可出现图片消失，且持久化与后续交互可能使用不同倍率。
5. **常见另存为覆盖被自身锁阻止**：QA-004，用户明确确认覆盖后仍无法完成保存，且提示把原因归给不存在的其他实例。

## 尚未覆盖的测试区域

以下均为 **未验证**，不能从已有通过项外推：

- 正式安装包、Release 构建、首次安装/升级/卸载、完全空白用户配置、安装路径权限。
- 多个物理显示器、跨 DPI 拖窗、改变系统 DPI、热插拔显示器、远程桌面切换、睡眠恢复。
- 真正同时启动两个独立进程、两进程抢同一工程写锁、外部修改已打开工程。
- Explorer 到应用的完整原生文件拖拽、超过 100 个文件的原生选择器交互、连续系统剪贴板粘贴。
- 动态 GIF/动态 WebP、多帧/ICC/EXIF/CMYK/高位深/透明边缘；BMP；超过现有样本的图片/字节上限；极深目录、超过 MAX_PATH、网络盘、断开的移动盘。
- 全部多选快捷键、真实键盘 Ctrl+Z/Y 50 次、拖动中按 Undo/删除/换选择、触控笔压力、触摸板连续滚动、边缘自动平移的完整矩阵。
- 多层嵌套/循环组输入、组删除与标注锚定的全部组合；所有重叠位置的 Pixi 顺序、命中和选择框逐像素比较。
- 完全清空缓存或换机器后从工程恢复；历史版本所有标注数据迁移；所有资源 Blob 的独立哈希核验。
- Save As 覆盖其他已有工程、保存过程中正常关闭的每个阶段、真正半写时进程终止、断电、磁盘满、设备拔除和长时写锁。
- 导入与保存/打开的全部交错、连续菜单点击、双击/三击、长时间真实随机 UI 输入。
- 数小时/数天运行；500 张超大照片；真实 GPU 显存/CPU 曲线、GC、Worker、事件监听器、ObjectURL 和 Pixi 对象的存活快照。
- 视频、音频、Photoshop 协作、网络图片、更新器和安全输入专项不在本次图片画板主路径验证范围。

## 下一轮最值得继续测试的 10 个场景

1. 无效工程打开后立即继续编辑、自动保存、普通保存和另存为，最后重启逐项核验新增编辑。
2. 原生拖入 + 文件选择器 + 粘贴同时导入重叠图片，真实点击、删除、Undo，再保存重开对照层级。
3. 灰度/透明度滑块拖动时删除、Esc、切换选择和失焦，验证 QA-006 的真实 UI 可达性。
4. 真实键盘连续 Ctrl+Z/Y 50 次及交替输入，包含组删除、多选变换、标注和正在进行的手势。
5. 缩放快捷键与滚轮交替跨上下界，然后导入、拖动、保存和重开，比较唯一 Camera 状态。
6. Save As 当前路径/等价路径/其他已有文件，配合真实第二实例竞争租约。
7. 在快照追加、资源写入、提交头切换和压缩整理阶段分别中断进程；核对每个阶段的最后完整提交。
8. 在独立空缓存用户环境打开移动后的复杂工程，删除所有原图后逐项验证内嵌资源和关联标注。
9. 10→100→300→500 张大分辨率、透明、带色彩配置图片，连续至少 2 小时导入/删除/Undo，采集堆、纹理、监听器和 Worker 存活曲线。
10. 双显示器不同 DPI 下框选、旋转、缩放、跨屏拖窗和睡眠恢复，再执行一次保存/关闭/重开核对。

## 交付与环境收尾

本报告及 QA 证据已生成；未修改产品代码或既有测试。测试应用已关闭。仅对 QA 目录内的工程副本实施破坏性输入和强制退出实验；移动/删除的测试原图已恢复，测试工程的只读属性已恢复。已移除 6 条 QA 最近文件记录，保留原有的 1 条记录；清理前状态已留证。当前测试生成的工程和诊断记录保留供复现。

[最终校验记录](D:/Code/PureRefLike/.dev-runtime/release-qa-20260903/final-verification.json)：236 个采集源文件零变化，报告文件链接有效，强制退出后重开 Scene 与退出前磁盘完整快照零差异。
