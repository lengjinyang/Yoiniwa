你现在是 RefCanvas 项目的主工程师。请直接检查当前仓库并完成下面的图片导入、缓存和渲染管线重构。

不要只输出分析或方案，必须实际修改代码、运行测试、修复发现的问题，并提交一份实现说明。

# 执行状态（2026-07-29）

> 状态依据当前仓库代码、自动化测试、Electron 真实图片烟测和 `docs/image-pipeline-refactor.md` 核验。`部分完成` 不计作全部验收完成。

1. **最终目标：已完成** — 导入进度、持久化 Mip、稳定纹理保留、预算缓存和迁移 generation 已落地；真实图片烟测最终最低 LOD 覆盖为 1.705。
2. **仓库审计和实现文档：已完成** — 已定位主进程、Worker、Registry、缓存、WebGL、Mip、上传和回收链路，并建立实现文档。
3. **稳定 Asset ID 和分层架构：已完成** — 场景使用 `assetId`，缓存路径集中动态解析，CPU/GPU 生命周期分离。
4. **导入阶段磁盘 Mip 缓存：已完成** — Worker 生成 WebP Mip/Tile，校验后以 Manifest 和目录 rename 原子提交。
5. **导入进度系统：已完成** — 文件选择导入覆盖流式 Hash、元数据、解码、Mip、提交和场景阶段，并按像素工作量汇总。
6. **Mip 选择算法：已完成** — 覆盖 source/display scale、camera scale、旋转包围盒、DPR 和 1.25 超采样。
7. **禁止模糊到清晰错误切换：已完成** — 目标未驻留时保留上一套完整纹理，完整上传后在帧边界原子替换。
8. **Mip 切换迟滞：已完成** — 升级积极，降级要求 2 倍富余、相机停止并持续 300 ms；请求 single-flight。
9. **视口剔除和预加载：已完成** — 使用 Uniform Grid，渲染计划限制为可见区和 0.75 视口预加载环。
10. **CPU 解码缓存：已完成** — 按估算字节 LRU，预算 256 MiB–1 GiB、默认 512 MiB，引用中资源 Pin。
11. **GPU 纹理缓存：已完成** — 独立图集 LRU、512 MiB 默认预算、1 GiB 硬上限、当前和稳定帧纹理 Pin。
12. **GPU 分帧上传：已完成** — 独立去重队列，每帧限制 4 项、8 MiB、约 2 ms。
13. **Renderer 主线程禁重任务：已完成** — 文件/剪贴板登记不再经过 Renderer data URL；取色在图片 Worker 提取单像素，导出在专用 Web Worker 以 ImageBitmap/OffscreenCanvas 完成解码、合成和 PNG 编码。
14. **缓存迁移修复：已完成** — 暂停、generation 推进、Worker 关闭、复制、重建注册、验证新路径、最后删除旧目录的顺序已实现。
15. **并发和任务取消：已完成** — 队列使用 AbortSignal 取消待执行和活跃任务；Renderer 离开工作集会中止未完成请求，Worker 在解码、每个 Mip/Tile、写入和提交点检查取消，旧结果不能落盘或写回新 generation。
16. **单一画布渲染：已完成** — PixiJS v8 单一 Canvas 负责图片、分组、标注、评论、选择和交互层；Konva 与旧 WebGL2/Canvas2D 画布后端已从生产源码和依赖中删除。
17. **图像质量：已完成** — EXIF rotate、Lanczos3、统一 WebP/Alpha、线性过滤、straight-alpha Blend 和 WebGL pixel-store 参数已落实。
18. **缓存清理：已完成** — 10 GiB 预算、当前工程保护、孤立 LRU、临时目录和分批后台删除已完成；最近工程持久保存 assetId 索引，旧记录在后台只读 manifest 补建，清理顺序为孤立资源优先、最近工程资源最后。
19. **开发性能监控：已完成** — F10 面板包含 FPS、帧耗时、可见/预加载数、CPU/GPU 字节、队列、上传字节、命中率和 Mip。
20. **自动化测试：已完成** — 删除旧画布测试后，当前 46 个文件、151 项有效测试全部通过；磁盘金字塔、Worker 生命周期、调度/稳定纹理、预算、迁移和 Pixi Electron smoke 均有覆盖。
21. **性能基准：已完成** — 当前分支重新运行 quick 混合格式档；完整 620 Asset 与硬件 project-zoom 未在本轮重跑，GPU/帧分位明确标记为“未测量”，不沿用 Legacy 数值。
22. **六阶段实施顺序：已完成** — 已按审计、P1 迁移、磁盘金字塔、调度、预算、测试收尾顺序实施。
23. **禁止伪优化：已完成** — 没有以 CSS、淡入、无限预载或永久显存驻留代替架构修复。
24. **代码质量：已完成** — 新职责已拆分为配置、路径、Manifest、Mip Generator、generation、注册、上传队列、LRU、选择和清理模块；typecheck/lint/dead-code 均通过。
25. **最终交付：已完成** — 根因、文件、流程、目录、规则、预算、迁移、测试、Benchmark、风险和建议均记录在实现文档和交付报告中。

