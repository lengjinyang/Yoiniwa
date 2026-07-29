# RefCanvas 性能审查与基准报告

日期：2026-07-26

## 结论

React、Electron 和 WebGL 这组技术栈不是当前性能问题的根因。现有代码已经有 WebGL2 实例化、纹理 atlas、uniform-grid 空间索引、renderer/main/图像子进程分工。主要问题来自实现细节：相机变化曾重建并全量上传实例数据，低倍率仍同时提交缩略图和 tile，框选预览走 React state，atlas 的零引用槽位不能回收；冷导入仍有重复图像解码、主进程整文件哈希/校验和大量派生文件扫描。

本轮按“先测量、再小改”完成了监控、Chrome trace/heap 基准和四项局部修复。没有重写画布架构。

## 测试环境与产物

- Electron 43.2.0 / Chromium 150.0.7871.129。
- ANGLE D3D11，NVIDIA GeForce RTX 3080。
- 窗口 1281×822，DPR 1.25。注意：不是目标验收环境中的普通集显、1920×1080、DPR 1。
- 冷导入素材：程序生成的 100 张独立 3840×2160 JPEG，不读取 `res`。
- 稳态场景：500 个逻辑图片对象；另运行项目现有 2000 对象 stress。
- 修改前：`performance-results/2026-07-26T14-51-30-442Z-before`。
- 最终：`performance-results/2026-07-26T15-11-51-067Z-final4`。
- 每个目录包含 6 份 Chrome DevTools Protocol trace、2 份 heap snapshot、`summary.json` 和 `artifact-analysis.json`。
- `tools/benchmarks/analyze-performance-artifacts.mjs` 可重复提取 renderer 主线程事件、GC、长任务和 heap self-size。

Chrome trace 通过 Electron renderer 的 DevTools Protocol 采集，等价于 Chrome Performance/Memory 的底层数据。它不包含 Electron main 和独立 image worker 的 CPU 调用栈；这些阶段使用应用计数器和墙钟时间补充。

## 修改前的主要瓶颈

### 1. 相机移动仍走场景重建和实例全量上传

修改前 `usePixelRenderer` 每帧构造 `Set(nextCommands.map(...))`，再 `map` 对象展开；WebGL renderer 每帧创建 `Float32Array` 并执行 `bufferData`。这不是 React setState，但仍是主线程高频分配和 GPU buffer 全量上传。

修改后 `renderViewport` 只更新相机 uniform 并绘制已上传的实例 buffer。相机交互期间 `bufferData=0`、`bufferSubData=0`。场景/选区确实变化时才复用增长式 TypedArray 并执行一次 `bufferSubData`。

### 2. 低倍率同时提交缩略图和 tile

大图路径即使 `thumb128/256/1024` 已覆盖屏幕像素，也会继续创建 tile command。500 张总览因此出现 1000 commands、443 次累计纹理上传、约 1.03 秒纹理提交时间和 256MB atlas。

修改后非 `original` LOD 直接使用已经足够清晰的缩略图。稳态为 500 commands、1 个 draw call、1 次 bindTexture、1 个 4096² atlas（64MB）。

### 3. atlas 只减引用，不回收 shelf slot

删除 command 或切换 LOD 后，`TextureEntry.refs` 会降为 0，但页内空间不会复用，直到分配失败才全量 rebuild；旧 `TextureEntry.image` 也继续持有解码对象。修改后识别 ID 删除和同 ID 资源替换，并在 LOD 静置后一次性压缩 atlas；连续 viewport/gesture render 会推迟压缩，避免交互中重传。

### 4. 框选矩形在 pointermove 中 setState

修改前每次框选移动都会 `setSelectionBox`，使整个 `CanvasBoard` React 函数组件重新执行。基准面板显示约 39.7 React renders/s。修改后框选矩形是一个常驻 Konva Rect，pointermove 直接更新节点；场景选择只在 pointerup 提交一次。最终短基准仍记录约 10.9 renders/s，主要来自场景边界/选择提交和面板采样窗口，不再是每个 pointermove 一次。

### 5. 冷导入/高清缓存仍是首要未解决瓶颈

100×4K 冷导入最终 trace 为约 9.85 秒，300 个缩略输出平均约 34.6ms，0 失败。代码仍对每个资源分别生成 128、256、1024 PNG；每个 sharp pipeline 都从压缩原图开始。曾尝试先展开完整 RGBA 再生成 256/1024，结果把同一基准拖慢到约 12.9 秒，已撤销，未把回归留在代码中。

