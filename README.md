# Yoiniwa · 宵庭

> 接手开发前请先阅读 [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) 和 [`docs/DEBUGGING.md`](./docs/DEBUGGING.md)。历史性能证据保存在 [`docs/performance/PERFORMANCE_AUDIT.md`](./docs/performance/PERFORMANCE_AUDIT.md)。

Yoiniwa（宵庭）是一款 Windows x64、完全离线的参考图画板。项目使用 Tauri 2、Rust、React、TypeScript 和 PixiJS 构建；新建或保存工程默认使用 `.yoi` 扩展名，并会在 Windows 资源管理器显示画布缩略图。旧 `.refcanvas` 工程仍可打开，下一次保存会迁移为 `.yoi`。

## 已实现

- 无限画布、光标中心缩放、空格/中键平移、聚焦和适合画布
- 文件选择、拖放、剪贴板图片导入
- 单选、框选、Shift 多选、拖动、缩放、旋转、翻转、透明度和锁定
- 非破坏性裁剪及恢复原图
- 边缘/中心吸附、紧密排列、对齐、分布和尺寸统一
- 200 步撤销/重做
- 图片嵌入式 `.yoi` 场景、最近打开、保存、自动保存和未保存提醒
- PNG/JPEG 画板导出、选中内容导出和复制合成图
- 无边框窗口、始终置顶、窗口透明度、锁定窗口和鼠标穿透
- 默认按住 `S` 从参考图片原始像素取色，也可在交互设置中改为 `Alt`；松开后同步到正在运行的 Photoshop 前景色，失败时自动复制 HEX
- 默认全画布界面；右键打开功能菜单，`Tab` 打开覆盖式属性面板
- `Ctrl + Alt + Shift + T` 全局快捷键安全退出鼠标穿透

## 运行

```powershell
npm install
npm run dev
```

编译与打包：

```powershell
npm run typecheck
cargo check --manifest-path src-tauri/Cargo.toml --target x86_64-pc-windows-msvc
npm run build:web
npx tauri build --target x86_64-pc-windows-msvc --bundles nsis
```

Windows 安装包输出到 `src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis`。`npm run dist` 会先重建 Explorer 缩略图提供程序，只有修改该 C++ 组件时才需要使用。

## 常用操作

- `Ctrl+I`：导入图片
- `Ctrl+S` / `Ctrl+Shift+S`：保存 / 另存为
- `Ctrl+K` / `Ctrl+L`：新建 / 打开场景
- `Ctrl+Z` / `Ctrl+Shift+Z`：撤销 / 重做
- `Ctrl+D`：复制选中图片
- `Ctrl+C` / `Ctrl+X` / `Ctrl+V`：复制、剪切、粘贴；选中分组时会连同分组框、嵌套关系和内容一起处理
- `Delete`：删除
- `Space` / `Ctrl+Space`：聚焦选中图片 / 显示整个画板
- `Q`：进入或退出标注模式；`1` 画笔、`2` 箭头、`3` 矩形、`4` 椭圆、`E` 连续涂抹橡皮擦
- `S + 左键`：默认取色操作；可在属性面板的交互设置中改为 `Alt + 左键`
- `Ctrl+G`：为选中的图片或标注创建分组框；双击标题或按 `F2` 重命名；`Ctrl+Shift+G` 清空分组成员
- `Ctrl+P`：紧密排列图片
- `Ctrl+方向键`：对齐图片
- `Alt+L`：锁定或解锁选中图片
- `Tab`：显示或隐藏属性面板
- 右键点击 / 右键拖动：打开功能菜单 / 移动窗口
- 右键拖动：移动窗口
- `Alt + 左键` 或鼠标中键拖动：平移画布；取色键设为 `Alt` 时仅使用中键平移
- 批量拖入图片：在鼠标落点自动紧密排列
- `Shift+左键拖动图片`：沿水平或垂直方向移动
- `Ctrl+左键拖动图片`：旋转；再按 Shift 吸附到 45°
- `Ctrl+Alt+左键拖动图片`：缩放图片
- `Ctrl+Alt+Shift+左键拖动图片`：调整图片透明度
- `Ctrl+Shift+C`：让裁剪过的选中图片重新显示完整原图；未裁剪时不会改变图片
- 鼠标滚轮：缩放画布
- 右键“视图 → 大纲视图”：查看图片、标注与嵌套分组关系
- 图片菜单支持灰度去色、气泡评论和在资源管理器中定位源文件

Yoiniwa（宵庭）不使用 PureRef 的名称、素材、快捷键全集或 `.pur` 文件格式。
