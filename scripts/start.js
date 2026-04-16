'use strict';

// 跨平台启动器：清空 NODE_OPTIONS 后启动 electron
// 避免 Windows cmd/PowerShell 不支持 POSIX `KEY= cmd` 语法的问题

const { spawn } = require('child_process');
const electron = require('electron');
const path = require('path');

const env = { ...process.env };
delete env.NODE_OPTIONS;

const proc = spawn(electron, [path.join(__dirname, '..')], {
  stdio: 'inherit',
  env
});

proc.on('exit', (code) => process.exit(code || 0));
proc.on('error', (err) => {
  console.error('Failed to start electron:', err.message);
  process.exit(1);
});