## 汇总

- **已完成：25 项**
- **部分完成：0 项**
- **未开始：0 项**
- 完整实现说明：`docs/image-pipeline-refactor.md`

# 一、最终目标

将 RefCanvas 的图片系统改造成类似 PureRef 的工作方式：

1. 图片导入时允许显示一次明确的进度条。
2. 导入完成后，图片缩放、平移、重新打开工程时，不应再频繁重新解码原图。
3. 不允许出现明显的：
   - 模糊图片突然变清晰；
   - 高清与低清纹理反复切换；
   - 图片短暂消失、灰块、闪烁；
   - 缩放时纹理晚一拍更新；
   - 拖动画布时主线程卡顿；
   - 一次性上传大量纹理导致掉帧。
4. 不允许把全部原图同时解码并常驻内存或显存。
5. 导入完成以后，应主要从持久化缓存读取合适分辨率的图片。
6. 图片 Worker、缓存迁移、工程重开后都必须使用正确的新缓存路径。
7. 所有缓存和内存都必须有明确预算，不允许无限增长。

目标不是伪装加载过程，而是从架构上解决问题。

# 二、执行方式

先检查当前项目结构，找到以下模块：

- Electron 主进程入口；
- 图片导入逻辑；
- 图片解码 Worker；
- `imageWorkerAssets`；
- `assetRegistry`；
- `derivedCache`；
- `cacheRootOverride`；
- 缓存迁移逻辑；
- Renderer 图片纹理管理逻辑；
- WebGL、Canvas 或其他画布渲染逻辑；
- 图片缩略图或 Mip 选择逻辑；
- GPU 纹理上传逻辑；
- 图片内存回收逻辑。

不要假设文件名固定，根据仓库实际结构定位代码。

开始修改前，在项目中建立：

```text
docs/image-pipeline-refactor.md
```

记录当前实现、发现的问题以及最终采用的架构。

然后直接开始实现，不需要等待我的确认。

# 三、总体架构

重构后的图片资源管线必须拆成以下几层：

```text
原始图片
    ↓
稳定 Asset ID
    ↓
磁盘图片金字塔缓存
    ↓
CPU 解码缓存
    ↓
GPU 纹理缓存
    ↓
单一画布渲染
```

## 3.1 Asset ID

图片内部引用不能长期依赖原始绝对路径或缓存绝对路径。

每张图片必须拥有稳定的 `assetId`。

推荐结构：

```ts
interface AssetRecord {
  assetId: string;
  sourcePath: string;
  sourceSize: number;
  sourceMtimeMs: number;
  width: number;
  height: number;
  orientation: number;
  hasAlpha: boolean;
  contentHash?: string;
  cacheVersion: number;
}
```

要求：

1. 场景对象只保存 `assetId`，不要把派生缓存路径作为永久资源身份。
2. 实际缓存文件路径必须通过统一的路径解析器动态获得。
3. Worker 不允许长期缓存旧的绝对缓存路径。
4. 缓存目录发生迁移后，所有路径必须重新解析。
5. 缓存失效必须考虑：
   - 原文件大小变化；
   - 修改时间变化；
   - 内容 Hash 变化；
   - 缓存格式版本变化；
   - Mip 生成算法版本变化。

# 四、导入阶段生成磁盘 Mip 缓存

## 4.1 导入过程

图片第一次导入时，在后台 Worker 中执行：

```text
读取图片信息
→ 计算 Asset ID
→ 解码一次原图
→ 修正 EXIF Orientation
→ 生成显示用 Mip 金字塔
→ 写入临时缓存目录
→ 校验缓存文件
→ 原子提交 Manifest
→ 通知 Renderer 图片已准备完成
```

