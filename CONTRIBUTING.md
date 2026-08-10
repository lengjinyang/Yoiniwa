# Contributing to Yoiniwa

感谢你愿意为 Yoiniwa（宵庭）贡献代码、文档或问题报告。

## 开始之前

- 使用 Windows 10/11、Node.js 22+ 和 npm。
- 首次检出后运行 `npm ci`。
- 完整生产构建需要 Visual Studio 2022 C++ Build Tools。
- 优先提交范围清晰、可独立验证的小改动，避免顺带重构无关功能。

## 开发流程

```powershell
npm ci
npm run dev
```

提交前至少运行：

```powershell
npm run check
```

涉及生产资源、Electron 主进程或原生缩略图组件时，再运行：

```powershell
npm run build
```

## Photoshop 协作模式的不可破坏约束

从 Yoiniwa 协作取色后，回到 Photoshop 的第一次真实笔尖按下必须能够正常绘画。这条约束优先于置顶方式、任务栏层级、窗口外观和其他交互优化。

涉及以下区域的 Pull Request 必须特别说明验证方式：

- 协作模式、始终置顶、窗口锁定、鼠标穿透和 Z 序；
- `WS_EX_NOACTIVATE`、`SetWindowPos`、`setAlwaysOnTop`、窗口焦点和 DWM；
- Windows Ink、Pointer Events、Pointer Capture 或原生输入 Hook；
- Photoshop COM、颜色提交队列以及 Alt/笔尖取色状态机。

禁止通过模拟点击、移动系统光标、伪造键盘/Alt 松开或向 Photoshop 注入输入来规避问题。自动检查和鼠标模拟只能作为补充，不能宣称替代真实 Windows Ink 数位板验证。

相关 PR 的测试说明应至少记录：

1. 使用的 Windows、Photoshop 和数位板/驱动版本；
2. 单次取色后第一笔是否正常；
3. 快速连续多次取色后第一笔是否正常；
4. 右键移动、普通置顶、缩放和协作模式入口是否保持原行为。

## Issue 与 Pull Request

- Bug 请提供复现步骤、期望结果、实际结果和日志。
- 性能问题请提供图片数量、分辨率、缩放倍率及可复现工程信息。
- 不要上传含有版权受限或隐私内容的 `.yoi` 工程。
- PR 描述应说明改动原因、用户影响、验证命令及仍需实机确认的项目。

## 代码风格

- 遵循现有 TypeScript、React 和 Electron 模块边界。
- 共享场景行为优先放在领域命令中，避免菜单、快捷键和 UI 各自实现一套逻辑。
- 不提交 `node_modules/`、`dist/`、`dist-electron/`、`release/` 或本机配置。
- 新功能与回归修复应尽可能补充 Vitest 测试。

## 许可证

仓库当前未发布开源许可证。除非仓库所有者另行授权，贡献内容不会自动改变项目的许可状态。
