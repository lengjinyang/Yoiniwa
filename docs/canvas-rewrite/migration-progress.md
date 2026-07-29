# Canvas Rewrite 迁移进度

| 阶段 | 状态 | 提交 | 验证 |
| --- | --- | --- | --- |
| 基线冻结与全面审计 | 进行中 | `39afdf5` | Legacy smoke 已通过 |
| 1. Pixi Runtime 与 Camera | 未开始 | — | — |
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