导入进度条必须覆盖这些真实任务。

图片只有在最低可显示层级准备完成后才能加入场景；只有必需的 Mip 层级全部生成并提交后，导入才算真正完成。

## 4.2 Mip 层级

默认生成以下最长边尺寸：

```text
128
256
512
1024
2048
4096
```

如果原图最长边小于某一级，则不生成更大的层级。

原图超过 4096 时，还要根据图片尺寸继续生成：

```text
8192
16384
原始分辨率层级
```

但不能盲目把超大图片作为单张 GPU 纹理上传。

当图片任意维度超过以下任一条件时，启用分块：

```text
8192 像素
或
GPU MAX_TEXTURE_SIZE 的安全阈值
```

分块大小优先使用：

```text
512×512
```

可以根据当前渲染器调整为 1024×1024，但必须写入统一常量，不能散落硬编码。

## 4.3 缓存目录结构

建议：

```text
cache/
  assets/
    <assetId>/
      manifest.json
      level-128.webp
      level-256.webp
      level-512.webp
      level-1024.webp
      level-2048.webp
      level-4096.webp
```

超大图片使用：

```text
cache/
  assets/
    <assetId>/
      manifest.json
      level-4096/
        0-0.webp
        1-0.webp
        0-1.webp
        1-1.webp
```

不要强制完全照搬文件名，但必须做到：

- 结构可版本化；
- 可以快速判断缓存是否完整；
- 支持原子写入；
- 支持缓存迁移；
- 支持损坏后重新生成；
- 不读取半成品文件。

## 4.4 图片编码

普通无透明图片优先使用 WebP。

带透明通道的图片使用支持 Alpha 的 WebP，无法保证正确时使用 PNG。

不要反复使用极高质量 JPEG 重新编码。

图片生成应优先放在 Node.js `worker_threads` 中。

如果项目已有 `sharp`，继续使用 `sharp`。

如果没有高性能图片处理库，优先引入 `sharp`，但必须确认：

- Electron 开发环境可以运行；
- 打包后 native dependency 可以正确加载；
- Windows 构建脚本已包含对应配置；
- 不会把图片解码放回 Renderer 主线程。

# 五、导入进度系统

导入进度不能只按文件数量计算，应尽量按总像素或预计工作量计算。

建议阶段权重：

```text
读取元数据：5%
Hash 和资源注册：10%
原图解码：20%
生成 Mip：50%
写入和校验缓存：10%
场景提交：5%
```

多张图片导入时，进度应综合所有图片的像素量。

导入期间允许显示占位边框，但不要显示一张明显模糊的临时图后再突然换成高清图。

推荐行为：

1. 先完成 256 或 512 层级。
2. 准备好后一次性把图片对象加入场景。
3. 后续层级继续在后台生成。
4. 导入窗口保持进度状态。
5. 所有必需层级完成后关闭进度。
6. 用户此后正常操作时不再重新解码原始文件。

如果当前产品要求“导入进度结束后所有层级都准备好”，则在进度完成前生成全部层级。

优先选择这个模式，因为当前目标是牺牲首次导入时间，换取后续绝对稳定。

# 六、Mip 选择算法

根据图片当前在屏幕上实际占用的像素尺寸选择纹理。

必须同时考虑：

- 图片原始像素尺寸；
- 图片场景缩放；
- 画布摄像机缩放；
- `devicePixelRatio`；
- 图片旋转后的包围范围；
- 当前显示器分辨率；
- 超采样安全系数。

示例：

```ts
function calculateDesiredMip(params: {
  sourceWidth: number;
  sourceHeight: number;
  screenWidthCss: number;
  screenHeightCss: number;
  devicePixelRatio: number;
}): number {
  const requiredWidth =
    params.screenWidthCss * params.devicePixelRatio * 1.25;

  const requiredHeight =
    params.screenHeightCss * params.devicePixelRatio * 1.25;

  return chooseSmallestMipThatCovers(
    requiredWidth,
    requiredHeight
  );
}
```

要求：

1. 选择能够覆盖屏幕实际像素需求的最小 Mip。
2. 默认增加约 1.2～1.35 倍超采样。
3. 图片缩小时不使用远超需求的纹理。
4. 图片放大时提前请求更高清的层级。
5. 不要等图片已经明显模糊后才开始加载。