tile worker 也会对不同 tile 分别打开/处理 level 图。main 在读取缓存时使用 `nativeImage.createFromBuffer` 验证，并把 pyramid/tile buffer 重新读回。导入登记还会在 main 中对整文件做同步 SHA-256，然后 sharp metadata；打开项目会把每个 zip asset 完整读入并同步哈希校验。

## 20 项代码审查

| # | 结果 | 证据与说明 |
|---|---|---|
| 1 | 部分 | 普通 pan/wheel 使用 ref+rAF+直接 WebGL/Konva，不逐帧写 React。框选已改为命令式；pen、eraser、color picker 和部分 hover 仍在 pointermove 中使用 React state。 |
| 2 | 部分 | 无 Redux/Zustand。pan/wheel 不逐帧 setState；pen 会复制 points 数组，eraser 会 setState 并调用 history preview；资源每次 onload 会 `setImageEpoch`。 |
| 3 | 已改善 | viewport 帧不再 `map`/对象展开/新 TypedArray。gesture 预览仍会 `commands.map`，render 同步仍创建 active-id Set 和 resolved command 数组。没有渲染帧 JSON 序列化。 |
| 4 | 通过 | buffer/program/shader/VAO 仅初始化或 context restore 创建。texture 在新 atlas 页创建；texSubImage2D 仅资源上传/atlas rebuild。 |
| 5 | 已计数 | 最终 500 稳态：1 draw、1 bindTexture；pan/wheel 0 buffer upload。选区 gesture 仍为每帧一次全实例 bufferSubData。 |
| 6 | 否 | WebGL2 使用 `drawArraysInstanced`，不是每图片一个 draw call。Canvas2D fallback 仍每图片一次 drawImage。 |
| 7 | 部分 | 使用实例化。viewport 不再重传；图片 gesture 仍为全可见 commands 重建和全实例 bufferSubData，没有真正的 shader 选区矩阵。 |
| 8 | 已有 atlas | 最多 4 个 4096² RGBA atlas，shader 最多绑定 4 张；不是独立逐图 bind。没有 texture array；atlas 按 shelf 分配并压缩。 |
| 9 | 部分问题 | 本地路径拖入走 path IPC。clipboard 或无法取得路径时仍 `FileReader.readAsDataURL`；导出仍 `canvas.toDataURL`。 |
| 10 | 部分 | thumbnail/pyramid/tile 在独立 Node 图像进程；renderer 使用 HTMLImage 解码。main 仍同步哈希整 Buffer、sharp metadata、nativeImage 校验；项目打开整 asset buffer+同步哈希。 |
| 11 | 风险存在 | 多图 onload 触发 setImageEpoch 和 texSubImage2D；不是单帧硬性批量，但可在短时间密集提交。最终预热后的 pan/zoom/drag 上传增量为 0。 |
| 12 | 大图已分级 | 大图有 128/256/1024 预览和 512 tile。屏幕总览不再额外上传 tile。小图或显式 original 路径仍可能直接上传原图。 |
| 13 | 有预算但不完整 | GPU 上限 256MB、decoded cache 512MB、derived cache 4GB。decoded 与磁盘有 LRU/trim；atlas 现有延迟压缩，但没有细粒度页内 LRU 或按真实活动字节预算。 |
| 14 | 部分 | renderer destroy/rebuild 会 deleteTexture/buffer/VAO/program；HTMLImage 淘汰时清空 src。当前代码不创建 object URL/ImageBitmap，所以没有相应 revoke/close；TextureEntry 在压缩前会持有 image。 |
| 15 | 是 | SpatialIndex query 决定 renderedItems/render commands；远视口 stress 为 0，近视口 46。选中项会被强制加入 rendered set，因此“全选拖动”有意保留全部选中实例。 |
| 16 | 否（主要路径） | 图片命中、框选、颜色取样先查空间索引。compact group header 仍对所有 group 做 `find`；吸附/部分分组辅助逻辑仍需继续逐项审计。 |
| 17 | 是 | `SpatialIndex` 是 uniform grid，图片、标注、分组各自构建；面板记录 query 时间，最终约 0.03ms。 |
| 18 | 否 | 图片 zIndex 排序在 `useMemo([scene.items])` 中，不是每帧。部分菜单/outline 操作按需排序。 |
| 19 | 部分 | 历史最多 200 个 Scene 引用，Immer 提供结构共享，不是 JSON/structuredClone 全副本；bulk move 会生成新 items 数组和变化对象，200 步仍可能占用较多内存。 |
| 20 | 否 | 自动保存已取消；交互期间不会自动序列化完整项目。手动保存仍 JSON.stringify manifest 并写 zip。 |

