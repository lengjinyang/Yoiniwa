# YoiStorage v4

`.yoi` 是单文件、追加式的 `YoiStorage v4` 容器。它独立于内部 Scene；Scene 继续使用 `format: "refcanvas"` 和 `version: 3`。

## 文件布局

- 固定 8 KiB 文件头，magic 为 `YOINIWA\0`，版本为 `4`。
- 头部偏移 `512` 和 `768` 各有一个 256-byte superblock。slot 使用 CRC32 保护，包含 generation、快照段、预览段、提交尾部和提交时间。
- 文件尾追加 `BLOB`、`SNAPSHOT` 和 `PREVIEW` 段。每段有固定 96-byte 头，带段类型、长度、generation 和 SHA-256。
- `SNAPSHOT` 为 Brotli 压缩 JSON，保存 Scene、Photoshop 元数据、renderer revision 和当前可达 blob 索引。

提交依次写入缺失 blob、快照和预览，fsync 后写入未使用的 superblock，再次 fsync 后才可见。读取选择 CRC 有效且 generation 最高的完整快照；如果该快照段损坏，会尝试另一个 slot。已提交尾部之后的字节是不完整写入垃圾，下一次提交前截断。

## 内容寻址

图片资产和 PSD/PSB 都以 SHA-256 作为 blob ID。多个 Photoshop 版本记录可用不同名称、备注和时间引用同一个 `blobId`，但只写入一次物理内容。删除记录先提交新的元数据快照；不再可达的 blob 在后续整理时回收。

## 整理与恢复

当垃圾至少为 512 MiB 且占文件 25%，或自上次整理累计 200 次提交时，服务在约 30 秒无新提交后后台构建 `.compact.tmp`。整理完成并通过读取校验后，才以 `.bak` 原子替换目标；普通提交只在最终替换短窗口串行化，整理准备不占用提交队列。

打开会比较目标、`.yoi.bak` 和 `.yoi.compact.tmp`：先比较有效性，再比较 generation，最后比较修改时间。恢复来源会通过 `project:open` 返回。每工程使用临时 `.lock` 维持单写入会话；Windows 下该文件创建后会设为隐藏，正常退出会等待锁释放完成。无法取得锁的实例只读打开。

## 旧格式

旧 ZIP `.yoi` 和 `.refcanvas` 仍可读取。自动保存不会升级旧格式：

- `.refcanvas` 首次显式保存写入同名 `.yoi`，保留原文件。
- 旧 ZIP `.yoi` 首次显式保存转为 v4，并把源文件保留为 `原名.legacy.yoi`。

迁移先写入并校验临时 v4 文件；任何失败都会保留源文件。

## Explorer 缩略图

Explorer provider 对 v4 只读取固定头部和 superblock 指向的 `PREVIEW` 段，限制大小并验证 PNG 签名，不扫描项目、不启动应用，也不访问 Photoshop。旧 ZIP `.yoi` / `.refcanvas` 继续读取第一个未压缩 `preview.png` 条目。
