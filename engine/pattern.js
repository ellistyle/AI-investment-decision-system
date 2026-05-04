// 欧奈尔形态识别：杯柄（Cup-with-Handle）、VCP（Volatility Contraction Pattern）、平台突破
// 所有函数接收升序 prices，返回 {found, pivot, confidence, detail}

const { sma, movingAverages } = require('./technical');

function rangeHigh(prices, start, end) {
  let hi = -Infinity;
  for (let i = start; i <= end; i++) if (prices[i].high > hi) hi = prices[i].high;
  return hi;
}
function rangeLow(prices, start, end) {
  let lo = Infinity;
  for (let i = start; i <= end; i++) if (prices[i].low < lo) lo = prices[i].low;
  return lo;
}

// 杯柄形态：先形成U型杯（深度15%-30%，持续7-65周），然后形成1-2周的柄（浅回调3%-15%），突破柄口买入
function cupWithHandle(prices) {
  const N = prices.length;
  if (N < 80) return { found: false };
  // 取最近 120 根做窗口
  const win = Math.min(N, 200);
  const s = N - win;
  const closes = prices.slice(s).map((p) => p.close);
  const highs = prices.slice(s).map((p) => p.high);
  const lows = prices.slice(s).map((p) => p.low);

  // 左沿：窗口前 1/5 区间内的最高点
  const leftEnd = Math.floor(win * 0.3);
  let leftPeakIdx = 0;
  for (let i = 0; i <= leftEnd; i++) if (highs[i] > highs[leftPeakIdx]) leftPeakIdx = i;

  // 杯底：左沿到窗口 3/4 之间的最低点
  const bottomSearchStart = leftPeakIdx + 5;
  const bottomSearchEnd = Math.floor(win * 0.8);
  if (bottomSearchEnd <= bottomSearchStart) return { found: false };
  let bottomIdx = bottomSearchStart;
  for (let i = bottomSearchStart; i <= bottomSearchEnd; i++)
    if (lows[i] < lows[bottomIdx]) bottomIdx = i;

  // 右沿：底部到窗口末尾之间接近左沿高度
  const rightSearchStart = bottomIdx + 5;
  if (rightSearchStart >= win - 3) return { found: false };
  let rightPeakIdx = rightSearchStart;
  for (let i = rightSearchStart; i < win - 3; i++)
    if (highs[i] > highs[rightPeakIdx]) rightPeakIdx = i;

  const leftPeak = highs[leftPeakIdx];
  const bottom = lows[bottomIdx];
  const rightPeak = highs[rightPeakIdx];
  const depth = (leftPeak - bottom) / leftPeak;
  const symmetry = Math.abs(rightPeak - leftPeak) / leftPeak;

  // 深度 15%-35%，右沿达左沿 90% 以上
  if (depth < 0.15 || depth > 0.35) return { found: false };
  if (symmetry > 0.1) return { found: false };

  // 柄：右沿到末尾是否出现浅回调 3%-15%
  const handleLow = Math.min(...lows.slice(rightPeakIdx));
  const handleDepth = (rightPeak - handleLow) / rightPeak;
  const handleOk = handleDepth >= 0.03 && handleDepth <= 0.15;

  const pivot = rightPeak * 1.001; // 枢轴点：略高于右沿
  const last = closes[closes.length - 1];
  const breakout = last >= pivot;

  return {
    found: true,
    pattern: 'cup-with-handle',
    pivot,
    breakout,
    confidence: handleOk ? 0.85 : 0.6,
    detail: {
      leftPeak,
      bottom,
      rightPeak,
      depth: +(depth * 100).toFixed(2),
      handleDepth: +(handleDepth * 100).toFixed(2),
      symmetry: +(symmetry * 100).toFixed(2),
    },
  };
}

// VCP：近期出现多次收缩（波幅递减），最后一次收缩 < 10%
function vcp(prices) {
  const N = prices.length;
  if (N < 60) return { found: false };
  const win = Math.min(N, 100);
  const s = N - win;
  const sub = prices.slice(s);

  // 滚动 10 日高低振幅
  const amps = [];
  for (let i = 10; i < sub.length; i++) {
    const hi = Math.max(...sub.slice(i - 10, i + 1).map((p) => p.high));
    const lo = Math.min(...sub.slice(i - 10, i + 1).map((p) => p.low));
    amps.push((hi - lo) / hi);
  }
  if (amps.length < 30) return { found: false };

  const early = amps.slice(0, 10).reduce((a, b) => a + b, 0) / 10;
  const mid = amps.slice(10, 20).reduce((a, b) => a + b, 0) / 10;
  const late = amps.slice(-10).reduce((a, b) => a + b, 0) / 10;

  const contracting = early > mid && mid > late && late < 0.1;
  if (!contracting) return { found: false };

  const recentHigh = Math.max(...sub.slice(-20).map((p) => p.high));
  const pivot = recentHigh * 1.001;
  const breakout = sub[sub.length - 1].close >= pivot;

  return {
    found: true,
    pattern: 'vcp',
    pivot,
    breakout,
    confidence: 0.75,
    detail: {
      ampEarly: +(early * 100).toFixed(2),
      ampMid: +(mid * 100).toFixed(2),
      ampLate: +(late * 100).toFixed(2),
    },
  };
}

// 平台突破：近 N 日价格在 5% 箱体内震荡，突破上沿
function flatBase(prices, { days = 30, boxWidth = 0.08 } = {}) {
  const N = prices.length;
  if (N < days + 5) return { found: false };
  const sub = prices.slice(N - days);
  const hi = Math.max(...sub.map((p) => p.high));
  const lo = Math.min(...sub.map((p) => p.low));
  const width = (hi - lo) / lo;
  if (width > boxWidth) return { found: false };

  const pivot = hi * 1.001;
  const last = prices[N - 1].close;
  const breakout = last >= pivot;

  return {
    found: true,
    pattern: 'flat-base',
    pivot,
    breakout,
    confidence: 0.7,
    detail: {
      width: +(width * 100).toFixed(2),
      hi,
      lo,
      days,
    },
  };
}

function detectAll(prices) {
  const results = {};
  results.cupHandle = cupWithHandle(prices);
  results.vcp = vcp(prices);
  results.flatBase = flatBase(prices);
  // 选择一个最置信的
  const candidates = Object.values(results).filter((r) => r.found);
  let best = null;
  for (const r of candidates) {
    if (!best || r.confidence > best.confidence) best = r;
  }
  return { best, all: results };
}

module.exports = { cupWithHandle, vcp, flatBase, detectAll };