## 修改前后基准

以下 before/final 均为单次运行，FPS 由 75Hz 显示器锁定；数值适合定位数量级与验证路径变化，不代表集显验收。

| 指标 | 修改前 | 最终 | 变化 |
|---|---:|---:|---:|
| pan renderer CPU / frame | 1.041ms | 0.053ms | -94.9% |
| zoom renderer CPU / frame | 0.970ms | 0.046ms | -95.2% |
| drag 20 renderer CPU / frame | 0.926ms | 0.415ms | -55.2% |
| box-select renderer CPU / frame | 0.949ms | 0.387ms | -59.2% |
| 500 图 render commands | 1000 | 500 | -50% |
| 稳态 draw / bindTexture | 1 / 4 | 1 / 1 | bind -75% |
| 稳态 atlas 估算 | 256MB | 64MB | -75% |
| pan/zoom/drag 期间纹理上传 | 未单独正确隔离 | 0 / 0 / 0 | 最终达标 |
| pan 期间 bufferData/subData | 1/帧（bufferData） | 0 / 0 | 消除相机全量上传 |
| pan trace MinorGC 总时间 | 233.2ms | 29.7ms | -87.3%（before 同时仍有 100 个 load，存在混杂） |
| box React renders/s | 39.7 | 10.9 | -72.6% |
| 交互帧 p95 | 13.4ms | 13.4ms | 显示器 vsync 上限 |
| 交互 1% low | 74.1 FPS | 74.1 FPS | 显示器 vsync 上限 |
| >50ms renderer 长任务 | 0 | 0 | 均通过 |
| heap snapshot self bytes（重开后） | 14.86MB | 12.78MB | -14.0% |
| renderer private memory | 约 125MB | 约 113MB | -9.6% |
| 手动保存 500 对象/100 assets | 835ms | 634ms | -24.1%，单次结果 |
| 重开项目 | 1180ms | 874ms | -25.9%，单次结果 |
| 100×4K 冷导入 trace | 8.42s | 9.85s | 无收益；约 +17%，单次冷缓存波动/剩余瓶颈 |
| 缩略生成平均 | 31.6ms | 34.6ms | 无收益；现实现保持不变 |

最终 2000 对象现有 stress：WebGL2、1 draw call、renderer p95 0.2ms、wheel/drag p95 13.4ms、1% low 74.1 FPS、交互上传 0。该 fixture 仍是 64×64 SVG data URL，不能替代 4K 导入基准；LOD coverage 仍只有 0.218，现有 stress 没有对此失败。

## Chrome trace 证据

- 修改前 import trace：renderer 主线程 `RunTask` 最大 37.2ms；`Decode Image` 129 次、合计约 83ms；无 >50ms RunTask。
- 修改前 pan trace：752 个 mousemove 的 EventDispatch 合计约 436ms；MinorGC 33 次、合计约 233ms、最大约 22.4ms；trace 中还有 100 个 load，说明旧基准的 pan 与新工作集加载重叠。
- 修改前 zoom trace：751 个 wheel EventDispatch 合计约 472ms，单次最大约 29.3ms。
- 修改前 drag-20 trace：752 个 mousemove EventDispatch 合计约 200ms；MinorGC 约 61ms。
- 最终稳态 pan/zoom/drag 的应用计数器均确认纹理上传 0；pan 的 instance buffer 上传 0。所有四个交互 trace 都没有 >50ms renderer 长任务。
- Heap snapshot 不含 GPU texture/decoded bitmap 的真实外部占用；因此 GPU 以 atlas 尺寸估算，decoded cache 以 naturalWidth×naturalHeight×4 估算。

## 按收益、风险、成本排序的后续计划

