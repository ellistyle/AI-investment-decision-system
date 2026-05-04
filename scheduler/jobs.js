// 定时任务：09:00 早盘 / 15:30 收盘 / 交易时间每5分钟风控轮询
const cron = require('node-cron');
const dayjs = require('dayjs');
const config = require('../config');
const { runDailyBrief } = require('../agents/orchestrator');
const { checkAll } = require('../agents/risk-agent');
const {
  pushMorningBrief,
  pushAfterClose,
  pushAlert,
  pushAlertsDigest,
} = require('../push/wechat');

function isTradingTime() {
  const d = dayjs();
  const h = d.hour();
  const m = d.minute();
  const t = h * 100 + m;
  return (t >= 930 && t <= 1130) || (t >= 1300 && t <= 1500);
}

// ── 任务注册表 ──────────────────────────────────────────────
const JOB_DEFS = [
  {
    id: 'morning_brief',
    name: '早盘简报',
    desc: '每个交易日 09:00 生成大盘 + 持仓分析并推送',
    cronExpr: () => config.scheduler.cronMorning,
  },
  {
    id: 'after_close',
    name: '收盘复盘',
    desc: '每个交易日 15:30 生成收盘总结并推送',
    cronExpr: () => config.scheduler.cronAfterClose,
  },
  {
    id: 'risk_check',
    name: '风控轮询',
    desc: '交易时间每 5 分钟检查止损 / 仓位预警',
    cronExpr: () => config.scheduler.cronRiskCheck,
  },
  {
    id: 'alerts_digest',
    name: '预警汇总',
    desc: '每个交易日 15:05 推送当日预警汇总',
    cronExpr: () => '5 15 * * 1-5',
  },
];

// 运行状态（内存）
const jobState = {};
for (const def of JOB_DEFS) {
  jobState[def.id] = {
    status: 'idle',   // idle | running | success | error
    lastRunAt: null,
    lastMsg: '',
    lastDurationMs: null,
  };
}

function setRunning(id) {
  jobState[id].status = 'running';
  jobState[id].lastRunAt = dayjs().format('YYYY-MM-DD HH:mm:ss');
  jobState[id]._start = Date.now();
}

function setDone(id, ok, msg) {
  jobState[id].status = ok ? 'success' : 'error';
  jobState[id].lastMsg = msg;
  jobState[id].lastDurationMs = Date.now() - (jobState[id]._start || Date.now());
}

// ── 任务实现 ────────────────────────────────────────────────
async function runMorningBrief(log = console.log) {
  setRunning('morning_brief');
  log('[scheduler] morning brief start');
  try {
    const summary = await runDailyBrief({ kind: 'morning' });
    const r = await pushMorningBrief(summary);
    const msg = `推送${r.ok ? '成功' : '失败'}`;
    setDone('morning_brief', r.ok, msg);
    log('[scheduler] morning brief', msg);
  } catch (e) {
    setDone('morning_brief', false, e.message);
    log('[scheduler] morning brief failed:', e.message);
  }
}

async function runAfterClose(log = console.log) {
  setRunning('after_close');
  log('[scheduler] after-close start');
  try {
    const summary = await runDailyBrief({ kind: 'after-close' });
    const r = await pushAfterClose(summary);
    const msg = `推送${r.ok ? '成功' : '失败'}`;
    setDone('after_close', r.ok, msg);
    log('[scheduler] after-close', msg);
  } catch (e) {
    setDone('after_close', false, e.message);
    log('[scheduler] after-close failed:', e.message);
  }
}

async function runRiskCheck(log = console.log) {
  setRunning('risk_check');
  try {
    const alerts = checkAll();
    const reds = alerts.filter((a) => a.level === 'red');
    for (const a of reds) await pushAlert(a);
    const msg = `发现 ${alerts.length} 条预警，红色 ${reds.length} 条`;
    setDone('risk_check', true, msg);
    log('[scheduler] risk check:', msg);
  } catch (e) {
    setDone('risk_check', false, e.message);
    log('[scheduler] risk check failed:', e.message);
  }
}

async function runAlertsDigest(log = console.log) {
  setRunning('alerts_digest');
  log('[scheduler] alerts digest start');
  try {
    const alerts = checkAll();
    const r = await pushAlertsDigest(alerts);
    const msg = `推送${r.ok ? '成功' : '失败'}，共 ${alerts.length} 条`;
    setDone('alerts_digest', r.ok, msg);
    log('[scheduler] alerts digest', msg);
  } catch (e) {
    setDone('alerts_digest', false, e.message);
    log('[scheduler] alerts digest failed:', e.message);
  }
}

const runners = {
  morning_brief: runMorningBrief,
  after_close: runAfterClose,
  risk_check: runRiskCheck,
  alerts_digest: runAlertsDigest,
};

// ── 手动触发 ────────────────────────────────────────────────
function triggerJob(id) {
  const runner = runners[id];
  if (!runner) return false;
  if (jobState[id].status === 'running') return false; // 防重入
  runner().catch(() => {});
  return true;
}

// ── 状态查询 ────────────────────────────────────────────────
function listJobs() {
  return JOB_DEFS.map((def) => ({
    id: def.id,
    name: def.name,
    desc: def.desc,
    cronExpr: def.cronExpr(),
    schedulerEnabled: config.scheduler.enabled,
    ...jobState[def.id],
    _start: undefined,
  }));
}

// ── 启动 ────────────────────────────────────────────────────
let started = false;
const cronTasks = [];

function startScheduler(log = console.log) {
  if (started) return;
  if (!config.scheduler.enabled) {
    log('[scheduler] disabled (set ENABLE_SCHEDULER=true or run in production Linux)');
    return;
  }

  cronTasks.push(cron.schedule(config.scheduler.cronMorning, () => runMorningBrief(log)));
  cronTasks.push(cron.schedule(config.scheduler.cronAfterClose, () => runAfterClose(log)));
  cronTasks.push(
    cron.schedule(config.scheduler.cronRiskCheck, () => {
      if (!isTradingTime()) return;
      runRiskCheck(log);
    })
  );
  cronTasks.push(cron.schedule('5 15 * * 1-5', () => runAlertsDigest(log)));

  started = true;
  log(
    `[scheduler] started · morning=${config.scheduler.cronMorning} · after-close=${config.scheduler.cronAfterClose} · risk=${config.scheduler.cronRiskCheck}`
  );
}

function stopScheduler() {
  for (const t of cronTasks) t.stop();
  cronTasks.length = 0;
  started = false;
}

module.exports = { startScheduler, stopScheduler, isTradingTime, listJobs, triggerJob };
