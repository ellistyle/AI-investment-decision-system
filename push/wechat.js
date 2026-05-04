// OpenClaw 微信推送
// 开发机（macOS）默认走 Mock，控制台输出
// 生产机（Ubuntu）走 OpenClaw HTTP
const axios = require('axios');
const config = require('../config');
const { Alerts, Briefs } = require('../database/repo');

async function sendText(title, content, { target, silent = false } = {}) {
  const payload = {
    target: target || config.wechat.target,
    title,
    content,
  };
  if (config.wechat.mock) {
    if (!silent) {
      console.log('\n============ 📲 [Mock WeChat] ============');
      console.log(`[To] ${payload.target}`);
      console.log(`[Title] ${title}`);
      console.log(content);
      console.log('==========================================\n');
    }
    return { ok: true, mock: true };
  }
  try {
    const resp = await axios.post(
      config.wechat.url,
      payload,
      {
        headers: {
          'Content-Type': 'application/json',
          ...(config.wechat.token ? { Authorization: `Bearer ${config.wechat.token}` } : {}),
        },
        timeout: 10000,
      }
    );
    return { ok: true, data: resp.data };
  } catch (e) {
    return { ok: false, error: e.response?.data || e.message };
  }
}

// 📊 早盘简报
async function pushMorningBrief(summary) {
  const lines = [];
  lines.push(`📊 早盘简报 · ${summary.date}`);
  lines.push('');
  lines.push(`【大盘】上证:${summary.market.shanghaiTrend} / 创业板:${summary.market.gemTrend}`);
  lines.push(`M信号：${summary.market.mVerdict}`);
  if (summary.market.aiBrief) {
    lines.push('');
    lines.push(summary.market.aiBrief);
  }
  lines.push('');
  lines.push(`【买入信号】 ${summary.topBuys.length}只`);
  for (const s of summary.topBuys) {
    lines.push(
      `  ${s.code} ${s.name || ''} 期望${s.expected} CANSLIM${s.canslim?.toFixed(0)} 赔率${s.oddsRatio}`
    );
    if (s.pivot) lines.push(`    枢轴${s.pivot?.toFixed(2)} 止损${s.stopLoss} 目标${s.targetPrice}`);
  }
  if (summary.alerts.length) {
    lines.push('');
    lines.push(`【⚠️ 风控预警】 ${summary.alerts.length}条`);
    for (const a of summary.alerts.slice(0, 10)) lines.push(`  ${a.message}`);
  }
  lines.push('');
  lines.push(`扫描 ${summary.stats.scanned} 只 · 用时${(summary.stats.elapsedMs / 1000).toFixed(1)}s`);
  const content = lines.join('\n');
  Briefs.save({ kind: 'morning', date: summary.date, content, summary });
  return sendText('📊 早盘简报', content);
}

// 📋 收盘复盘
async function pushAfterClose(summary) {
  const lines = [];
  lines.push(`📋 收盘复盘 · ${summary.date}`);
  lines.push('');
  if (summary.positions.length) {
    lines.push(`【持仓表现】`);
    for (const p of summary.positions) {
      lines.push(
        `  ${p.code} ${p.name || ''} ${p.price} 期望${p.expected} 信号${p.signal}`
      );
    }
  } else {
    lines.push('当前无持仓');
  }
  lines.push('');
  if (summary.topBuys.length) {
    lines.push(`【明日关注】`);
    for (const s of summary.topBuys.slice(0, 5)) {
      lines.push(`  ${s.code} ${s.name || ''} 期望${s.expected}`);
    }
  }
  const content = lines.join('\n');
  Briefs.save({ kind: 'after_close', date: summary.date, content, summary });
  return sendText('📋 收盘复盘', content);
}

// 🔴 风控预警（单条即推）
async function pushAlert(alert) {
  const icon = alert.level === 'red' ? '🔴' : alert.level === 'yellow' ? '🟡' : '🟢';
  const res = await sendText(
    `${icon} 风控预警`,
    `${alert.alert_type}\n${alert.message}\n触发值: ${alert.trigger_value} / 阈值: ${alert.threshold}`
  );
  if (res.ok && alert.id) Alerts.markPushed(alert.id);
  return res;
}

// 批量推送（非交易时间积攒后批推）
async function pushAlertsDigest(alerts) {
  if (!alerts.length) return { ok: true, empty: true };
  const lines = [`⚠️ 风控汇总 (${alerts.length}条)`];
  for (const a of alerts) {
    const icon = a.level === 'red' ? '🔴' : a.level === 'yellow' ? '🟡' : '🟢';
    lines.push(`${icon} ${a.message}`);
  }
  const res = await sendText('⚠️ 风控汇总', lines.join('\n'));
  if (res.ok) for (const a of alerts) if (a.id) Alerts.markPushed(a.id);
  return res;
}

module.exports = {
  sendText,
  pushMorningBrief,
  pushAfterClose,
  pushAlert,
  pushAlertsDigest,
};