| 优先级 | 改造 | 预计收益 | 风险 | 成本 |
|---|---|---|---|---|
| P0 | 给 image worker 加每资源一次的持久 decode/pyramid 会话；从同一 libvips pipeline 输出 128/256/1024 与层级，避免当前三个独立 sharp 输入。不要采用已证实更慢的“先完整 RGBA 展开”方案。 | 冷导入/高清缓存预计 25–50%，减少解码峰值；需在 100×4K 基准验证 | 中高 | 高 |
| P0 | main 的注册哈希改为流式或放到 utility worker；metadata、缓存校验和 zip asset 哈希不在 Electron main 同步处理整 Buffer。 | main 卡顿和峰值内存预计下降 30–70%；总导入时间预计 10–30% | 中 | 中高 |
| P0 | tile worker 按 pyramid level 建立可复用源，不再每 tile 独立 sharp resize/extract；协议直接返回缓存路径/stream，避免 main 读回完整 PNG 和 nativeImage 解码验证。 | 8K 跨 LOD tile 准备预计 2–5×；减少“高清缓存卡住”概率 | 中高 | 高 |
| P1 | 把 compact gesture 变成 shader 选区矩阵/选中标记 buffer，drag/scale/rotate 不再 `commands.map` 或全实例 bufferSubData。 | 500 图 drag 已降约 55%；2000 全选预计再降 50–80% CPU/上传 | 中 | 中高 |
| P1 | pen/eraser/color picker 预览改为 ref + imperative Konva/HUD；eraser 命中按 rAF 合批并一次 transaction 提交。 | 复杂场景标注预计减少 60–90% React 执行 | 中 | 中 |
| P1 | 将图片资源 loader 从“每 command 一个 React 组件 + setImageEpoch”迁出 React，使用批量资源管理器和 createImageBitmap transferable，并显式 close。 | 大批加载 React commit 预计下降 50–80%，decoded 生命周期更可控 | 中高 | 高 |
| P2 | atlas 改可变页尺寸/更细粒度 LRU 或 texture array bank；统计实际活动 texel，而不以整张 4096² 计费。 | 小工作集由当前最低 64MB 降到约 4–16MB | 中 | 中高 |
| P2 | Scene package 打开改为 manifest 先行、asset 按需/流式校验；历史增加字节预算而不是固定 200 步。 | 大项目打开和长会话内存预计下降 20–50% | 中 | 中高 |
| P3 | 将属性、大纲、工具栏拆成 memo 子树并稳定 callback；只在 React Profiler 证明它们仍显著后实施。 | 普通 UI commit 预计 10–30%，对纯 GPU pan 影响很小 | 低 | 中 |

## 验证状态

- `npm run build`：通过。
- `npm test -- --run`：29 files / 116 tests 通过。
- `npm run smoke`：通过。
- `npm run smoke:stress`：通过。
- 开发面板已在本地浏览器验证可见，并显示全部要求指标。
- 未运行 `smoke:real-images`，未读取 `res`；未生成安装包。

## 真实画板双向缩放复查（2026-07-27）

使用根目录 `未命名画板.refcanvas` 只读测试。场景包含 50 个独立资源、70.6MB 压缩数据、约 2.35 亿源像素，最大图片约 1393 万像素。测试从画布中心图片铺满窗口开始，先缩到 50 张全可见，再连续执行 5 轮“全局小图 → 单图铺满 → 全局小图”，每个方向都用真实 `WheelEvent` 驱动。

本轮确认并修复了三个不是技术栈名称能够解释的实际故障：

1. 冷缓存缩略图请求先返回 404、后台再生成，但 renderer 不会在生成完成后重试，导致 `50 total / 0 loaded / 0 draw` 的永久空白。协议现在异步等待 worker 生成并返回结果，renderer 同时渐进请求 128px 预览。
2. 场景包资源首次落盘调用了不存在的 `archiveDirectory()`。已有缓存会掩盖问题，独立 user-data 冷开真实画板则所有资源失败。现在实现按文件 size/mtime 复用的 ZIP directory 读取。
3. GPU command 只包含静置视口的裁剪结果。缩放时相机虽然 60FPS，但视口外图片根本不在 GPU，停止约 270ms 后才补图。现在完整场景保留 fit-all LOD command，当前视口叠加更高 LOD/tile；最近高清视口继续驻留用于反向缩放。

此外增加了 512px LOD；缓存 PNG 校验由 main 线程 `nativeImage` 同步解码改为原子缓存+PNG signature；图片就绪后每帧最多提交两个资源，viewport 手势期间暂停提交；atlas 释放的槽位可复用，不再每次 LOD 替换后定时全量重传。调试输出管道关闭时的 `EPIPE` 也不再触发 Electron main-process 崩溃弹窗。

