<div align="center">

# CodePeek

**Your AI Agent, Always in Sight.**

Dynamic Island for Claude Code, Codex & AI coding agents on Windows.
Keep every session visible — without switching windows.

[English](README.md) | [中文](README.zh-CN.md)

<!-- Replace with an actual screen recording (3-5s loop showing peek → expand → approve → collapse) -->
<!-- ![CodePeek Demo](docs/demo.gif) -->
<img src="build/icon.png" alt="CodePeek" width="128">

<br>

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Platform: Windows](https://img.shields.io/badge/Platform-Windows%2011-0078D4.svg)]()
[![Electron](https://img.shields.io/badge/Electron-33-47848F.svg)]()

</div>

---

## The Problem

You're reading docs in the browser. Claude Code is running in a terminal behind it — writing 47 files, hitting a permission wall, asking a question. **You see nothing.**

Five minutes later you switch back: "Permission denied. Session ended."

## The Solution

CodePeek floats a Dynamic Island at the top of your screen. Like the iPhone notch, it's always visible but never in the way:

<!-- TODO: replace with actual screenshots -->
<!-- ![Peek Mode](docs/peek.png) ![Expanded](docs/expanded.png) ![Approval](docs/approval.png) -->

- **Idle** — thin color-coded strip (green = running, orange = waiting, gray = idle)
- **Needs you** — expands to show permission cards or questions, with one-click approve
- **Done** — completion card pops up, click to jump straight to the terminal
- **Browsing** — hover to see all sessions, tools in use, conversation previews

## Why Not Just Watch the Terminal?

|  | Terminal | CodePeek |
|---|:---:|:---:|
| Visible while in browser / IDE | - | **Yes** |
| Visible in fullscreen apps | - | **Yes** |
| Multiple agents in one view | - | **Yes** |
| Approve permissions without switching | - | **Yes** |
| Answer questions inline | - | **Yes** |
| Sound alerts on key events | - | **Yes** |
| Click to jump to the right tab | - | **Yes** |

## Install

### Option 1: Download (recommended)

Download the latest release from [GitHub Releases](https://github.com/codepeek-labs/codepeek/releases):

- **CodePeek-Setup.exe** — standard installer (recommended)
- **CodePeek-Portable.exe** — single-file, no installation needed

Run it. Done. No Node.js, no terminal, no dependencies.

### Option 2: Build from source

For developers who want to modify or contribute:

```bash
git clone https://github.com/codepeek-labs/codepeek.git
cd codepeek
npm install
npm start          # run in dev mode
npm run build      # build installer + portable → dist/
```

Requires [Node.js](https://nodejs.org/) >= 18.

## Usage

1. **Launch** — CodePeek appears as a thin strip at the top of your screen
2. **Install hooks** — click the gear icon → **Hooks** tab → **Install**
3. **Start coding** — open a terminal, run `claude` or `codex`. CodePeek lights up automatically
4. **Interact** — hover to see session details, approve permissions, answer questions
5. **Jump** — click any session card to switch to its terminal tab

> Tip: CodePeek starts minimized to the system tray on login if you enable "Start on Login" in Settings.

## Supported Agents

| Agent | Status |
|---|---|
| Claude Code | **Full support** — hooks, session scanning, terminal jump |
| Codex (OpenAI) | **Full support** — hooks, session scanning |
| Gemini CLI | Event normalization ready, hook installer coming |
| Cursor / Copilot | Event normalization ready, hook installer coming |

## Key Features

<details>
<summary><b>Expand to see all features</b></summary>

### Session Management
- Real-time status cards with tool name, model, conversation preview
- Session grouping — ALL / STATUS / CLI toggle
- Click to jump to the right Windows Terminal tab
- Reopen closed sessions in a new terminal tab
- Horizontal drag — reposition the panel, offset persists

### Notifications
- Permission cards with tool-specific rendering (Bash `$` command, Edit diff, Grep pattern)
- Multi-option question wizard with clickable choices
- Completion cards with smart throttling and keyboard-activity suppression
- Click completion → jump to terminal, island stays collapsed (non-intrusive)

### Visual Polish
- Tool color coding — Bash (green), Edit (blue), Read (yellow), Grep (purple), Agent (orange)
- Tool name lingers 2s after execution, then fades out
- 4 animation presets (open / close / pop / micro) for consistent motion
- Startup confirmation animation
- SVG mascots for each agent with idle/active animations

### Sound & Settings
- 5 synthesized sound packs (Soft / Chime / 8-bit / Minimal / Silent)
- Per-event sound toggles
- Multi-language (English / 中文, auto-detected)
- Multi-display support — pin to any monitor
- 7-tab settings panel (General / Behavior / Appearance / Mascots / Sound / Hooks / About)

### Reliability
- Event normalization for Cursor / Gemini / Copilot event formats
- Waiting-state protection — permission cards can't be overwritten by stray events
- Auto-approve whitelist for safe internal tools
- Hook auto-repair every 5 minutes
- Auto-update checker via GitHub Releases
- Diagnostics export for debugging
- Security: token auth, IPC allowlist, constant-time comparison, byte-counted body limits

</details>

## Configuration

All settings are managed through the in-app UI. Config is stored at `~/.codepeek/config.json`.

For architecture details and contribution guidelines, see [CONTRIBUTING.md](CONTRIBUTING.md).

## Credits

Inspired by [CodeIsland](https://github.com/wxtsky/CodeIsland) (macOS) by [@wxtsky](https://github.com/wxtsky). CodePeek is an independent Windows implementation with a different process model and event architecture.

## License

[MIT](LICENSE) &copy; Evan
