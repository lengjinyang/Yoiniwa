# RefCanvas 调试指南

## 常用启动模式

```powershell
npm run dev
npm run dev:test
npm run smoke
npm run smoke:stress
npm run smoke:project-zoom
```

生产 smoke 读取 `dist`。修改 renderer 后必须先执行 `npm run build`；只修改 Electron main、worker 或 benchmark 时可单独执行 `npm run build:electron`。

- `dev:test` 使用清洁测试 session，适合验证缓存与首次启动。
- `smoke:project-zoom` 加载仓库根目录的 `未命名画板.refcanvas`。
- `REFCANVAS_PROJECT_BENCH_FOCUS_SCALE` 控制真实画板放大倍数。
- `REFCANVAS_PROJECT_BENCH_CYCLES` 控制往返次数；定位问题时优先设为 `1`。
- `REFCANVAS_MANUAL_INPUT_RECORD=1` 开启真实输入记录。
- `REFCANVAS_IMAGE_WORKER_LOG=1` 仅在排查 worker 时开启详细输出。
- `REFCANVAS_LEGACY_RENDERER=1` 切换旧 renderer，用于隔离 GPU 路径问题。

## 日志

主进程和 renderer 日志写入 Electron `userData/logs/refcanvas.jsonl`，单文件 5 MB，保留 3 份轮转备份。使用自定义 `--user-data-dir` 时，日志跟随该目录。

程序内“属性面板 → 诊断”提供：

- 打开日志目录；
- 复制当前 session、GPU feature status、图片任务和日志路径等诊断信息。

日志是 JSON Lines。优先按 `sessionId` 过滤，再检查 `level=error`、图片 worker、tile/preview 失败以及 WebGL context 事件。

## 性能面板与产物

开发/benchmark 模式下性能面板由 `src/PerformancePanel.tsx` 每 500 ms 读取监控快照。计数来源位于 `src/performanceMonitor.ts` 及渲染后端，包含 FPS、帧 CPU、draw call、纹理绑定/上传、缓存、heap、输入频率、React render、空间查询和图片处理耗时。

benchmark 结果写入 `performance-results`（已被 Git 忽略）。历史审计位于 [`performance/PERFORMANCE_AUDIT.md`](./performance/PERFORMANCE_AUDIT.md)。

## 常见故障定位

### 缩放闪烁或图片串位

先记录 backend、viewport、visible count、texture upload 和 WebGL context loss。再用 legacy renderer 对照。若仅 GPU 路径出现，检查 `renderPlan` 的 command ID、tile 完整集合和旧纹理保留逻辑，不要先调整 Scene 坐标。

### 高清升级时卡死

检查 image worker 的任务耗时、renderer 的 `texImage2D` 次数与上传耗时、GPU 估算字节和缓存淘汰。交互期间不应集中解码或上传；测试时区分冷缓存和热缓存。

### 主进程 EPIPE

子进程关闭后不要继续向其 stdout/stderr 写入。应用日志应进入 JSONL logger；benchmark 的 console 输出只应在父进程仍连接时使用。

### 场景保存问题

自动保存已关闭。显式保存通过 `scene-packages` 与 recovering persistence queue 执行；比较保存前后时应验证 Scene 语义，而不是 ZIP entry 顺序或压缩字节完全一致。
