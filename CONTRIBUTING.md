# Contributing to CodePeek

## Architecture

Plain Electron, no bundler, no framework. Three-process model:

```
CLI hooks fire
      |  stdin: event JSON
      v
bridge.js  --HTTP POST-->  127.0.0.1:31311  (token auth)
                                  |
                          eventNormalizer.js  (unified event schema)
                                  |
                          sessionManager.js  (state machine + pending I/O)
                                  |
                          contextBridge IPC  (file:// allowlist, mainFrame only)
                                  |
                          renderer/  (vanilla JS, CSS custom properties)
```

Session discovery runs in parallel via `sessionScanner.js`, polling CLI session files and checking process liveness through `Win32_Process`.

## Project Structure

```
src/
  bridge/
    bridge.js            # CLI hook relay (stdin JSON -> HTTP POST)
  main/
    index.js             # Electron main process, window, tray, IPC
    hookServer.js        # Localhost HTTP server (token-authenticated)
    sessionManager.js    # State machine, permission/question queues
    eventNormalizer.js   # Multi-CLI event name/field normalization
    hookInstaller.js     # Claude + Codex hook config writer
    sessionScanner.js    # File-based session discovery
    terminalFocus.js     # Win32 UI Automation for terminal tab focus
    terminalLauncher.js  # Open new terminal tab with resume command
    updateChecker.js     # GitHub Release version checker
    config.js            # JSON config persistence
    i18n.js              # English / Chinese dictionaries
    agents.js            # Agent definitions, SVG icons
    soundGenerator.js    # WAV synthesis (5 packs)
  preload/
    preload.js           # contextBridge API surface
  renderer/
    index.html           # Single-page shell
    renderer.js          # UI logic, surface state machine
    styles.css           # CSS custom properties, animations
```

## Adding a New Agent

1. Add agent metadata in `src/main/agents.js` (id, name, color, SVG icon)
2. Add event name mappings in `src/main/eventNormalizer.js` if the CLI uses non-standard event names
3. Add hook installation logic in `src/main/hookInstaller.js`
4. Enable by default in `src/main/config.js` under `agents`

## Development

```bash
npm start                  # Launch with DevTools available
```

Press `Ctrl+Shift+I` in the panel window to open DevTools.

## Code Style

- Plain ES2020, no TypeScript, no transpilation
- All comments in English
- No `cd` in scripts — always use absolute paths
- Prefer editing existing files over creating new ones
