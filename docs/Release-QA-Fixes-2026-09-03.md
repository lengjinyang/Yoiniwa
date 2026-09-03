# Release QA 修复与回归记录

日期：2026-09-03。范围：原 [Release QA Report](D:/Code/PureRefLike/docs/Release-QA-Report-2026-09-03.md) 的 QA-001 至 QA-007。用户随后授权“按照这里面的问题修复”。

**7 项均已完成代码修复及针对性回归。** 原报告保留发现时的结果；本记录说明修复后的证据，不把开发构建回归等同于正式安装包发布验收。

运行环境与原报告一致：Windows 11、Tauri 2 / Rust / WebView2 / React / PixiJS 8，`npm run dev`。保存和导入使用实际 Rust 后端，系统文件对话框、图片点击和关闭窗口使用真实 UI；其余组合操作通过运行中应用的业务入口自动化。未替换被验证的业务实现。

## 修复结果

### QA-001 · P1：打开失败后旧工程不能保存

- 修改：[project.rs](D:/Code/PureRefLike/src-tauri/src/project.rs)。在旧版 ZIP 解析与 v4 快照接受阶段校验场景格式、版本及画布参数，校验通过后才允许替换活动会话。无效输入保持旧会话和保存目标。
- 回归：实际打开零倍率工程被拒绝后，旧 session ID 保持不变，新增编辑可普通保存。Rust 回归分别构造无效旧格式和无效 v4 工程，断言旧文件字节、会话不变，随后保存及另存为的新内容可重新读取。
- 结果：通过。证据：[实际打开失败后保存](D:/Code/PureRefLike/.dev-runtime/release-qa-fixes-20260903/invalid-open-result.json)。

### QA-002 · P2：并发导入层级相同，点击选中下层图片

- 修改：[useImageImport.ts](D:/Code/PureRefLike/src/app/hooks/useImageImport.ts:140) 在提交时按当前场景分配新 Z 值，避免使用异步开始时的旧场景；[SceneStore.ts](D:/Code/PureRefLike/src/canvas/scene/SceneStore.ts:37) 对旧工程相同 Z 值按后加入对象优先命中，与渲染顺序一致。
- 回归：3 轮并发双图导入分别得到 `[1,2]`、`[3,4]`、`[5,6]`，命中结果均为最后加入对象。真实鼠标点击选中屏幕上层 QA5；单元回归另外覆盖已有对象 Z=99 的旧闭包并发导入和旧工程重复 Z。
- 结果：通过。证据：[并发状态](D:/Code/PureRefLike/.dev-runtime/release-qa-fixes-20260903/concurrent-result.json)、[真实点击](D:/Code/PureRefLike/.dev-runtime/release-qa-fixes-20260903/concurrent-click-result.json)、[截图](D:/Code/PureRefLike/.dev-runtime/release-qa-fixes-20260903/concurrent-click.png)。

### QA-003 · P2：倍率限制不一致导致图片消失

- 修改：[CanvasConfig.ts](D:/Code/PureRefLike/src/canvas/runtime/CanvasConfig.ts) 与输入逻辑共享原有 `1e-9…1e9` 范围；[SpatialIndex.ts](D:/Code/PureRefLike/src/canvas/scene/SpatialIndex.ts) 在巨大查询区域改为遍历实际对象，避免极小倍率时遍历海量空网格。巨大对象及超过安全整数的坐标也不进入无界网格循环。
- 回归：2 轮各连续缩小 35 次、放大 35 次，约 `0.0075089` 和 `133.1755` 时 Scene / Camera / Pixi 倍率一致，8 张图仍有渲染命令。另实际到达 `1e-9`、`1e9` 后恢复视图，无挂起、非有限值或捕获的运行时异常。单元回归覆盖极大视口、巨大对象和 `1e20` 坐标。
- 结果：通过。证据：[连续缩放](D:/Code/PureRefLike/.dev-runtime/release-qa-fixes-20260903/zoom-limits-result.json)、[极限与恢复](D:/Code/PureRefLike/.dev-runtime/release-qa-fixes-20260903/zoom-extremes-result.json)。极小倍率下对象小于像素是正常几何结果；未据此声称每个对象肉眼可见。
- 测试条件：保留共享输入策略原有的大倍率范围断言。Camera 中原来固定上限 32 的断言更新为共享上限，并继续验证越界钳制与锚点变换；未缩窄支持范围。

