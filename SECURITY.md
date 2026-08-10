# Security Policy

## 支持范围

Yoiniwa 目前处于早期预发行阶段，仅维护最新提交和最新 GitHub Release。旧版本可能不会获得单独的安全补丁。

## 报告安全问题

请不要通过公开 Issue 披露未修复的安全漏洞。使用 GitHub 的[私密漏洞报告](https://github.com/lengjinyang/Yoiniwa/security/advisories/new)提交以下信息：

- 受影响版本和 Windows 版本；
- 复现步骤或最小复现工程；
- 可能的影响范围；
- 如果已知，建议的缓解方式。

请不要在报告中附带真实用户素材、Photoshop 文档或包含隐私数据的 `.yoi` 文件。可以使用最小化的测试图片替代。

## 范围说明

以下内容尤其值得报告：

- `.yoi` / `.refcanvas` 解析导致的路径穿越或任意文件访问；
- 自定义协议、HTTP(S) 图片导入或外部链接处理中的权限绕过；
- Electron 主进程 IPC 参数验证缺陷；
- 缩略图提供程序或原生脚本的代码执行风险；
- Photoshop 自动化桥接意外操作非目标文档或泄露内容。

一般功能缺陷、性能问题和兼容性问题请使用普通 Bug Issue 模板。
