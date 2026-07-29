# RefCanvas 图片管线重构

## 审计基线（重构前）

- Electron 入口为 `electron/main.ts`，应用实现集中在 `electron/application.ts`。
- 图片导入在主进程流式复制并计算 SHA-256，原始资源保存到 `asset-cache`；场景节点已经以内容哈希形式的 `assetId` 引用资源。
- `electron/workers/image-worker.ts` 使用独立 Node 子进程和 `sharp` 生成 PNG 缩略图、金字塔层和 512 px 分块。
- 派生资源由 `derived-cache` 的散列键保存，缺少每个 Asset 独立、可校验、原子提交的 Manifest。
- Worker 的 `assetSources` 会保存主进程注册的绝对路径；`imageWorkerAssets` 会保存已经完成的注册 Promise。缓存根迁移后两者可能继续引用旧目录。
- Renderer 使用单一 WebGL2 canvas 和纹理图集，而不是每张图片一个 DOM 节点。上传已有数量/字节/时间预算，但资源缓存、请求 generation 和迁移生命周期仍未形成统一模型。
- 大图已有 512 px tile 和视口 tile 选择；Mip 选择考虑缩放和 DPR，但只按二次幂 pyramid level，资源 URL/缓存键没有统一版本与 generation。
- `src/imageResources.ts` 用 `HTMLImageElement` 做解码缓存并按估算字节回收；在缩略图失败时仍可能在 Renderer 解码原图并用 Canvas 生成应急预览。
- 开发性能面板已有 FPS、帧耗时、可见数、上传调用和缓存统计的一部分，将补齐 CPU/GPU 字节、队列、单帧上传量和当前 Mip。

## 已确认根因

1. 资源身份、源文件位置和派生缓存位置没有完全分离；Worker 注册的是可过期绝对路径。
2. 缓存迁移虽会停止 Worker，但缺少贯穿请求/结果的 generation，迟到结果仍可能进入新状态。
3. 派生项逐个按需生成，工程重开或快速缩放时会重新触发源图解码；不存在导入时完整生成并验证的磁盘金字塔事务。
4. Renderer 的失败兜底会解码完整原图；这是卡顿和内存峰值风险。
5. 当前纹理图集虽有上传节流，CPU/GPU 生命周期、Pin 和逐帧原子替换尚未被独立、可测试的调度器明确表达。

## 目标架构

```text
原始图片
  -> 稳定 AssetRecord / assetId
  -> 版本化 Disk Pyramid（临时目录生成，manifest.json 最后原子提交）
  -> 有字节预算的 CPU Decode Cache
  -> 去重、可取消、带 generation 的 Decode / Upload Scheduler
  -> 有字节预算和帧 Pin 的 GPU Cache
  -> 单一 WebGL2 画布
```

缓存路径只由当前 `cacheRoot`、`assetId`、缓存版本、Mip 和 Tile 坐标解析。Worker 只持有当前 cache root 和 Asset Manifest，不保存派生缓存绝对路径。缓存迁移会暂停队列、推进 generation、关闭 Worker、迁移并验证新目录、重建 Worker 注册，最后才删除旧目录。

## 实施记录

### 第一阶段：审计和埋点

- 保留现有单 WebGL2 canvas、实例化绘制、Uniform Grid 空间索引和 Konva 交互覆盖层。
- 修正渲染计划：只为可见区域和向外 0.75 个视口的预加载环创建图片命令，远距离节点保持纯场景数据。
- F10 开发面板现包含 FPS、CPU 帧耗时、可见/预加载图片、CPU/GPU 字节、解码/上传队列、单帧上传字节、缓存命中率和当前 Mip；生产默认关闭且不逐帧写 Console。
- 真实图片烟测增加最低 LOD 对应命令、驻留尺寸、队列和图集状态，便于定位“预览没有切到 Detail”的问题。

### 第二阶段：资源身份和缓存迁移（P1）

- 新导入的 `AssetRecord` 同时记录稳定内容哈希 `assetId`、源大小/mtime、方向、Alpha、内容 Hash 和缓存格式版本；场景节点仍只保存 `assetId`。
- Manifest 对 contentHash、大小、版本、算法和尺寸做兼容检查；已有 SHA-256 相同时允许不同工程/mtime 复用，同一旧版 path-based 记录仍用 mtime 失效，避免相同 assetId 因来源时间不同互相抖动。
- `image-cache-paths.ts` 是唯一的新金字塔路径解析器。它每次从当前 root 计算路径并拒绝路径穿越，迁移后不会返回旧绝对路径。
- Worker 登记表只保存 `assetId -> 相对源路径`；实际读取时再用当前 Worker `cacheRoot` 解析。输出同样只能使用缓存根下的相对路径。
- 所有请求和结果携带 generation。迁移开始先推进 generation；旧结果即使迟到也会被拒绝。
- `imageWorkerAssets` 已改为 generation-scoped single-flight 注册表。迁移/Worker 退出会清空，失败的旧 Promise 不能删除新注册。
- 队列为待执行和活跃任务创建 `AbortSignal`。Worker 在解码后、每个 Mip/Tile、临时写入后和原子提交前检查取消；Native 运算不能瞬时中止时，其结果仍会被丢弃且不会提交 Manifest。
- 迁移顺序为：暂停新任务、取消待执行任务、停止 Worker、清空注册、复制 source/derived/image-cache、切换 root、动态重算 registry 路径、重建 Worker、逐项注册并验证源文件、验证原先存在的 Manifest、删除旧目录、恢复任务。