最终证据：

- 冷缓存基准：`performance-results/2026-07-26T16-11-55-946Z-project-final-cold-prepared`。
- 最终热缓存/LOD 基准：`performance-results/2026-07-26T16-10-56-338Z-project-final-lod-safe`。
- 5 轮双向缩放的放大/缩小 p95 均为 13.4–13.5ms，1% low 为 71.9–74.1 FPS（75Hz 屏幕）。
- 每一轮 `wheelUploadDelta=0`，10 个滚轮方向均无纹理上传；稳态 renderer 长任务为 0。
- GPU command 在缩放过程中保持 86/86 loaded，不再先裁掉其余图片；draw call 为 1。
- 真实场景稳态 GPU 估算 192MB、decoded image 约 93–107MB、renderer private memory 约 133–145MB。
- 冷缓存最低预览工作集约 2.57 秒可用；首次高清/atlas 准备仍记录 71ms/114ms 长任务，但发生在测量交互前。尝试 3072² 小页后因容量压力触发整理并恶化到 124ms/300ms，已回退，未保留回归。
- 交互 LOD 诊断最小值仍为 0.84，来自画面边缘的预览覆盖；中心铺满图片由保留 tile 覆盖。最终 overview 截图和 trace 均保存在上述结果目录。

本轮之后 2000 图 stress 仍为 WebGL2、1 draw call、wheel/全选拖动 p95 13.4ms、1% low 74.1 FPS、交互上传 0；renderer p95 2.6ms，private memory 约 1161MB。`smoke`、复用现有 5173 服务的开发态 smoke、29 files / 116 tests 和生产 build 均通过。

## 真实画板像素级极限缩放复查（2026-07-27）

在上述双向缩放基础上，新增 `npm run smoke:project-zoom:extreme`。该基准把画布中心的 3840×2160 图片放大到 scale 16（源 texel 约覆盖 2.5 个屏幕像素，已能观察源像素级细节），再缩小到 50 张图片全部可见，连续往返 5 轮。测试结束额外保存精确 16× 和全局两端截图，避免只用性能计数器判断视觉正确性。

- 热缓存结果：`performance-results/2026-07-26T16-26-22-421Z-project-extreme-16x-baseline`。
- 全新 user-data 冷缓存结果：`performance-results/2026-07-26T16-28-55-386Z-project-extreme-16x-cold`。
- 冷缓存首次可交互约 2.49 秒；最终 56/56 GPU commands loaded，GPU 估算 128MB、decoded image 约 35MB、renderer private memory 约 88MB。
- 10 个缩放方向的帧时间 p95 均为 13.4–13.5ms，p99 为 13.4–13.5ms，1% low 为 74.1 FPS。
- 每轮放大和缩小的 `wheelUploadDelta`、`postUploadDelta` 均为 0；交互过程中没有前台解码、纹理上传或 command 缺失。
- 约 27.4 秒 Chrome trace 中没有超过 50ms 的 renderer 长任务；1694 个 wheel dispatch 合计约 619.6ms，单次最大约 0.81ms。
- 极限端 LOD coverage 约 0.30 是源图片被有意放大超过自身分辨率的结果；截图确认没有额外降级、白块、闪烁或 tile 接缝。全局端 50 张图片均正常显示。

## 未预热高清缓存期间的往返缩放修复（2026-07-27）

用户实际操作发生在高清 tile 尚未准备完成时，原基准先预热再测，因此遗漏了这一阶段。基准新增 `REFCANVAS_PROJECT_BENCH_SKIP_WARM=1` 冷路径：打开真实画板后立即在 scale 16 与全局视图间往返，每个端点短暂停留 180ms，主动触发 LOD 生成后马上反向缩放。

修复前前四轮分别提交 12、18、20、5 次纹理上传，清晰度随 tile 到达逐级变化。根因包括上一档 GPU tile 立即释放、每个 tile 重复解码完整金字塔层、libvips 多线程与 renderer 争用 CPU，以及视口刚停就上传和预取外围 tile。

修复内容：