### QA-004 · P2：另存为当前文件被自身锁拒绝

- 修改：[project.rs](D:/Code/PureRefLike/src-tauri/src/project.rs:478)。另存为目标等于当前仓库时复用正常提交路径，保留已有文件锁、会话和版本保护。
- 回归：真实 Windows 另存为对话框选中当前中文路径工程，并确认覆盖，返回成功且 dirty=false。Rust 回归验证同路径别名增加提交代数、会话不变；其他占用目标仍被拒绝，释放后可以正常另存为。
- 结果：通过。证据：[当前路径另存为](D:/Code/PureRefLike/.dev-runtime/release-qa-fixes-20260903/save-as-current-result.json)。

### QA-005 · P2：选择损坏图片静默失败

- 修改：[bridge.rs](D:/Code/PureRefLike/src-tauri/src/bridge.rs:72) 的导入结果同时返回成功图片和带路径的失败原因；[useImageImport.ts](D:/Code/PureRefLike/src/app/hooks/useImageImport.ts:229) 显示失败数量和原因，保留成功项；[types.ts](D:/Code/PureRefLike/src/types.ts) 同步 IPC 契约。
- 回归：真实文件选择器同时选择 `normal.png` 和 `corrupt.png`，对象数从 7 到 8，提示“1 个文件导入失败”及解码失败路径。单元回归覆盖全部失败、部分失败和取消；取消不显示失败。
- 结果：通过。证据：[混合导入结果与提示文本](D:/Code/PureRefLike/.dev-runtime/release-qa-fixes-20260903/mixed-import-result.json)。

### QA-006 · P2：遗留调整事务污染下一次 Undo

- 修改：[useSceneHistory.ts](D:/Code/PureRefLike/src/app/hooks/useSceneHistory.ts) 在普通提交、Undo、Redo 前结束活动事务；[useSceneWorkspaceController.ts](D:/Code/PureRefLike/src/app/hooks/useSceneWorkspaceController.ts) 和 [useVisualNotes.ts](D:/Code/PureRefLike/src/app/hooks/useVisualNotes.ts) 在选择变化时结束调整，结束手势也不再依赖仍有选中对象。
- 回归：运行中应用的 6 项断言全部通过，覆盖调整 A → 删除 A → 调整 B → Undo、逐步恢复 A 删除及调整、调整中 Undo / Redo，以及切换 A/B 选择后的历史隔离。复杂工程另执行 50 次 Undo、50 次 Redo、50 轮 Undo/Redo 交替及 Undo 后新操作，四项状态断言均通过。
- 结果：业务入口回归通过。证据：[6 项断言](D:/Code/PureRefLike/.dev-runtime/release-qa-fixes-20260903/history-result.json)、[50 次组合序列](D:/Code/PureRefLike/.dev-runtime/release-qa-fixes-20260903/history50-result.json)、[可重复执行的业务入口脚本](D:/Code/PureRefLike/.dev-runtime/release-qa-fixes-20260903/history-regression.js)。
- 边界：原问题从物理 UI 手势触发的完整路径、真实 Ctrl+Z/Y 键盘链路仍为**未验证**；本轮输入工具的字母键 `KeyboardEvent.code` 限制沿用原报告。未将业务入口测试写成物理按键通过。

### QA-007 · P3：Windows 路径别名重复进入最近列表