# 七、禁止明显的模糊到清晰切换

这是本次重构最重要的要求。

必须使用“保留当前可用纹理”的策略。

错误实现：

```text
目标 Mip 不存在
→ 立即换成低清缩略图
→ 等待高清加载
→ 再替换高清
```

正确实现：

```text
继续显示当前已经在 GPU 中的纹理
→ 后台准备目标 Mip
→ 目标纹理完整解码并上传
→ 在同一帧原子替换
```

实现类似：

```ts
function updateTextureSelection(image: ImageNode): void {
  const desiredMip = calculateDesiredMipForImage(image);

  const desiredTexture = gpuTextureCache.get(
    image.assetId,
    desiredMip
  );

  if (desiredTexture) {
    image.displayTexture = desiredTexture;
    image.displayMip = desiredMip;
    return;
  }

  textureScheduler.request({
    assetId: image.assetId,
    mip: desiredMip,
    priority: calculateTexturePriority(image),
  });

  if (!image.displayTexture) {
    image.displayTexture =
      gpuTextureCache.findBestAvailableTexture(
        image.assetId,
        desiredMip
      );
  }
}
```

关键规则：

1. 目标 Mip 未准备好时，不清空旧纹理。
2. 不重新显示通用缩略图。
3. 不允许图片变空白。
4. 新纹理必须在完整上传后才替换。
5. 替换发生在渲染帧边界。
6. 切换时图片变换矩阵、裁切范围和 UV 必须保持一致。
7. 同一图片同时最多保留当前层和目标层，不要长期保留所有层级。

# 八、Mip 切换迟滞

避免在临界缩放值附近反复切换：

```text
Mip A → Mip B → Mip A → Mip B
```

实现迟滞区间。

建议：

```text
需要更高清时：
当前纹理像素覆盖低于目标需求的 1.25 倍时请求升级。

需要更低清时：
当前纹理像素覆盖高于目标需求的 2.0 倍以上，并持续一段时间后才降级。
```

可以根据实际算法调整，但必须具备：

- 升级较积极；
- 降级较保守；
- 快速滚轮缩放时不反复请求；
- 摄像机仍在高速移动时延迟非必要降级；
- 相同请求去重。

对请求建立唯一键：

```text
assetId + mip + tileX + tileY
```

同一个资源请求不能重复进入队列。

# 九、视口剔除和预加载

不能每帧处理场景中的全部图片。

实现或确认已有空间索引，例如：

- R-tree；
- Quadtree；
- Uniform Grid。

每帧划分为三个区域：

```text
可见区域
预加载区域
远距离区域
```

## 可见区域

- 最高优先级；
- 立即选择正确 Mip；
- 允许进入 GPU 缓存；
- 不能被普通后台任务抢占。

## 预加载区域

以当前视口为基础向四周扩大约 0.5～1 个视口。

预加载区域中的图片：

- 提前读取下一步可能需要的 Mip；
- 优先级低于当前可见图片；
- 不允许占用无限显存。

## 远距离区域

- 不上传纹理；
- 逐步释放 GPU 纹理；
- CPU 解码缓存也可根据 LRU 释放；
- 只保留场景节点和资源元数据。

摄像机快速移动时，可以根据移动方向扩大前方预加载范围，但先完成基础实现，不要过度设计。

# 十、CPU 解码缓存

建立带字节预算的 LRU 缓存。

缓存对象可以是：

- `ImageBitmap`；
- 解码后的 RGBA 数据；
- 当前渲染后端可直接上传的数据。

必须记录真实或估算字节数：

```ts
estimatedBytes = width * height * 4;
```

默认预算建议：

```text
512 MB
```

需要根据设备内存进行限制：

```text
最低：256 MB
默认：512 MB
最高：1024 MB
```

不能只按缓存条目数量回收。

回收时必须正确调用：

```ts
imageBitmap.close();
```

或释放对应 Native 资源。

同一个资源正在上传 GPU 时不能被提前释放。

# 十一、GPU 纹理缓存

建立独立的 GPU LRU。

不能和 CPU 缓存共用一个生命周期。

记录：

```ts
interface GpuTextureEntry {
  key: string;
  texture: WebGLTexture;
  width: number;
  height: number;
  estimatedBytes: number;
  lastUsedFrame: number;
  pinCount: number;
}
```