- WebGL atlas 在 256MB 预算内保留最近非活动 LOD，仅在新分配确实缺少空间时按 LRU 淘汰；方向反转可直接复用 GPU tile。
- image worker 为每个资源/金字塔层保留一次 RGBA 解码（512MB LRU），后续 512px tile 直接按行裁切，不再逐 tile 完整解码；libvips 单线程且 worker 使用较低系统进程优先级。
- tile 外围预取延迟到视口稳定 1 秒，快速改变 LOD 会取消未开始的预取。
- viewport 手势期间 renderer 不再执行 `syncImages`；停止 750ms 后才逐帧上传，每帧最多一个资源。过期 pending LOD 会在 command 改变时丢弃。

最终全新 user-data 结果位于 `performance-results/2026-07-26T16-46-35-185Z-project-loading-oscillation-final-750ms`：5 轮往返的上传数均为 0，p95 13.4–13.5ms，wheel dispatch 最大约 1.06ms，约 24.2 秒 trace 内无超过 50ms 的 renderer 长任务。连续操作期间维持已有清晰层；停止后再升级，2 秒检查时 56/56 commands loaded、LOD coverage 2.599。2000 图回归仍为 1 draw、交互上传 0、wheel/全选拖动 p95 13.4ms、renderer p95 1.7ms。

## 自动输入与真实滚轮环境统一（2026-07-27）

原项目缩放基准每个 rAF 注入一次固定 `deltaY=14`，事件间隔约 13ms；viewport 的 120ms commit debounce 因此永远不会在缩放中触发。普通鼠标刻度通常为 `delta≈120` 且间隔可能超过 120ms，实际路径会几乎每格提交一次 React Scene。基准现默认仅跑 1 轮，并支持 `REFCANVAS_PROJECT_BENCH_WHEEL_DELTA` 与 `REFCANVAS_PROJECT_BENCH_WHEEL_INTERVAL_MS`，本次用 delta 120、间隔 140ms 的稀疏滚轮模式验证。

viewport commit 静默窗口从 120ms 调整为 450ms；Konva overlay CSS transform 和 group background 重绘按 rAF 合并；生产输入回调不再计算诊断用的完整 stats，启用性能监控时也最多 250ms 更新一次。稀疏基准的最高 React renders/s 从约 40.3 降至 10.0，commands 峰值从 106 降至稳定 56，纹理上传保持 0。

新增正常应用真实输入记录模式 `REFCANVAS_MANUAL_INPUT_RECORD=1`，不启用 smoke 或性能浮层。每段真实 wheel 会记录 delta/deltaMode、事件间隔、handler 时间、rAF 帧时间、React render 数、纹理上传和 LOD，并写入 `performance-results/manual-wheel-latest.json` 及带时间戳副本。使用 Windows 原生滚轮消息的首个验证样本为 46 个 wheel，间隔 p50 146.6ms、p95 160.2ms；handler p95 0.2ms、帧 p95 13.4ms、1% low 74.1 FPS、React render 5 次、纹理上传 0。

## 持久化诊断日志（2026-07-27）

新增主进程/renderer 共用的 JSONL 日志。每次启动生成 session ID，单文件上限 5MB，自动保留 3 份历史。默认记录应用与运行时版本、窗口/renderer 生命周期、未捕获异常与 Promise rejection、renderer error console、进程崩溃/无响应、image worker 退出、资源协议失败、场景打开/保存耗时、高清预热结果、WebGL context loss/restore、tile 失败和真实滚轮性能摘要；不写入图片二进制或完整 Scene 内容。

日志默认位于 Electron user-data 的 `logs/refcanvas.jsonl`。属性面板“性能与缓存”新增“打开日志文件夹”和“复制诊断信息”；后者包含 session ID、日志路径、版本、GPU feature status、系统内存、图像任务队列和缓存状态。renderer 日志通过 preload 批量发送，避免高频 IPC。

新增 `electron/logger.test.ts` 验证主进程与 renderer 记录使用同一 session 且错误结构可序列化。实际独立 user-data smoke 已确认启动、预热、WebGL context restore 和退出记录完整；正常应用打开真实画板记录 `scene.opened`，50 items / 50 assets，约 351ms。最终 30 files / 117 tests 与生产 build 通过。

## 高清 tile 视觉闪烁修复（2026-07-27）

真实输入日志确认闪烁期间没有 WebGL context loss、renderer fallback 或交互期纹理上传，wheel handler p95 约 0.2ms、帧 p95 13.4ms；但手势间歇后 render commands 从 50 增至 67/100/112，旧路径会让同一 LOD 的 tile 按就绪顺序逐块覆盖低清预览，形成明显的块状闪烁。

