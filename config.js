const path = require('path');
const os = require('os');
const fs = require('fs');
require('dotenv').config();

const platform = process.platform;
const isProduction = process.env.NODE_ENV === 'production';
const isMac = platform === 'darwin';
const isLinux = platform === 'linux';

const homeDir = os.homedir();
const dataDir = path.join(homeDir, '.investment-system');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const config = {
  env: process.env.NODE_ENV || 'development',
  isProduction,
  isMac,
  isLinux,
  port: parseInt(process.env.PORT || '3000', 10),

  db: {
    path: process.env.DB_PATH || path.join(dataDir, 'data.db'),
  },

  python: {
    bin: process.env.PYTHON_BIN || 'python3',
  },

  ai: {
    apiKey: process.env.DASHSCOPE_API_KEY || '',
    model: process.env.DASHSCOPE_MODEL || 'qwen-plus',
    endpoint:
      process.env.DASHSCOPE_ENDPOINT ||
      'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
    concurrency: parseInt(process.env.AI_CONCURRENCY || '5', 10),
    enabled: !!process.env.DASHSCOPE_API_KEY,
  },

  wechat: {
    // Mac 开发机默认走 Mock，Ubuntu 生产环境走 OpenClaw
    mock: isMac || !isProduction,
    url: process.env.OPENCLAW_URL || '',
    token: process.env.OPENCLAW_TOKEN || '',
    target: process.env.OPENCLAW_TARGET || 'filehelper',
  },

  scheduler: {
    // Ubuntu 生产环境默认开启；macOS 开发环境看 ENABLE_SCHEDULER
    enabled:
      (isLinux && isProduction) || process.env.ENABLE_SCHEDULER === 'true',
    cronMorning: process.env.CRON_MORNING || '0 9 * * 1-5',
    cronAfterClose: process.env.CRON_AFTER_CLOSE || '30 15 * * 1-5',
    cronRiskCheck: process.env.CRON_RISK_CHECK || '*/5 9-15 * * 1-5',
  },

  log: {
    level: process.env.LOG_LEVEL || 'info',
  },

  dataDir,
};

module.exports = config;