预算建议：

```text
默认 512 MB
```

根据设备能力可以动态调整，但必须有硬上限。

当前可见图片的纹理必须被临时 Pin，不能在当前帧被回收。

回收优先级：

```text
屏幕外且最久未使用
→ 预加载区域低优先级资源
→ 同一图片中不再使用的旧 Mip
```

不能回收当前显示纹理，除非已经有可替代纹理。

# 十二、GPU 上传必须分帧

Worker 解码完成不代表可以一次性上传全部纹理。

建立 GPU Upload Queue。

每帧限制以下任一预算：

```text
最多上传 2～4 张纹理
或
最多上传 8 MB
或
最多占用约 2 ms
```

实现时可以组合限制。

优先级顺序：

```text
1. 当前正在操作或选中的图片
2. 当前视口中心图片
3. 当前可见且即将模糊的图片
4. 当前可见图片
5. 预加载区域图片
6. 后台低优先级任务
```

纹理上传完成前，原来的纹理继续显示。

禁止在滚轮事件、鼠标移动事件或图片加载回调中直接同步上传大量纹理。

所有上传统一经过调度器。

# 十三、主线程禁止执行的任务

以下任务不能在 Renderer UI 主线程同步执行：

- 读取大文件；
- 图片完整解码；
- 图片缩放；
- Mip 生成；
- Hash 大文件；
- 编码 WebP；
- 扫描整个缓存目录；
- 批量删除大量缓存；
- 一次性创建大量纹理；
- 同步读取图片尺寸。

Renderer 主线程只负责：

- 输入事件；
- 场景状态；
- 摄像机；
- 可见性查询；
- 纹理选择；
- 有预算的 GPU 上传；
- GPU 绘制。

# 十四、缓存迁移问题必须修复

当前项目存在以下已知问题：

缓存迁移完成后，主进程更新了：

- `cacheRootOverride`；
- `derivedCache`；
- `assetRegistry`；

但是：

- `imageWorkerAssets` 仍可能保留已经完成的旧注册 Promise；
- Worker 子进程中的 `assetSources` 仍可能指向旧文件路径；
- 旧缓存目录删除后，Worker 继续读取旧路径；
- 结果可能导致图片失效、重新加载失败或缓存引用错误。

必须修复此问题。

缓存迁移流程应改为：

```text
暂停新图片任务
→ 等待或取消正在运行的缓存任务
→ 关闭 Worker Pool
→ 清空 imageWorkerAssets
→ 清空所有缓存路径相关 Promise
→ 迁移缓存目录
→ 更新 cacheRootOverride
→ 更新 derivedCache
→ 更新 assetRegistry
→ 重新创建 Worker Pool
→ 向 Worker 发送新的 cacheRoot 和资源 Manifest
→ 重新建立资源注册
→ 验证新路径可以读取
→ 删除旧目录
→ 恢复图片任务
```

要求：

1. 删除旧缓存目录必须放在新 Worker 验证完成之后。
2. 不允许 Worker 把完整绝对缓存路径作为永久状态。
3. Worker 请求资源时优先传递：
   - `assetId`；
   - Mip；
   - Tile 坐标；
   - 缓存版本。
4. 路径由当前缓存根目录动态解析。
5. 缓存迁移后必须使所有旧请求失效。
6. 为任务增加 generation ID，例如：

```ts
interface WorkerRequest {
  generation: number;
  assetId: string;
  mip: number;
}
```

收到旧 generation 的结果时直接丢弃，不能写回新状态。

# 十五、并发和任务取消

图片请求必须支持取消和过期判断。

以下情况发生时，旧任务应降级或取消：

- 图片被删除；
- 工程关闭；
- 缓存迁移；
- 用户快速缩放到另一个层级；
- 图片离开预加载区域；
- 相同资源产生更高优先级请求；
- Worker generation 变化。

不要依赖任务真正停止后才更新界面。

即使底层图片解码无法立即中断，也必须在结果返回时判断：

```ts
if (request.generation !== currentGeneration) {
  discardResult();
}
```

# 十六、渲染方式

检查当前项目是否使用大量 DOM `<img>` 元素显示画布图片。

如果是，应将主要图片场景逐步迁移到单一 WebGL 或 WebGPU 画布。

要求：

