const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const config = require('./config');
const { initSchema } = require('./database/init');
const routes = require('./api/routes');
const { startScheduler } = require('./scheduler/jobs');

initSchema();

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

app.use('/api', routes);

// 静态前端（frontend/dist 构建产物）
const distDir = path.join(__dirname, 'frontend', 'dist');
if (fs.existsSync(distDir)) {
  app.use(express.static(distDir));
  app.get(/^\/(?!api).*/, (req, res) => res.sendFile(path.join(distDir, 'index.html')));
} else {
  // 开发环境：返回内置的简易前端页面
  app.use(express.static(path.join(__dirname, 'frontend', 'public')));
  app.get('/', (req, res) =>
    res.sendFile(path.join(__dirname, 'frontend', 'public', 'index.html'))
  );
}

const server = app.listen(config.port, () => {
  console.log(`\n🚀 投资系统已启动`);
  console.log(`   环境: ${config.env} · 平台: ${process.platform}`);
  console.log(`   端口: http://localhost:${config.port}`);
  console.log(`   API : http://localhost:${config.port}/api/health`);
  console.log(`   数据: ${config.db.path}`);
  console.log(`   AI  : ${config.ai.enabled ? '✅ 阿里百炼已启用' : '⚠️ AI 未配置（Mock 模式）'}`);
  console.log(`   推送: ${config.wechat.mock ? '📣 Mock 控制台' : '📲 OpenClaw'}\n`);
  startScheduler();
});

process.on('SIGINT', () => {
  console.log('\n[server] shutting down...');
  server.close(() => process.exit(0));
});

module.exports = app;
