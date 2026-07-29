# Canvas Rewrite 验收矩阵

状态：`待迁移 / 进行中 / 已实现 / 已验收 / 不适用`。

| 功能 | 旧实现入口 | 预期行为 | 新实现模块 | 测试方式 | 迁移状态 | 验收状态 |
| --- | --- | --- | --- | --- | --- | --- |
| Runtime 启停/Resize/DPR | CanvasBoard effects | 无泄漏、尺寸正确 | runtime | unit + smoke | 已实现 | unit + Electron smoke 已验收 |
| 平移 | CanvasBoard pointer | 连续、释放不回滚 | camera/interaction | unit + benchmark | 已实现 | unit 已验收；硬件帧基准未测量 |
| 锚点缩放/上下限 | onWheel/interactions | 鼠标世界点不漂移 | camera | unit | 已实现 | 已验收 |
| Fit/Focus/Reset/恢复 | App + CanvasBoard | bounds 与 viewport 正确 | camera commands | unit + smoke | 已实现 | App bridge + build/smoke 已验收 |
| 图片导入/拖放/粘贴 | App IPC | 导入后可见且有进度 | App + runtime adapter | integration | 已实现 | 导入集成 + Electron 真图片 smoke 已验收 |
| 图片比例/EXIF/Alpha | image pipeline | 方向颜色透明正确 | renderer/assets | image smoke | 已实现 | Worker 测试 + 真图片 smoke 已验收 |
| 图片移动 | BoardImage/GPU gesture | 实时预览、一次提交 | transform + command | unit + smoke | 已实现 | unit + production smoke 已验收 |
| 图片缩放/旋转 | Transformer/rotation | 单/多对象正确 | transform | unit + smoke | 已实现 | unit + production smoke 已验收 |
| 裁切/翻转/透明/灰度 | App properties | 非破坏、显示一致 | image renderer | unit + visual | 已实现 | unit/build 已验收；人工视觉复核待发布前 |
| 删除/重复/复制粘贴 | AppCommand | Scene 与资源正确 | commands | unit + integration | 已实现 | 既有 App command 与 Scene 集成测试已验收 |
| 层级顺序 | App moveLayer | 命中和绘制同步 | reorder command | unit | 已实现 | 绘制/命中 zIndex 单元已验收 |
| 锁定/隐藏 | App/Outline | 不命中或不绘制 | scene/hit test | unit | 已实现 | Scene/hit test 单元已验收 |
| 单选/取消 | CanvasBoard | 顶层命中、空白清空 | selection | unit | 已实现 | 已验收 |
| 多选增减/全选 | CanvasBoard/App | 修饰键语义一致 | selection/keyboard | 已实现 | 修饰键选择 + App 全选已验收 |
| 框选/自动平移 | CanvasBoard | 可见相交节点、边缘平移 | box selection | unit + smoke | 已实现 | 单元 + build/smoke 已验收 |
| 重叠命中 | imageIndex/zIndex | 返回最上层可交互节点 | hit test | unit | 已实现 | 已验收 |
| 控制点/多对象变换 | Konva Transformer | bounds、pivot 和锁定正确 | overlay/transform | unit + smoke | 已实现 | unit 已验收；人工视觉复核待发布前 |
| Undo/Redo/合并 | useSceneHistory | 一次手势一条历史 | command stack | unit | 已实现 | 已验收（手势单命令、undo/redo、redo 分支清理） |
| 分组/嵌套/解散 | GroupFrame/App | 成员和 bounds 正确 | groups/commands | unit + smoke | 已实现 | 应用命令保留，Pixi 渲染/拖动已验收 |
| 分组样式/折叠/隐藏/锁定 | GroupFrame/Header | 外观和命中正确 | group renderer | unit + visual | 已实现 | unit/build 已验收，人工 visual 待发布前 |
| 标注四工具/擦除 | AnnotationShape | 绘制、选择、移动、删除 | annotations | unit + smoke | 已实现 | build/smoke 已验收，人工 visual 待发布前 |
| 评论/标签 | App/CommentBubble | 编辑和显示保持 | overlays/App | smoke | 已实现 | 评论 Pixi 渲染；标签由属性/Outline 保留 |
| 取色 | CanvasBoard + Worker | 命中源像素且不阻塞 | picker controller | integration | 已实现 | 异步 Worker IPC 已接入，人工色值验证待发布前 |
| 对齐/分布/统一尺寸 | layout.ts | 结果与旧工程一致 | App commands | existing unit + smoke | 已实现 | 保留的 domain/App command 测试已验收 |
| Pack/吸附/padding | layout/scene.canvas | 设置生效 | layout adapter | unit | 已实现 | 保留 Scene 配置与 App command 已验收 |
| Mip/迟滞 | imageResources | 最小覆盖、切换稳定 | assets/textures | unit | 已实现 | 已验收 |
| Tile/剔除/预加载 | usePixelScenePlan | 只处理工作集 | spatial/assets | unit + benchmark | 已实现 | unit + quick pipeline benchmark 已验收 |
| 稳定纹理/原子切换 | stableRenderCommands | 不空白、不退回低清 | texture manager | unit + image smoke | 已实现 | Electron 真图片 smoke 已验收 |
| CPU/GPU LRU | imageResources/WebGL | 字节预算、Pin、释放 | textures | unit + benchmark | 已实现 | 字节预算/Pin/释放单元 + smoke 已验收 |
| GPU 分帧上传 | WebGL renderer | 4项/8MiB/约2ms | upload scheduler | unit + benchmark | 已实现 | 预算单元 + Electron GPU smoke 已验收 |
| 上下文菜单/快捷键 | App | 命令与 enable 状态一致 | Canvas bridge/App | smoke | 已实现 | 应用 Command registry 保留，Pixi context bridge 已验收 |
| 性能诊断 | CanvasBoard data attrs | 稳定版本化 snapshot | debug | unit + benchmark | 已实现 | Pixi snapshot/dataset + quick benchmark 已验收 |
| 旧工程打开 | scene-packages | 无需重新导入 | persistence adapter | integration | 已实现 | v1→v2 migration/scene package 既有集成已验收 |
| 保存/重开/viewport/zIndex | App/history | 往返无损 | persistence adapter | integration | 已实现 | round-trip 已验收 |
| 自动保存/dirty 边界 | App/history | 高频预览不写历史 | command bridge | integration | 已实现 | latest revision/debounce 单元与 IPC build 已验收 |
| 缺失资源 | protocol/registry | 明确错误、不崩溃 | asset adapter | integration | 已实现 | 缺源 asset round-trip 与资源错误事件已验收 |
| WebGL context loss/销毁 | legacy renderer | 可恢复且释放资源 | runtime/renderer | smoke | 已实现 | 强制 context loss/restore 的 normal smoke 已验收 |
| Legacy 删除 | 全仓库 | 生产源码无 Legacy/V2 路径 | final cleanup | rg + knip | 已实现 | `rg` 无运行时引用，Knip 通过 |

## 最终说明

自动化门禁、生产 bundle 与 Electron GPU smoke 已全部通过。表内保留的“人工视觉复核”只涉及主观像素观感，不代表存在双画布或未迁移实现；Legacy 源码仅能通过 Git tag `canvas-legacy-freeze` 查看。
