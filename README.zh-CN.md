<div align="center">

# CodePeek

**你的 AI 助手，始终可见。**

Windows 11 灵动岛 —— 让 AI 编码会话状态浮在屏幕顶部，不用切窗口。

[English](README.md) | [中文](README.zh-CN.md)

<!-- 替换为实际录屏（3-5秒循环，展示 peek → 展开 → 审批 → 收起） -->
<!-- ![CodePeek 演示](docs/demo.gif) -->
<img src="build/icon.png" alt="CodePeek" width="128">

<br>

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Platform: Windows](https://img.shields.io/badge/Platform-Windows%2011-0078D4.svg)]()
[![Electron](https://img.shields.io/badge/Electron-33-47848F.svg)]()

</div>

---

## 痛点

你在浏览器查文档，Claude Code 在后面的终端里跑着 —— 写了 47 个文件、遇到权限墙、抛出一个问题。**你什么都没看到。**

五分钟后切回去："Permission denied. Session ended."

## 解决方案

CodePeek 在屏幕顶部浮一个灵动岛。像 iPhone 的刘海一样，始终可见但从不挡路：

- **空闲时** —— 一条细色带（绿 = 运行中，橙 = 等待你，灰 = 空闲）
- **需要你时** —— 自动展开权限审批卡或问题卡，一键操作
- **完成时** —— 弹出完成卡片，点击直接跳转到终端
- **想看时** —— 悬停查看所有会话、当前工具、对话预览

## 为什么不直接看终端？

|  | 终端 | CodePeek |
|---|:---:|:---:|
| 在浏览器/IDE 中可见 | - | **是** |
| 全屏应用中可见 | - | **是** |
| 多个 Agent 聚合显示 | - | **是** |
| 不切窗口就能审批权限 | - | **是** |
| 内联回答问题 | - | **是** |
| 关键事件音效提醒 | - | **是** |
| 点击跳转到正确的终端 Tab | - | **是** |

## 安装

### 方式一：直接下载（推荐）

从 [GitHub Releases](https://github.com/codepeek-labs/codepeek/releases) 下载最新版本：

- **CodePeek-Setup.exe** — 标准安装包（推荐）
- **CodePeek-Portable.exe** — 单文件便携版，无需安装

双击运行即可。不需要 Node.js，不需要终端，不需要任何依赖。

### 方式二：从源码构建

适用于想要修改或参与开发的开发者：

```bash
git clone https://github.com/codepeek-labs/codepeek.git
cd codepeek
npm install
npm start          # 开发模式运行
npm run build      # 构建安装包 + 便携版 → dist/
```

需要 [Node.js](https://nodejs.org/) >= 18。

## 使用方法

1. **启动** — CodePeek 以一条细线出现在屏幕顶部
2. **安装 hooks** — 点击齿轮图标 → **Hooks** 标签 → **Install**
3. **开始编码** — 打开终端，运行 `claude` 或 `codex`，CodePeek 自动亮起
4. **交互** — 悬停查看会话详情、审批权限、回答问题
5. **跳转** — 点击任意会话卡片，切换到对应终端标签页

> 提示：在设置中开启"开机启动"后，CodePeek 会在登录时自动启动到系统托盘。

## 支持的 Agent

| Agent | 状态 |
|---|---|
| Claude Code | **完整支持** —— hooks、会话扫描、终端跳转 |
| Codex (OpenAI) | **完整支持** —— hooks、会话扫描 |
| Gemini CLI | 事件标准化就绪，hook 安装器开发中 |
| Cursor / Copilot | 事件标准化就绪，hook 安装器开发中 |

## 完整功能列表

<details>
<summary><b>展开查看所有功能</b></summary>

### 会话管理
- 实时状态卡片：工具名、模型、对话预览
- 会话分组 —— ALL / STATUS / CLI 切换
- 点击跳转到对应的 Windows Terminal 标签页
- 重新打开已关闭的会话
- 水平拖拽 —— 面板可左右移动，位置持久化

### 通知交互
- 权限卡片差异化渲染（Bash `$` 命令、Edit diff、Grep 模式）
- 多选项问答向导，可点击选择
- 完成通知智能节流（键盘活跃抑制、同会话去重）
- 点击完成卡 → 跳转终端，岛保持收起（不打扰）

### 视觉细节
- 工具颜色编码 —— Bash（绿）、Edit（蓝）、Read（黄）、Grep（紫）、Agent（橙）
- 工具名执行后保留 2 秒再淡出
- 4 档动画预设（展开/收起/弹出/微交互）
- 启动确认动画
- 每个 Agent 的 SVG 吉祥物，带空闲/活跃动画

### 音效与设置
- 5 套合成音效包（柔和 / 风铃 / 8-bit / 极简 / 静音）
- 每种事件独立开关
- 双语（English / 中文，自动检测系统语言）
- 多显示器支持 —— 可固定到任意屏幕
- 7 标签页设置面板

### 可靠性
- 事件标准化：适配 Cursor / Gemini / Copilot 事件格式
- 等待状态保护 —— 权限卡不会被后续事件覆盖
- 内置安全工具自动批准白名单
- Hook 每 5 分钟自动修复
- GitHub Release 自动更新检查
- 诊断数据导出
- 安全加固：token 认证、IPC 白名单、恒定时间比较、字节级 body 限制

</details>

## 配置

所有设置通过应用内 UI 管理，配置文件存储在 `~/.codepeek/config.json`。

架构细节和贡献指南见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 致谢

灵感来自 [@wxtsky](https://github.com/wxtsky) 的 [CodeIsland](https://github.com/wxtsky/CodeIsland)（macOS 版）。CodePeek 是独立的 Windows 实现，拥有不同的进程模型和事件架构。

## 许可

[MIT](LICENSE) &copy; Evan