1. 图片节点只是轻量场景数据。
2. 平移缩放主要更新摄像机矩阵。
3. 不因画布移动触发大量 DOM Layout。
4. 不为每张图片创建复杂 React 组件并高频重新渲染。
5. 图片移动时只更新必要的 GPU Buffer 或实例数据。
6. 尽量使用批量绘制或 Instancing。
7. 选择框、控制点和交互层可以保留独立 UI，但不能导致全部图片重新渲染。

如果当前已经是 WebGL 渲染，则保留现有架构并完善纹理调度，不要无理由重写整个渲染器。

# 十七、图像质量

必须确保：

- 正确处理 EXIF Orientation；
- 缩小滤波质量稳定；
- 不产生明显锯齿；
- 不因为 Mip 切换改变图片颜色；
- 不重复应用 ICC 或 Gamma；
- 透明边缘不出现黑边；
- 避免错误的 Premultiplied Alpha；
- WebGL 上传参数保持统一；
- 图片不同 Mip 的裁切范围完全一致。

检查：

```ts
UNPACK_PREMULTIPLY_ALPHA_WEBGL
UNPACK_COLORSPACE_CONVERSION_WEBGL
```

以及当前项目的 Alpha Blend 配置。

不要为了锐利强行关闭线性过滤。

# 十八、缓存清理

建立可预测的缓存清理策略。

必须区分：

```text
当前工程正在引用的缓存
最近打开工程引用的缓存
孤立缓存
临时未完成缓存
```

清理规则：

1. 临时文件启动时可以清理。
2. 当前工程引用的缓存不能删除。
3. 按最后访问时间清理孤立缓存。
4. 支持最大磁盘缓存容量，例如：
   - 5 GB；
   - 10 GB；
   - 20 GB；
   - 自定义。
5. 缓存删除放在后台低优先级任务。
6. 删除大量文件时分批处理。
7. 不要在应用启动关键路径同步扫描整个缓存。

# 十九、开发性能监控

在开发模式添加图片性能调试面板或日志统计。

至少显示：

```text
当前 FPS
主线程帧耗时
可见图片数量
预加载图片数量
GPU 纹理数量
GPU 估算占用
CPU 图片缓存占用
解码队列长度
GPU 上传队列长度
当前帧上传字节数
缓存命中率
正在使用的 Mip
```

生产模式默认关闭。

不要每帧向 Console 输出日志。

# 二十、测试

必须补充自动化测试。

## 单元测试

至少覆盖：

1. Mip 选择算法。
2. `devicePixelRatio` 计算。
3. Mip 迟滞。
4. 缓存键生成。
5. 缓存版本失效。
6. LRU 字节预算。
7. GPU 上传预算。
8. 重复请求合并。
9. generation 过期结果丢弃。
10. 缓存迁移后路径更新。
11. `imageWorkerAssets` 清空和重新注册。
12. 旧 Worker 结果不会污染新缓存状态。

## 集成测试

至少覆盖：

1. 首次导入图片，成功生成缓存。
2. 关闭工程再打开，直接命中缓存。
3. 修改原始图片后，旧缓存失效。
4. 删除原始图片后，已有场景缓存仍按产品设计工作。
5. 缓存迁移后图片仍能正常显示。
6. 旧缓存目录删除后 Worker 不再访问旧路径。
7. 快速连续缩放不会产生重复解码任务。
8. 快速平移时图片不闪烁。
9. 图片删除后相关任务不会重新写入缓存。
10. 应用退出时 Worker 和纹理资源正确释放。

# 二十一、性能基准

建立可重复执行的 Benchmark。

测试场景至少包含：

```text
100 张 4K 图片
500 张 2K 图片
20 张 8K 或更高分辨率图片
混合 PNG、JPEG、WebP 和透明图片
```

记录：

- 首次导入时间；
- 第二次打开时间；
- 峰值内存；
- 稳定状态内存；
- GPU 估算显存；
- 缩放期间平均帧耗时；
- P95 帧耗时；
- P99 帧耗时；
- 主线程超过 50ms 的 Long Task 数量；
- 缓存命中率；
- 重复解码数量。

建议验收目标：

```text
正常平移缩放时 P95 帧耗时低于 16.7ms，
性能较低设备可放宽到 25ms。

导入完成后的常规操作中，
不出现超过 50ms 的图片解码主线程任务。

同一 Asset 同一 Mip 不重复并发解码。

重新打开工程后优先命中磁盘缓存。

画布停止缩放后，不出现肉眼明显的模糊到清晰跳变。

快速缩放时图片不消失、不显示灰块、不闪烁。

内存和显存保持在配置预算附近，不随操作时间无限增长。
```

