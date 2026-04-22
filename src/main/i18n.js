'use strict';

// 多语言支持 - 中英文字典

const os = require('os');

const DICT = {
  en: {
    // Header
    appName: 'CodePeek',
    sessionsActive: 'active',
    sessionsTotal: 'total',
    noSessions: 'No sessions found',

    // Session status
    statusActive: 'Active',
    statusThinking: 'Thinking',
    statusToolUse: 'Tool Use',
    statusWaiting: 'Waiting',
    statusQuestion: 'Question',
    statusIdle: 'Idle',
    statusSubagent: 'Subagent',
    statusCompacting: 'Compacting',
    statusStale: 'Stale',
    statusDone: 'Done',
    lastPrompt: 'LAST PROMPT',
    lastResponse: 'LAST RESPONSE',
    jump: 'Jump',
    reopen: 'Reopen',
    reopening: 'Reopening in new terminal...',
    reopenFailed: 'Reopen failed',
    reopenOk: 'Session reopened',

    // Permission
    permissionRequired: 'Permission Required',
    btnAllow: 'Allow',
    btnDeny: 'Deny',
    btnAlways: 'Always',

    // Question
    questions: 'Questions',
    questionPlaceholder: 'Type your answer...',
    btnSend: 'Send',

    // Context menu
    menuSettings: 'Settings',
    menuQuit: 'Quit CodePeek',
    menuPin: 'Pinned',
    menuJumping: 'Jumping...',
    menuSwitched: 'Switched to terminal',
    menuJumpFailed: 'Jump failed',
    menuNoPid: 'No PID for this session',
    sessionClosed: 'Terminal was closed — refreshing...',

    // Settings tabs
    tabGeneral: 'General',
    tabBehavior: 'Behavior',
    tabAppearance: 'Appearance',
    tabMascots: 'Mascots',
    tabSound: 'Sound',
    tabHooks: 'Hooks',
    tabAbout: 'About',

    // General tab
    lang: 'Language',
    langAuto: 'Auto (System)',
    langEn: 'English',
    langZh: '中文',
    startOnLogin: 'Start on Login',
    display: 'Display',
    displayPrimary: 'Primary',

    // Behavior tab
    autoHide: 'Auto Hide Panel',
    hoverExpand: 'Hover to Expand',
    hoverCollapseDelay: 'Auto Collapse Delay',
    hoverExpandDelay: 'Hover Expand Delay',
    suppressNotif: 'Smart Notification Suppression',
    completionDisplayTime: 'Completion Card Display Time',
    cleanupStale: 'Clean Stale Sessions After',
    minutes: 'minutes',
    seconds: 'seconds',
    milliseconds: 'ms',
    never: 'Never',

    // Appearance tab
    panelWidth: 'Panel Width',
    panelHeight: 'Panel Height',
    fontSize: 'Font Size',
    responseLines: 'Response Preview Lines',
    mascots: 'Show Mascots',
    peekHeight: 'Peek Edge Height',

    // Mascots tab
    mascotPreview: 'Pixel Art Characters',

    // Sound tab
    soundEnabled: 'Enable Sounds',
    soundPack: 'Sound Pack',
    soundVolume: 'Volume',
    soundEvents: 'Event Sounds',
    soundSessionStart: 'Session Start',
    soundToolUse: 'Tool Use',
    soundPermission: 'Permission Request',
    soundQuestion: 'Question',
    soundComplete: 'Session Complete',

    // Hooks tab
    hooksStatus: 'Hook Status',
    installed: 'Installed',
    notInstalled: 'Not Installed',
    btnInstall: 'Install',
    btnUninstall: 'Uninstall',
    enabledAgents: 'Enabled Agents',

    // About tab
    aboutVersion: 'Version',
    aboutGitHub: 'GitHub',
    aboutLicense: 'MIT License',

    // Notifications
    hooksInstalled: 'Hooks installed',
    hooksUninstalled: 'Hooks uninstalled',
    operationFailed: 'Operation failed',
    configSaved: 'Settings saved',

    // Completion toast
    completionDone: 'Completed',
    completionUntitled: 'Untitled session'
  },

  zh: {
    appName: 'CodePeek',
    sessionsActive: '活跃',
    sessionsTotal: '共',
    noSessions: '暂无会话',

    statusActive: '活跃',
    statusThinking: '思考中',
    statusToolUse: '执行工具',
    statusWaiting: '等待批准',
    statusQuestion: '等待回答',
    statusIdle: '空闲',
    statusSubagent: '子代理',
    statusCompacting: '压缩中',
    statusStale: '已结束',
    statusDone: '完成',
    lastPrompt: '上次提问',
    lastResponse: '上次回复',
    jump: '跳转',
    reopen: '重开',
    reopening: '正在打开新终端...',
    reopenFailed: '重开失败',
    reopenOk: '会话已恢复',

    permissionRequired: '需要批准',
    btnAllow: '允许',
    btnDeny: '拒绝',
    btnAlways: '始终允许',

    questions: '问题',
    questionPlaceholder: '输入回答...',
    btnSend: '发送',

    menuSettings: '设置',
    menuQuit: '退出 CodePeek',
    menuPin: '已钉住',
    menuJumping: '正在跳转...',
    menuSwitched: '已切换到终端',
    menuJumpFailed: '跳转失败',
    menuNoPid: '该会话没有 PID',
    sessionClosed: '终端已关闭，正在刷新...',

    tabGeneral: '通用',
    tabBehavior: '行为',
    tabAppearance: '外观',
    tabMascots: '吉祥物',
    tabSound: '声音',
    tabHooks: '钩子',
    tabAbout: '关于',

    lang: '语言',
    langAuto: '跟随系统',
    langEn: 'English',
    langZh: '中文',
    startOnLogin: '开机自启',
    display: '显示器',
    displayPrimary: '主显示器',

    autoHide: '自动隐藏面板',
    hoverExpand: '鼠标悬停展开',
    hoverCollapseDelay: '自动收起延迟',
    hoverExpandDelay: '悬停展开延迟',
    suppressNotif: '智能通知抑制',
    completionDisplayTime: '完成卡片显示时长',
    cleanupStale: '清理无活动会话',
    minutes: '分钟',
    seconds: '秒后',
    milliseconds: '毫秒',
    never: '永不',

    panelWidth: '面板宽度',
    panelHeight: '面板高度',
    fontSize: '字体大小',
    responseLines: '回复预览行数',
    mascots: '显示吉祥物',
    peekHeight: '收起时露出高度',

    mascotPreview: '像素风角色',

    soundEnabled: '启用声音',
    soundPack: '音效风格',
    soundVolume: '音量',
    soundEvents: '事件音效',
    soundSessionStart: '会话启动',
    soundToolUse: '工具调用',
    soundPermission: '权限请求',
    soundQuestion: '问题询问',
    soundComplete: '会话完成',

    hooksStatus: '钩子状态',
    installed: '已安装',
    notInstalled: '未安装',
    btnInstall: '安装',
    btnUninstall: '卸载',
    enabledAgents: '已启用的代理',

    aboutVersion: '版本',
    aboutGitHub: 'GitHub',
    aboutLicense: 'MIT 许可证',

    hooksInstalled: '钩子安装成功',
    hooksUninstalled: '钩子已卸载',
    operationFailed: '操作失败',
    configSaved: '设置已保存',

    completionDone: '已完成',
    completionUntitled: '未命名会话'
  }
};

let _electronLocale = null;
function setElectronLocale(locale) { _electronLocale = locale; }

function detectSystemLanguage() {
  try {
    // 优先使用 Electron app.getLocale()（由主进程传入）
    if (_electronLocale) {
      const l = _electronLocale.toLowerCase();
      if (l.startsWith('zh')) return 'zh';
      return 'en';
    }
    // fallback 1: Intl API
    const intlLocale = Intl.DateTimeFormat().resolvedOptions().locale.toLowerCase();
    if (intlLocale.startsWith('zh')) return 'zh';
    // fallback 2: LANG 环境变量（Unix 风格）
    const envLang = (process.env.LANG || '').toLowerCase();
    if (envLang.includes('zh') || envLang.includes('cn')) return 'zh';
  } catch {}
  return 'en';
}

function resolveLang(configLang) {
  if (configLang === 'zh' || configLang === 'en') return configLang;
  return detectSystemLanguage();
}

function getDict(lang) {
  const resolved = resolveLang(lang);
  return DICT[resolved] || DICT.en;
}

module.exports = { getDict, resolveLang, detectSystemLanguage, setElectronLocale, DICT };