新增完整 tile-set 门控：资源仍逐个后台解码并预上传到 GPU，但只要当前图片/LOD 的任一可见 tile 未就绪，屏幕就继续绘制完整旧预览；全部就绪后同一帧显示整套 tile。不同图片和不同 LOD 独立门控。Atlas 因空间压力执行 rebuild 时新增 `renderer.webgl.atlas-rebuild` 日志，用于区分 tile 切换和真正的 GPU atlas 整理。新增 3 个原子切换测试；最终 31 files / 120 tests 与生产 build 通过。

## Atlas 闪烁根因修复与缩放范围调整（2026-07-27）

用户正常应用日志最终捕获到直接证据：真实 wheel 会话本身没有 context loss、fallback 或交互期上传，但手势结束后触发 `renderer.webgl.atlas-rebuild`，一次删除并重建 4 张 atlas 页，再重新上传 86 个活动资源。这个全量 GPU 资源替换会短暂移除当前画面，是持续整屏闪烁的实际触发点；仅做 tile-set 原子切换不足以覆盖该路径。

运行期 atlas rebuild 已完全移除。空间不足时先 LRU 淘汰非活动纹理；若仍没有连续槽位，则保留当前 atlas 和当前清晰画面，将新 LOD 上传延期，并记录限频的 `renderer.webgl.atlas-allocation-deferred`。完整 tile-set 门控同时改为检查 WebGL 实际驻留状态，而不是只检查 CPU 解码缓存，因此延期上传不会留下空 tile 或提前撤掉预览。WebGL 回归测试覆盖 4 页填满后的额外分配，确认现有纹理不删除且新资源安全延期。

用户缩放范围不再限制在 0.001–16。交互常量改为 `1e-9–1e9` 的纯数值安全边界；空间索引在极端缩小时不再枚举海量网格，而退化为有界全量相交检查，避免解除缩放限制后卡死。新增超过 16 倍缩放和极端视口裁剪测试。

最终 31 files / 122 tests 与生产 build 通过。修复后在正常可见窗口使用 Windows 原生滚轮完成一轮往返：24 个 wheel，handler p95 0.2ms、帧 p95 13.4ms、React render 9 次、交互纹理上传 0；新 session 未再出现 atlas rebuild、context loss 或 renderer error。程序保持打开供人工复测。

## 旧 tile 闪入与显存满载假死修复（2026-07-27）

用户随后一次真实操作把视口放大到约 48.75 倍。日志显示绘制命令从 50 增长到 119，缩回后仍保留 111；GPU 达到 256MB，并记录 `renderer.webgl.atlas-allocation-deferred`。此后约 29 秒没有新的 renderer 交互记录，用户手动关闭时主进程仍能记录 `app.will-quit`，因此属于 renderer/GPU 队列严重阻塞，而不是进程崩溃。

根因是上一轮为反向缩放保留的最多 16 张图片高清 tile 同时承担了两个互相冲突的职责：既留在 GPU 缓存，又继续加入当前绘制命令。缩回全局后，旧局部 tile 仍覆盖低清预览，形成“其他区域图片突然闪入”；这些旧 tile 还被标记为 active，显存满载后无法 LRU 淘汰。命令变化时，`syncImages` 又可能在一次同步中上传所有 CPU 已解码但 GPU 未驻留的资源，放大了驱动阻塞。

现在缓存驻留与屏幕绘制已经分离：非当前 LOD 的 tile 可以留在 atlas 中等待反向缩放复用，但不进入当前 command，也不会阻止淘汰。`syncImages` 每帧最多上传一个不同纹理；atlas 无空间时停止自动逐帧重试，等待活动集变化。LOD 替换在新纹理成功分配前保留旧纹理映射，避免先撤旧图再因分配失败出现空白或错误槽内容。性能基准自身的 16 倍上限也已移除。

真实画板单轮 50 倍往返结果：`performance-results/2026-07-26T17-17-39-882Z-project-flicker-hang-fix-50x`。放大端和全局端 command 均为 50，GPU 128MB、renderer private memory 约 123MB、交互上传 0、长任务 0、p95 13.4ms；日志没有 atlas allocation、context loss、unresponsive 或 renderer error。最终 31 files / 123 tests 与生产 build 通过。