不要伪造 Benchmark 数值。

无法在当前环境测量的项目，必须明确标记“未测量”，并提供实际执行命令。

# 二十二、实施顺序

请严格按以下顺序执行，避免同时大范围重写。

## 第一阶段：审计和埋点

- 找出当前图片完整生命周期。
- 找出主线程解码位置。
- 找出纹理上传位置。
- 找出当前缓存键和路径。
- 找出图片消失或模糊切换原因。
- 添加开发性能统计。
- 更新 `docs/image-pipeline-refactor.md`。

## 第二阶段：修复缓存迁移和资源身份

- 引入稳定 `assetId`。
- 集中缓存路径解析。
- 修复 `imageWorkerAssets`。
- 缓存迁移时重启 Worker。
- 增加 generation。
- 补迁移测试。

这是 P1，必须优先完成。

## 第三阶段：磁盘 Mip 金字塔

- Worker 解码。
- 生成 Mip。
- 写 Manifest。
- 原子提交。
- 缓存命中。
- 缓存失效。
- 导入进度。

## 第四阶段：纹理调度

- Mip 选择。
- 请求去重。
- 迟滞。
- 可见性优先级。
- GPU 上传分帧。
- 旧纹理保留。
- 帧边界替换。

## 第五阶段：内存和显存预算

- CPU LRU。
- GPU LRU。
- 资源 Pin。
- 分块超大图片。
- 缓存清理。

## 第六阶段：性能测试和收尾

- 自动化测试。
- Benchmark。
- 修复内存泄漏。
- 更新文档。
- 删除废弃代码。
- 确认打包构建通过。

# 二十三、禁止采用的伪优化

禁止只做以下修改后宣称完成：

- 只调整 CSS `image-rendering`；
- 只加一个淡入动画遮住清晰度切换；
- 只把加载延迟改小；
- 只增加内存缓存但不设预算；
- 只预加载所有原图；
- 只把进度条隐藏；
- 只给图片加 `will-change`；
- 只使用 `requestIdleCallback`；
- 用 `setTimeout` 分散卡顿但仍在主线程解码；
- 导入后继续后台解码全部原图却没有调度；
- 把所有图片永久放入显存；
- 通过降低画布分辨率掩盖性能问题；
- 在图片高清纹理未准备好时主动切回缩略图。

# 二十四、代码质量要求

1. 不允许创建新的超大单文件。
2. 将以下职责拆开：
   - Asset Registry；
   - Disk Cache；
   - Image Worker；
   - Mip Generator；
   - Decode Scheduler；
   - Upload Scheduler；
   - CPU Cache；
   - GPU Cache；
   - Texture Selection；
   - Cache Migration。
3. 使用明确的 TypeScript 类型。
4. 避免 `any`。
5. 异步错误必须被捕获。
6. 文件写入必须支持失败恢复。
7. 资源释放必须放在明确生命周期中。
8. 不允许吞掉错误后静默显示低清图。
9. 所有新增配置集中管理。
10. 关键算法添加简洁注释，说明原因而不是复述代码。

# 二十五、最终交付

完成后请输出：

1. 当前问题的根因。
2. 修改过的关键文件。
3. 新图片管线的流程。
4. 缓存目录结构。
5. Mip 选择规则。
6. CPU 和 GPU 预算。
7. 缓存迁移修复方式。
8. 已运行的测试命令。
9. 测试结果。
10. Benchmark 结果。
11. 仍存在的风险。
12. 下一步建议。

同时确保以下命令通过，具体命令根据仓库实际脚本调整：

```bash
npm run typecheck
npm run lint
npm test
npm run build
```

不要因为仓库原本存在无关警告就跳过测试。

如果遇到已有测试失败，要判断是否由本次修改引起，并在最终报告中说明。

最重要的验收原则：

```text
图片导入完成后，
任何时候都优先继续显示当前稳定纹理，
目标纹理只有在完整准备好之后才替换。

任何图片解码、Mip 生成和磁盘缓存工作，
都不能阻塞 Renderer 主线程。

缓存迁移以后，
任何 Worker 都不能继续引用旧缓存路径。
```