- 修改：[paths.rs](D:/Code/PureRefLike/src-tauri/src/paths.rs) 统一路径身份；[state.rs](D:/Code/PureRefLike/src-tauri/src/state.rs) 在读取、新增及移除最近工程时按统一身份比较。工程自身文件锁复用也使用该比较。
- 回归：同一工程依次用反斜杠、大写路径和正斜杠打开，三次完整场景字段值一致，最近记录均为 1 条。Windows 路径别名及扩展路径前缀单元回归通过。
- 结果：通过。证据：[3 种路径打开结果](D:/Code/PureRefLike/.dev-runtime/release-qa-fixes-20260903/persistence-paths-passed.json)。UNC、大小写敏感目录和跨平台路径身份仍为未验证。

## 保存、退出与重启核验

使用中文路径工程副本，包含 509 张图片、3 个组、2 条标注、不同几何变换和层级。通过原生关闭按钮退出，重新 `npm run dev`，加载工程后使用 `assert.deepStrictEqual` 比较关闭前后完整 Scene：**精确一致**。运行时加载命令为 509，SceneStore 一致，`textureError` 为空，捕获的异常列表为空。

证据：[重启断言](D:/Code/PureRefLike/.dev-runtime/release-qa-fixes-20260903/restart-verification.json)、[完整运行时状态](D:/Code/PureRefLike/.dev-runtime/release-qa-fixes-20260903/after-restart-state.json)、[重启后截图](D:/Code/PureRefLike/.dev-runtime/release-qa-fixes-20260903/after-restart.png)。

路径测试最初采用 `JSON.stringify` 字符串比较，因为反序列化后的对象属性顺序不同而失败；逐字段检查无值差异。改为比较所有字段值，保留原始失败输出和 `serializedOrderEqual=false`，没有忽略数值差异或放宽精度。

连续重新打开时诊断字段曾记录 `Upload generation is stale`，随后 509 个加载命令完成、无未处理异常，重启后该字段为空。本记录保留这一取消旧代上传的观测，不将它描述为“全过程没有任何错误文本”，也未确认其造成图片丢失。

## 最少必要验证

| 检查 | 结果 |
| --- | --- |
| Vitest：useImageImport、Camera、SpatialIndex、SceneStore、pointerPolicy | 5 个文件，20 项通过 |
| Rust：release_qa_rejected_open_and_save_as_preserve_session | 1 项通过 |
| Rust：paths::tests | 1 项通过 |
| TypeScript renderer 与 tests 类型检查 | 通过 |
| 本轮涉及的 12 个 TS 文件 ESLint，零 warning 门槛 | 通过 |
| `git diff --check` | 通过 |
| 实际应用启动、上述业务入口及原生 UI 回归 | 结果与边界见各问题 |

没有运行全量测试或正式打包。源码基于已有未提交修改继续修复；对 QA 开始时采集的 236 个源文件哈希核验，本轮仅 16 个既有文件发生预期变化，另新增 `paths.rs`。其余既有修改保留，见 [源码变化清单](D:/Code/PureRefLike/.dev-runtime/release-qa-fixes-20260903/source-delta.json)。

证据目录：[release-qa-fixes-20260903](D:/Code/PureRefLike/.dev-runtime/release-qa-fixes-20260903)。该目录受 Git 忽略，分享时需单独保留。测试应用已正常关闭，只移除了本轮测试工程的最近记录，用户原记录保留，见 [清理结果](D:/Code/PureRefLike/.dev-runtime/release-qa-fixes-20260903/cleanup-result.json)。

## 发布判断的范围

**本轮 7 项修复的针对性验证已完成；正式发布验收尚未完成。** 正式 Release 构建、安装包、干净系统、多显示器 / 混合 DPI、磁盘写入失败与不同保存阶段强制退出、小时级压力，以及原报告列出的其他未覆盖场景，仍为未验证。不能仅根据本次回归将最终发布结论改为 YES。
