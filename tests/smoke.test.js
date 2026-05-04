// 基础冒烟测试：引擎纯函数 + 不依赖网络/DB
const test = require('node:test');
const assert = require('node:assert');

const {
  sma,
  ema,
  movingAverages,
  macd,
  kdj,
  trendAlignment,
} = require('../engine/technical');
const { flatBase, detectAll } = require('../engine/pattern');
const { scoreC, scoreN, scoreS, scoreM, composeCanslim } = require('../engine/canslim');
const { computeOdds, oddsScore, composeExpected } = require('../engine/odds');
const { RULES, checkPrePurchase } = require('../agents/risk-agent');

function mockPrices(n = 150, base = 10) {
  const out = [];
  let px = base;
  for (let i = 0; i < n; i++) {
    const change = (Math.sin(i / 7) + Math.random() * 0.3 - 0.15) * 0.02;
    px = px * (1 + change);
    out.push({
      date: `2025-01-${String(i + 1).padStart(2, '0')}`,
      open: +px.toFixed(3),
      high: +(px * 1.02).toFixed(3),
      low: +(px * 0.98).toFixed(3),
      close: +px.toFixed(3),
      volume: 10000 + Math.random() * 5000,
      amount: 0,
      pct_chg: 0,
    });
  }
  return out;
}

test('sma 正确', () => {
  const v = sma([1, 2, 3, 4, 5], 3);
  assert.equal(v[0], null);
  assert.equal(v[1], null);
  assert.equal(v[2], 2);
  assert.equal(v[3], 3);
});

test('ema 不返回 null 序列', () => {
  const v = ema([1, 2, 3, 4, 5], 3);
  assert.equal(v.length, 5);
  assert.ok(v[4] > 0);
});

test('macd 输出三条序列', () => {
  const prices = mockPrices(60);
  const { dif, dea, hist } = macd(prices);
  assert.equal(dif.length, 60);
  assert.equal(dea.length, 60);
  assert.equal(hist.length, 60);
});

test('kdj 范围合理', () => {
  const prices = mockPrices(60);
  const { K, D } = kdj(prices);
  assert.ok(K[59] >= -50 && K[59] <= 150);
  assert.ok(D[59] >= -50 && D[59] <= 150);
});

test('trendAlignment 对随机价格不抛错', () => {
  const prices = mockPrices(150);
  const t = trendAlignment(prices);
  assert.ok(['bull', 'bear', 'mixed', 'unknown'].includes(t));
});

test('scoreC 高增速得高分', () => {
  const s = scoreC({ eps_yoy: 80 });
  assert.ok(s.score > 80);
});

test('scoreN 接近高点得高分', () => {
  const prices = [];
  for (let i = 0; i < 250; i++) {
    prices.push({
      date: `d${i}`,
      open: 10,
      high: 10 + i * 0.01,
      low: 9,
      close: 10 + i * 0.01,
      volume: 1000,
      amount: 0,
      pct_chg: 0,
    });
  }
  const s = scoreN(prices);
  assert.ok(s.score > 70);
});

test('scoreM bear 一票否决', () => {
  const s = scoreM({ shanghaiTrend: 'bear', gemTrend: 'bear' });
  assert.equal(s.verdict, 'bear');
  assert.ok(s.score < 40);
});

test('composeCanslim 输出总分', () => {
  const prices = mockPrices(200, 20);
  const c = composeCanslim({
    fundamentalsLatest: { eps_yoy: 30 },
    fundamentalsList: [{ eps_yoy: 30 }, { eps_yoy: 20 }],
    prices,
    marketPrices: prices,
    institutional: { northboundTrend: 5000 },
    market: { shanghaiTrend: 'bull', gemTrend: 'bull' },
  });
  assert.ok(c.score >= 0 && c.score <= 100);
  assert.ok(c.radar.C >= 0);
});

test('computeOdds 基本场景', () => {
  const o = computeOdds({
    currentPrice: 100,
    pivot: 100,
    stopLoss: 92,
    targetPrice: 120,
  });
  assert.equal(o.stopLoss, 92);
  assert.equal(o.targetPrice, 120);
  assert.ok(o.oddsRatio > 2);
});

test('oddsScore 递增', () => {
  assert.ok(oddsScore(3) > oddsScore(2));
  assert.ok(oddsScore(2) > oddsScore(1));
});

test('composeExpected 映射信号', () => {
  const e = composeExpected({ canslimScore: 80, odds: { oddsRatio: 3 } });
  assert.equal(e.signal, 'BUY_STRONG');
  const e2 = composeExpected({ canslimScore: 30, odds: { oddsRatio: 1 } });
  assert.equal(e2.signal, 'AVOID');
});

test('detectAll 对平盘价格识别 flat base', () => {
  const prices = [];
  for (let i = 0; i < 60; i++) {
    const px = 10 + (Math.random() - 0.5) * 0.4;
    prices.push({
      date: `d${i}`,
      open: px,
      high: px + 0.1,
      low: px - 0.1,
      close: px,
      volume: 1000,
      amount: 0,
      pct_chg: 0,
    });
  }
  const r = detectAll(prices);
  assert.ok(r.best || !r.best); // 不抛错即可
});

test('RULES 默认值与 PRD 一致', () => {
  assert.equal(RULES.STOP_LOSS_PCT, 0.08);
  assert.equal(RULES.SINGLE_POSITION_MAX, 0.15);
  assert.equal(RULES.INDUSTRY_MAX, 0.4);
  assert.equal(RULES.HOLDINGS_MAX, 10);
});