### 第三阶段：磁盘 Mip 金字塔和导入进度

- `mip-generator.ts` 在 Node 图片 Worker 中使用 sharp：读取元数据、应用 EXIF `rotate()`、解码、Lanczos3 缩小、WebP 编码、逐文件解码校验、最后写 Manifest，再以目录 rename 原子提交。
- 最长边层级为 128/256/512/1024/2048/4096/8192/16384 加原始边长；不生成超过源图的层级。超过 8192 的层级不写单张 GPU 候选。
- ≥2K 图片同时生成与现有渲染器一致的二次幂 pyramid 和 512 px tile；tile 带统一 1 px gutter。超大图若一次 RGBA 解码会超过 512 MiB，改用 libvips demand-driven 分块管线，避免无预算的大 Buffer。
- 普通和透明图片均使用 WebP（`alphaQuality: 100`）；Manifest 记录格式/Mip 算法版本、源签名、方向、Alpha、尺寸、文件大小和 tile 网格。
- 文件选择导入从流式 Hash/元数据阶段开始显示进度，之后按图片像素权重合并 Worker 的 decode/mip/commit 真实进度。场景只在全部必需层级提交后一次加入。
- `refcanvas-asset` 协议优先读 Manifest 的固定 Mip/Tile；只对旧工程或损坏缓存走兼容生成路径。常规渲染的 `original` 变体也映射到不超过 4096 的持久化 Mip；导出/取色使用显式 `source` 变体。
- Renderer 中“缩略图失败后解码完整原图并用 Canvas 制作预览”的路径已删除。
- 文件拖放直接传本地路径，剪贴板位图由主进程接收，不再把大文件转成 Renderer data URL。取色在图片 Worker 中应用 EXIF 后只提取 1×1 像素；导出在专用 Web Worker 中使用 `ImageBitmap`/`OffscreenCanvas`，主线程只接收最终 PNG Buffer。

实际目录：

```text
<cacheRoot>/
  asset-cache/<contentHash>.<sourceExt>
  image-cache/v3/
    assets/<assetId>/
      manifest.json
      level-128.webp
      level-256.webp
      ...
      tiles/0/0-0.webp
      tiles/1/0-0.webp
    tmp/<assetId>-<nonce>/
  derived-cache/v2/        # 旧工程兼容缓存，可逐步淘汰
```

### 第四阶段：纹理选择和调度

- `textureSelection.ts` 以旋转后屏幕包围盒、camera scale、DPR 和 1.25 超采样计算需求，选择覆盖需求的最小层级。
- 升级立即请求；降级要求当前纹理超过需求 2 倍、相机停止且持续 300 ms。请求键包含 assetId、缓存/算法版本、Mip、tileX、tileY。
- Main 的图片队列和 Renderer 解码/上传请求均 single-flight；低优先级请求变为可见时只提升优先级，不重复入队。
- `stableRenderCommands` 保留上一套完整且驻留的 LOD。新 Detail 或整套 Tile 全部驻留后才在帧边界替换；目标缺失时不清空、不退回通用缩略图。
- 修复了高阶协议只查询旧 derived-cache、忽略已提交 Manifest 的问题。该问题会让 128 预览永久保留，即使高清金字塔已经存在。
- GPU 上传使用独立 `UploadBudgetQueue`，每帧最多 4 项、8 MiB、约 2 ms；可见最终资源优先于预加载资源。滚轮/拖动期间仍暂停非必要上传，旧纹理继续显示。

### 第五阶段：CPU/GPU/磁盘预算

