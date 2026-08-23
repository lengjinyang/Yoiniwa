<p align="center">
  <img src="public/yoiniwa-icon.png" width="112" alt="Yoiniwa logo" />
</p>

<h1 align="center">Yoiniwa · 宵庭</h1>

<p align="center">
  面向插画与视觉创作的 Windows 参考图画板
</p>

<p align="center">
  <a href="https://github.com/lengjinyang/Yoiniwa/releases"><img src="https://img.shields.io/github/v/release/lengjinyang/Yoiniwa?include_prereleases&label=release" alt="Release" /></a>
  <img src="https://img.shields.io/badge/platform-Windows-0078D4" alt="Windows" />
  <img src="https://img.shields.io/badge/Electron-43-47848F" alt="Electron" />
  <img src="https://img.shields.io/badge/TypeScript-5.9-3178C6" alt="TypeScript" />
</p>

Yoiniwa（宵庭）是一款本地运行的参考图整理工具，提供无限画布、图片编排、非破坏性编辑和 Photoshop 协作功能。工程与图片默认保存在本地，无需登录或连接云服务。

## 下载

前往 [Releases](https://github.com/lengjinyang/Yoiniwa/releases) 下载最新版 Windows x64 安装包。

当前安装包尚未配置代码签名证书，Windows 可能显示“未知发布者”。请从本仓库 Releases 页面下载，并使用随版本提供的 SHA-256 文件校验安装包。

## 功能

### 无限画布

- 以光标为中心缩放，自由平移、聚焦选中内容或显示整个画板
- 支持文件选择、拖放、剪贴板和 HTTP(S) 图片导入
- 支持单选、框选、多选、移动、缩放、旋转、翻转、透明度和锁定
- 边缘与中心吸附、紧密排列、对齐、分布、统一尺寸和嵌套分组
- 画笔、箭头、矩形、椭圆、橡皮擦和气泡评论

### 图片处理

- 非破坏性裁剪并可随时恢复原图
- 灰度与对比度调整
- PNG/JPEG 导出、选中内容导出和合成图复制
- 大图分级纹理与分块缓存，兼顾清晰度和画布性能

### 工程管理

- 使用 `.yoi` 格式保存画板和嵌入图片
- 自动保存、最近打开和未保存提醒
- 兼容旧 `.refcanvas` 工程
- 在 Windows 资源管理器中显示 `.yoi` 工程缩略图

### Photoshop 协作

- 从参考图原始像素取色并同步到 Photoshop 前景色
- Photoshop 不可用时自动复制 HEX 颜色
- 支持 Photoshop 文档预览、版本记录和选中内容发送
- 协作模式、始终置顶、窗口透明度、锁定和鼠标穿透

## 系统要求

- Windows 10 或 Windows 11 x64
- Photoshop 为可选项，仅相关协作功能需要

## 常用操作

| 操作 | 快捷键或手势 |
| --- | --- |
| 导入图片 | `Ctrl+I` |
| 保存 / 另存为 | `Ctrl+S` / `Ctrl+Shift+S` |
| 新建 / 打开工程 | `Ctrl+K` / `Ctrl+L` |
| 撤销 / 重做 | `Ctrl+Z` / `Ctrl+Shift+Z` |
| 聚焦选中 / 显示整个画板 | `Space` / `Ctrl+Space` |
| 标注模式 | `Q` |
| 默认取色 | `S + 左键` |
| 创建 / 清空分组 | `Ctrl+G` / `Ctrl+Shift+G` |
| 紧密排列 | `Ctrl+P` |
| 显示 / 隐藏属性面板 | `Tab` |
| 平移画布 | 鼠标中键拖动 |
| 旋转图片 | `Ctrl + 左键拖动` |
| 缩放图片 | `Ctrl+Alt + 左键拖动` |
| 调整透明度 | `Ctrl+Alt+Shift + 左键拖动` |
| 退出鼠标穿透 | `Ctrl+Alt+Shift+T` |

右键点击打开功能菜单，右键拖动可以移动窗口。更多设置可在应用内属性面板中调整。

## 从源码运行

需要 Node.js 22 或更高版本。完整的 Windows 生产构建还需要 Visual Studio 2022 C++ Build Tools。

```powershell
git clone https://github.com/lengjinyang/Yoiniwa.git
cd Yoiniwa
npm ci
npm run dev
```

构建应用或 Windows 安装包：

```powershell
npm run build
npm run dist
```

## 数据与隐私

- 工程和图片资产默认保存在本地。
- 应用不包含遥测上报。
- 只有在主动导入 HTTP(S) 图片时，应用才会访问对应地址。
- `.yoi` 文件可以包含嵌入图片和 Photoshop 版本数据，分享前请确认其中没有敏感素材。

## 文档

- [`.yoi` v4 存储格式](docs/YOI_STORAGE_V4.md)
- [安全政策](SECURITY.md)

## 许可证

本项目目前未发布开源许可证。未经许可，不得复制、修改、分发或用于商业用途。

## 说明

Yoiniwa 是独立项目，与 PureRef、Adobe 或 Photoshop 官方没有隶属或背书关系。PureRef、Adobe 和 Photoshop 等名称及商标归各自权利人所有。