- CPU HTMLImage 解码缓存按 `width * height * 4` 计费并按 LRU 回收，设备预算限制为 256 MiB–1 GiB，默认 512 MiB；正在引用的图片视为 Pin，回收会清空 `src` 释放浏览器资源。
- 通用 `ByteLru` 支持 Native `dispose()`（ImageBitmap 使用者可在此调用 `close()`）、字节预算和 Pin，测试覆盖超预算与释放。
- GPU 图集与 CPU 缓存生命周期独立。默认预算 512 MiB、硬上限 1 GiB；当前/上一稳定帧和可见最终纹理 Pin，屏幕外最久未用资源优先回收。
- WebGL 上传统一使用线性过滤、clamp、`UNPACK_PREMULTIPLY_ALPHA_WEBGL=false`、`UNPACK_FLIP_Y_WEBGL=false` 和浏览器默认 colorspace conversion；上下文使用 straight alpha 并配套 `SRC_ALPHA / ONE_MINUS_SRC_ALPHA`。
- 磁盘金字塔默认预算 10 GiB。清理任务后台执行，当前 registry 的资源受保护，最近资源晚于孤立资源清理，每 16 个目录主动 yield；启动后异步清理未提交 tmp。
- 最近工程条目持久保存 `assetIds`。旧状态在启动关键路径之后仅读取 `.refcanvas` 的 `manifest.json` 补建索引，不解压源图片；磁盘清理据此区分当前、最近和孤立缓存。

### 第六阶段：测试和 Benchmark

自动化覆盖：Mip/DPR/旋转包围盒、迟滞、版本化键、CPU LRU、上传预算、请求合并、generation 丢弃、路径迁移、Worker 注册清空重建、Manifest 失效、原子金字塔生成、源文件删除后的缓存读取、缓存根迁移、磁盘清理、稳定纹理替换和 WebGL 资源释放。

10 个集成场景的可执行覆盖关系：

1. 首次导入/生成缓存：`imagePyramidCache.integration.test.ts` 和 real-images smoke。
2. 重开直接命中：同一集成测试重读 Manifest，完整 Benchmark 复验 620 项。
3. 修改源文件失效：Manifest 源大小、mtime、内容 Hash、格式/算法版本测试。
4. 删除源文件后缓存可用：删除 source 后读取 Mip 文件测试。
5. 缓存迁移后显示：动态 root 迁移集成测试和 Worker lifecycle 测试。
6. 删除旧目录后 Worker 不访问旧路径：相对路径解析、generation 和注册清空重建测试。
7. 快速连续缩放不重复解码：迟滞、single-flight、请求提升测试。
8. 快速平移不闪烁：stable render commands、旧纹理保留和 project-zoom rollback=0。
9. 删除图片后任务不回写：活跃任务 Abort 与取消后无 Manifest/无临时目录测试。
10. 退出释放：WebGL destroy 删除纹理、before-quit generation/cancel/worker kill 和 smoke 正常退出。

已执行并通过：

```text
npm run typecheck
npm run lint
npm test                         # 49 files / 189 tests
npm run check:dead-code
npm run build
npm run smoke
npm run smoke:real-images
npm run smoke:thumbnail-fallback
npm run smoke:project-zoom
npm run bench:image-pipeline -- --profile=quick
npm run bench:image-pipeline -- --profile=full
```

完整结果位于 `performance-results/image-pipeline-full-latest.json`。620 个唯一 Asset（100×3840×2160、500×2048×1152、20×8192×4608，混合 JPEG/PNG/WebP/Alpha）首次生成 732305.71 ms；分场景为 258107.72 / 216319.50 / 257876.53 ms。Manifest 重开 55.22 ms，命中率 100%，重复并发解码 0；采样峰值 RSS 1058140160 bytes，稳定 RSS 164581376 bytes。合成图高度可压缩，13.12 MiB 磁盘结果不能外推真实照片容量。

Electron project-zoom 结果位于 `performance-results/2026-07-29T04-46-34-666Z-project-cold/summary.json`：首次可用 1531.08 ms，缩放平均 13.332 ms、P95 13.4 ms、P99 13.5 ms，三种平移 rollback frame 均为 0，输入处理 P95 约 0.1 ms，最终 LOD coverage 1.331，Long Task 为 0。监控中的 GPU 预算上限为 512 MiB；Node 基准自身没有 GPU 上下文，因此其 GPU 字段仍正确标记“未测量”。

### 剩余风险

- v2 场景格式为兼容旧文件仍保留 `AssetRecord.id/hash`；新记录会同步写 `assetId/contentHash`，后续场景格式升级可删除别名。
- 大于约 128M 像素的图片为遵守 512 MiB 解码预算使用 demand-driven 分块，CPU 时间会明显长于中等图片，但不会把无界 RGBA Buffer 常驻。
- 完整基准的 8K 生成阶段使进程峰值 RSS 约 1009 MiB；这包含 libvips/native 编码临时内存，不是常驻 CPU 解码缓存，但仍应在低内存设备继续压测。
- 完整基准使用合成可压缩图，导入 CPU 时间有效，但磁盘容量不能代表真实摄影素材。
- `derived-cache/v2` 仍用于旧场景/缓存损坏兼容路径；确认一到两个发布周期的迁移稳定性后可删除。
