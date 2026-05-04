const { useState, useEffect, useRef, useMemo } = React;

// ============ API Client ============
const API = {
  async get(path) {
    const r = await fetch('/api' + path);
    return r.json();
  },
  async post(path, body) {
    const r = await fetch('/api' + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
    return r.json();
  },
  async patch(path, body) {
    const r = await fetch('/api' + path, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
    return r.json();
  },
  async put(path, body) {
    const r = await fetch('/api' + path, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
    return r.json();
  },
  async del(path) {
    const r = await fetch('/api' + path, { method: 'DELETE' });
    return r.json();
  },
};

function Badge({ kind, children }) {
  return <span className={`badge ${kind}`}>{children}</span>;
}

function signalBadge(signal) {
  const m = {
    BUY_STRONG: ['buy-strong', '强烈买入'],
    BUY_WATCH: ['buy-watch', '关注买入'],
    HOLD: ['hold', '持有观望'],
    AVOID: ['avoid', '回避'],
    SELL: ['sell', '卖出'],
  };
  const [k, t] = m[signal] || ['hold', signal || '-'];
  return <Badge kind={k}>{t}</Badge>;
}

function useECharts(option, deps = []) {
  const ref = useRef(null);
  const instRef = useRef(null);
  useEffect(() => {
    if (!ref.current) return;
    if (!instRef.current) instRef.current = echarts.init(ref.current);
    instRef.current.setOption(option, true);
    const handler = () => instRef.current?.resize();
    window.addEventListener('resize', handler);
    return () => window.removeEventListener('resize', handler);
  }, deps);
  useEffect(() => () => instRef.current?.dispose(), []);
  return ref;
}

// ============ 首页仪表盘 ============
function Dashboard() {
  const [market, setMarket] = useState(null);
  const [signals, setSignals] = useState([]);
  const [alerts, setAlerts] = useState([]);
  const [positions, setPositions] = useState([]);
  const [loading, setLoading] = useState(false);
  const [marketLoading, setMarketLoading] = useState(false);

  async function refresh() {
    setLoading(true);
    try {
      const [s, a, p] = await Promise.all([
        API.get('/signals?today=true'),
        API.get('/alerts?unhandled=true'),
        API.get('/positions'),
      ]);
      setSignals(s.data || []);
      setAlerts(a.data || []);
      setPositions(p.data || []);
    } finally {
      setLoading(false);
    }
  }

  async function loadMarket(force = false) {
    setMarketLoading(true);
    const r = await API.post('/analyze/market', { force });
    setMarket(r.data || null);
    setMarketLoading(false);
  }

  useEffect(() => {
    refresh();
    loadMarket(false);
  }, []);

  const totalMarketValue = positions.reduce(
    (a, p) => a + (p.current_price || p.buy_price) * p.quantity,
    0
  );
  const totalCost = positions.reduce((a, p) => a + p.buy_price * p.quantity, 0);
  const totalPnl = totalMarketValue - totalCost;
  const totalPnlPct = totalCost ? (totalPnl / totalCost) * 100 : 0;

  const sentiment = market?.sentiment || {};

  return (
    <div>
      <h2 className="page-title">首页仪表盘</h2>
      <div className="toolbar">
        <button className="btn" onClick={refresh} disabled={loading}>
          刷新数据
        </button>
        <button className="btn secondary" onClick={() => loadMarket(true)} disabled={loading || marketLoading}>
          {marketLoading ? '分析中…' : '重新分析大盘'}
        </button>
        <button
          className="btn secondary"
          onClick={async () => {
            const r = await API.post('/push/morning', { force: true });
            alert('早盘简报已生成' + (r.pushResult?.mock ? '（Mock 推送）' : ''));
            refresh();
          }}
        >
          生成早盘简报
        </button>
      </div>

      <div className="grid grid-4">
        <div className={`stat ${totalPnl >= 0 ? 'green' : 'red'}`}>
          <div className="label">持仓市值</div>
          <div className="value">¥{totalMarketValue.toFixed(0)}</div>
        </div>
        <div className={`stat ${totalPnl >= 0 ? 'green' : 'red'}`}>
          <div className="label">浮动盈亏</div>
          <div className="value">
            {totalPnl >= 0 ? '+' : ''}¥{totalPnl.toFixed(0)} ({totalPnlPct.toFixed(2)}%)
          </div>
        </div>
        <div className="stat">
          <div className="label">今日信号</div>
          <div className="value">{signals.length}</div>
        </div>
        <div className={`stat ${alerts.length > 0 ? 'red' : ''}`}>
          <div className="label">未处理预警</div>
          <div className="value">{alerts.length}</div>
        </div>
      </div>

      <div className="grid grid-2" style={{ marginTop: 16 }}>
        <div className="card">
          <div className="card-title">🌡️ 市场情绪温度计</div>
          {marketLoading && !market ? (
            <div className="loading">正在分析大盘…</div>
          ) : market ? (
            <div>
              {[
                { label: '上证', trend: market.shanghaiTrend, recent: market.shRecent },
                { label: '深证', trend: market.szTrend,       recent: market.szRecent },
                { label: '创业板', trend: market.gemTrend,    recent: market.gemRecent },
                { label: '科创50', trend: market.starTrend,   recent: market.starRecent },
              ].map(({ label, trend, recent }) => {
                const last = recent?.length > 0 ? recent[recent.length - 1] : null;
                const color = last ? (last.pct_chg >= 0 ? '#3fb950' : '#f85149') : '#8b949e';
                return (
                  <span key={label} style={{ marginRight: 16, whiteSpace: 'nowrap' }}>
                    {label}：<span className={trend}>{trend}</span>
                    {last && (
                      <span style={{ marginLeft: 4, color, fontSize: 12 }}>
                        ({last.pct_chg > 0 ? '+' : ''}{last.pct_chg}%)
                      </span>
                    )}
                  </span>
                );
              })}
              <div style={{ marginTop: 8 }}>
                M信号：<strong className={market.mVerdict}>{market.mVerdict}</strong>
              </div>
              <div style={{ marginTop: 8 }}>
                涨停 <strong style={{ color: '#3fb950' }}>{sentiment.limit_up_count ?? '-'}</strong> /{' '}
                跌停 <strong style={{ color: '#f85149' }}>{sentiment.limit_down_count ?? '-'}</strong>
                {sentiment.date && (
                  <span style={{ marginLeft: 8, color: '#8b949e', fontSize: 12 }}>（{sentiment.date}）</span>
                )}
              </div>
              {market.aiBrief && (
                <div style={{ marginTop: 12, color: '#8b949e', whiteSpace: 'pre-wrap' }}>
                  {market.aiBrief}
                </div>
              )}
            </div>
          ) : (
            <div style={{ color: '#8b949e' }}>暂无数据，稍后自动加载</div>
          )}
        </div>

        <div className="card">
          <div className="card-title">🔴 最新风控预警</div>
          {alerts.length === 0 ? (
            <div style={{ color: '#8b949e' }}>暂无未处理预警</div>
          ) : (
            <div>
              {alerts.slice(0, 6).map((a) => (
                <div key={a.id} style={{ marginBottom: 8 }}>
                  <Badge kind={a.level}>{a.alert_type}</Badge>{' '}
                  <span style={{ marginLeft: 8 }}>{a.message}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <div className="card-title">📈 今日信号汇总 Top 10</div>
        {signals.length === 0 ? (
          <div style={{ color: '#8b949e' }}>暂无信号，去"自选池扫描"生成信号</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>代码</th>
                <th>名称</th>
                <th>信号</th>
                <th>期望值</th>
                <th>CANSLIM</th>
                <th>赔率比</th>
                <th>枢轴</th>
                <th>止损</th>
                <th>目标</th>
              </tr>
            </thead>
            <tbody>
              {signals.slice(0, 10).map((s) => (
                <tr key={s.id}>
                  <td>
                    <a onClick={() => (location.hash = `#/stock/${s.code}`)}>{s.code}</a>
                  </td>
                  <td>{s.name}</td>
                  <td>{signalBadge(s.signal_type)}</td>
                  <td>
                    <strong>{s.expected_score?.toFixed(1)}</strong>
                  </td>
                  <td>{s.canslim_score?.toFixed(1)}</td>
                  <td>{s.odds_ratio}</td>
                  <td>{s.pivot_price?.toFixed(2)}</td>
                  <td>{s.stop_loss?.toFixed(2)}</td>
                  <td>{s.target_price?.toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

// ============ 持仓管理 ============
function Positions() {
  const [list, setList] = useState([]);
  const [showForm, setShowForm] = useState(false);
  const [lookingUp, setLookingUp] = useState(false);
  const emptyForm = {
    code: '', name: '',
    buy_date: new Date().toISOString().slice(0, 10),
    buy_price: '', quantity: '', buy_logic: '', stop_loss: '', target_price: '',
  };
  const [form, setForm] = useState(emptyForm);

  async function refresh() {
    const r = await API.get('/positions');
    setList(r.data || []);
  }
  useEffect(() => { refresh(); }, []);

  // 代码框失焦时自动查询股票名称
  async function onCodeBlur() {
    const code = form.code.trim();
    if (!code || form.name) return;
    setLookingUp(true);
    try {
      const r = await API.post('/stocks', { code, is_watch: false });
      if (r.ok && r.data?.name) {
        setForm(f => ({ ...f, name: r.data.name }));
      }
    } catch (_) {}
    setLookingUp(false);
  }

  async function submit(e) {
    e.preventDefault();
    const body = { ...form };
    ['buy_price', 'quantity', 'stop_loss', 'target_price'].forEach((k) => {
      if (body[k] !== '') body[k] = +body[k];
      else delete body[k];
    });
    await API.post('/positions', body);
    setShowForm(false);
    setForm(emptyForm);
    refresh();
  }

  async function closePosition(p) {
    const price = prompt('卖出价：', p.current_price);
    if (!price) return;
    await API.post(`/positions/${p.id}/close`, {
      sell_date: new Date().toISOString().slice(0, 10),
      sell_price: +price,
      sell_reason: prompt('原因：') || '',
    });
    refresh();
  }

  // 持仓饼图
  const pieRef = useECharts(
    {
      tooltip: { trigger: 'item', formatter: '{b}<br/>¥{c} ({d}%)' },
      legend: { bottom: 0, textStyle: { color: '#c9d1d9' } },
      series: [
        {
          type: 'pie',
          radius: ['40%', '65%'],
          data: list.map((p) => ({
            name: `${p.code} ${p.name || ''}`,
            value: +((p.current_price || p.buy_price) * p.quantity).toFixed(0),
          })),
          label: { color: '#c9d1d9' },
        },
      ],
    },
    [list]
  );

  return (
    <div>
      <h2 className="page-title">持仓管理</h2>
      <div className="toolbar">
        <button className="btn" onClick={() => setShowForm(true)}>
          + 添加持仓
        </button>
        <button
          className="btn secondary"
          onClick={async () => {
            const r = await API.post('/alerts/check');
            alert(`生成 ${r.alerts.length} 条预警`);
          }}
        >
          执行风控检查
        </button>
      </div>

      {list.length > 0 && (
        <div className="card">
          <div className="card-title">持仓分布</div>
          <div ref={pieRef} className="chart-container" style={{ height: 280 }} />
        </div>
      )}

      <div className="card">
        <table>
          <thead>
            <tr>
              <th>代码</th>
              <th>名称</th>
              <th>买入日</th>
              <th>买入价</th>
              <th>数量</th>
              <th>现价</th>
              <th>市值</th>
              <th>盈亏</th>
              <th>止损</th>
              <th>目标</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {list.map((p) => (
              <tr key={p.id}>
                <td>
                  <a onClick={() => (location.hash = `#/stock/${p.code}`)}>{p.code}</a>
                </td>
                <td>{p.name}</td>
                <td>{p.buy_date}</td>
                <td>{p.buy_price}</td>
                <td>{p.quantity}</td>
                <td>{p.current_price?.toFixed(2)}</td>
                <td>{((p.current_price || p.buy_price) * p.quantity).toFixed(2)}</td>
                <td className={p.pnl >= 0 ? 'bull' : 'bear'}>
                  {p.pnl >= 0 ? '+' : ''}
                  {p.pnl?.toFixed(0)} ({(p.pnl_pct * 100).toFixed(2)}%)
                </td>
                <td>{p.stop_loss?.toFixed(2)}</td>
                <td>{p.target_price || '-'}</td>
                <td>
                  <button className="btn danger" onClick={() => closePosition(p)}>
                    平仓
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {showForm && (
        <div className="modal-backdrop" onClick={() => setShowForm(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>添加持仓</h3>
            <form onSubmit={submit}>
              <div className="form-row">
                <label>
                  股票代码（6位）
                  {lookingUp && <span style={{color:'#8b949e',marginLeft:8}}>查询中…</span>}
                  {form.name && !lookingUp && <span style={{color:'#3fb950',marginLeft:8,fontWeight:600}}>{form.name}</span>}
                </label>
                <input
                  required
                  value={form.code}
                  onChange={(e) => setForm({ ...form, code: e.target.value, name: '' })}
                  onBlur={onCodeBlur}
                  placeholder="如 600519，失焦后自动带出名称"
                />
              </div>
              <div className="grid grid-2">
                <div className="form-row">
                  <label>买入日期</label>
                  <input
                    type="date"
                    required
                    value={form.buy_date}
                    onChange={(e) => setForm({ ...form, buy_date: e.target.value })}
                  />
                </div>
                <div className="form-row">
                  <label>买入价</label>
                  <input
                    type="number"
                    step="0.001"
                    required
                    value={form.buy_price}
                    onChange={(e) => setForm({ ...form, buy_price: e.target.value })}
                  />
                </div>
                <div className="form-row">
                  <label>数量（股）</label>
                  <input
                    type="number"
                    required
                    value={form.quantity}
                    onChange={(e) => setForm({ ...form, quantity: e.target.value })}
                  />
                </div>
                <div className="form-row">
                  <label>止损位（默认买入价×0.92）</label>
                  <input
                    type="number"
                    step="0.001"
                    value={form.stop_loss}
                    onChange={(e) => setForm({ ...form, stop_loss: e.target.value })}
                  />
                </div>
                <div className="form-row">
                  <label>目标价</label>
                  <input
                    type="number"
                    step="0.001"
                    value={form.target_price}
                    onChange={(e) => setForm({ ...form, target_price: e.target.value })}
                  />
                </div>
              </div>
              <div className="form-row">
                <label>买入逻辑</label>
                <textarea
                  rows={3}
                  value={form.buy_logic}
                  onChange={(e) => setForm({ ...form, buy_logic: e.target.value })}
                />
              </div>
              <button className="btn" type="submit">
                保存
              </button>
              <button
                className="btn secondary"
                type="button"
                onClick={() => setShowForm(false)}
              >
                取消
              </button>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

// ============ 自选池扫描 ============
function WatchList() {
  const [list, setList] = useState([]);
  const [signals, setSignals] = useState([]);
  const [newCode, setNewCode] = useState('');
  const [scanning, setScanning] = useState(false);
  const [scanningCodes, setScanningCodes] = useState({});

  async function refresh() {
    const [w, s] = await Promise.all([
      API.get('/stocks?watch=true'),
      API.get('/signals?today=true'),
    ]);
    setList(w.data || []);
    setSignals(s.data || []);
  }
  useEffect(() => {
    refresh();
  }, []);

  async function addCode() {
    if (!newCode) return;
    await API.post('/stocks', { code: newCode, is_watch: true });
    setNewCode('');
    refresh();
  }

  async function scan() {
    setScanning(true);
    try {
      await API.post('/analyze/brief', { kind: 'manual', force: true });
      refresh();
    } finally {
      setScanning(false);
    }
  }

  async function scanOne(code) {
    setScanningCodes((prev) => ({ ...prev, [code]: true }));
    try {
      await API.post('/analyze/stock', { code, force: true });
      refresh();
    } finally {
      setScanningCodes((prev) => { const n = { ...prev }; delete n[code]; return n; });
    }
  }

  const byCode = Object.fromEntries(signals.map((s) => [s.code, s]));

  return (
    <div>
      <h2 className="page-title">自选池扫描</h2>
      <div className="toolbar">
        <input
          placeholder="输入股票代码（如 600519）"
          value={newCode}
          onChange={(e) => setNewCode(e.target.value)}
        />
        <button className="btn" onClick={addCode}>
          加入自选
        </button>
        <button className="btn secondary" onClick={scan} disabled={scanning}>
          {scanning ? '扫描中…' : '全量扫描（生成信号）'}
        </button>
      </div>

      <div className="grid grid-3">
        {list.map((s) => {
          const sig = byCode[s.code];
          const klass = sig?.signal_type?.toLowerCase().replace('_', '-');
          return (
            <div className="signal-card" key={s.code}>
              <div className="header">
                <div>
                  <div className="code">
                    <a onClick={() => (location.hash = `#/stock/${s.code}`)}>
                      {s.code} {s.name || ''}
                    </a>
                  </div>
                  <div className="meta">{s.industry || '-'}</div>
                </div>
                {sig && (
                  <div className={`score ${klass}`}>{sig.expected_score?.toFixed(0)}</div>
                )}
              </div>
              {sig ? (
                <div>
                  <div>{signalBadge(sig.signal_type)}</div>
                  <div style={{ marginTop: 6 }} className="meta">
                    CANSLIM {sig.canslim_score?.toFixed(0)} · 赔率 {sig.odds_ratio}
                  </div>
                  <div className="meta">
                    枢轴 {sig.pivot_price?.toFixed(2)} · 止损 {sig.stop_loss?.toFixed(2)} · 目标{' '}
                    {sig.target_price?.toFixed(2)}
                  </div>
                </div>
              ) : (
                <div className="meta">暂无信号</div>
              )}
              <div style={{ marginTop: 10, display: 'flex', gap: 8 }}>
                <button
                  className="btn"
                  disabled={!!scanningCodes[s.code]}
                  onClick={() => scanOne(s.code)}
                >
                  {scanningCodes[s.code] ? '分析中…' : '扫描'}
                </button>
                <button
                  className="btn secondary"
                  onClick={async () => {
                    if (!confirm('移除自选？')) return;
                    await API.patch(`/stocks/${s.code}/watch`, { watch: false });
                    refresh();
                  }}
                >
                  移除自选
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ============ 个股详情 ============
function StockDetail({ code }) {
  const [data, setData] = useState(null);
  const [prices, setPrices] = useState([]);
  const [loading, setLoading] = useState(false);

  async function load() {
    setLoading(true);
    try {
      const [a, c] = await Promise.all([
        API.post('/analyze/stock', { code, force: true }),
        API.get(`/chart/${code}`),
      ]);
      setData(a);
      setPrices(c.data || []);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, [code]);

  // K线图 + MA + 成交量
  const klineRef = useECharts(
    {
      animation: false,
      legend: { data: ['K线', 'MA5', 'MA10', 'MA20', 'MA60'], textStyle: { color: '#c9d1d9' } },
      tooltip: { trigger: 'axis', axisPointer: { type: 'cross' } },
      axisPointer: { link: [{ xAxisIndex: 'all' }] },
      grid: [
        { left: 50, right: 20, top: 40, height: '55%' },
        { left: 50, right: 20, top: '70%', height: '20%' },
      ],
      xAxis: [
        {
          type: 'category',
          data: prices.map((p) => p.date),
          boundaryGap: false,
          axisLine: { lineStyle: { color: '#30363d' } },
          axisLabel: { color: '#8b949e' },
        },
        {
          type: 'category',
          gridIndex: 1,
          data: prices.map((p) => p.date),
          boundaryGap: false,
          axisLabel: { show: false },
        },
      ],
      yAxis: [
        {
          scale: true,
          splitLine: { lineStyle: { color: '#21262d' } },
          axisLabel: { color: '#8b949e' },
        },
        {
          gridIndex: 1,
          splitLine: { lineStyle: { color: '#21262d' } },
          axisLabel: { color: '#8b949e' },
        },
      ],
      dataZoom: [
        { type: 'inside', xAxisIndex: [0, 1], start: 70, end: 100 },
        { type: 'slider', xAxisIndex: [0, 1], start: 70, end: 100, bottom: 0 },
      ],
      series: [
        {
          name: 'K线',
          type: 'candlestick',
          data: prices.map((p) => [p.open, p.close, p.low, p.high]),
          itemStyle: {
            color: '#3fb950',
            color0: '#f85149',
            borderColor: '#3fb950',
            borderColor0: '#f85149',
          },
        },
        ...[5, 10, 20, 60].map((n) => ({
          name: `MA${n}`,
          type: 'line',
          data: calcMA(prices.map((p) => p.close), n),
          smooth: true,
          showSymbol: false,
          lineStyle: { width: 1 },
        })),
        {
          name: '成交量',
          type: 'bar',
          xAxisIndex: 1,
          yAxisIndex: 1,
          data: prices.map((p, i) => ({
            value: p.volume,
            itemStyle: {
              color: i > 0 && p.close >= prices[i - 1].close ? '#3fb950' : '#f85149',
            },
          })),
        },
      ],
    },
    [prices]
  );

  // CANSLIM 雷达
  const radarRef = useECharts(
    data?.canslim?.radar
      ? {
          tooltip: {},
          radar: {
            indicator: Object.keys(data.canslim.radar).map((k) => ({ name: k, max: 100 })),
            axisName: { color: '#c9d1d9' },
            splitLine: { lineStyle: { color: '#30363d' } },
            splitArea: { areaStyle: { color: ['#161b22', '#1f2937'] } },
          },
          series: [
            {
              type: 'radar',
              data: [
                {
                  value: Object.values(data.canslim.radar),
                  name: 'CANSLIM',
                  areaStyle: { color: 'rgba(88,166,255,0.3)' },
                  lineStyle: { color: '#58a6ff' },
                },
              ],
            },
          ],
        }
      : {},
    [data]
  );

  if (loading) return <div className="loading">加载中…</div>;
  if (!data) return <div className="loading">无数据</div>;
  if (!data.ok) return <div className="loading">错误：{data.error}</div>;

  const d = data.canslim.dimensions;

  return (
    <div>
      <h2 className="page-title">
        {data.code} {data.name || ''}
        <span style={{ marginLeft: 12, fontSize: 14, color: '#8b949e' }}>
          行业：{data.industry || '-'} · 最新：{data.price}
        </span>
      </h2>

      <div className="grid grid-4">
        <div className="stat">
          <div className="label">期望值综合</div>
          <div className="value">{data.expected.expected}</div>
        </div>
        <div className="stat">
          <div className="label">CANSLIM</div>
          <div className="value">{data.canslim.score}</div>
        </div>
        <div className="stat">
          <div className="label">赔率比</div>
          <div className="value">{data.odds.oddsRatio}</div>
        </div>
        <div className="stat">
          <div className="label">信号</div>
          <div className="value">{signalBadge(data.expected.signal)}</div>
        </div>
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <div className="card-title">K线 + MA + 成交量</div>
        <div ref={klineRef} className="chart-container" style={{ height: 480 }} />
      </div>

      <div className="grid grid-2" style={{ marginTop: 16 }}>
        <div className="card">
          <div className="card-title">CANSLIM 雷达</div>
          <div ref={radarRef} className="chart-container" style={{ height: 340 }} />
        </div>
        <div className="card">
          <div className="card-title">维度依据</div>
          <table>
            <tbody>
              {Object.entries(d).map(([k, v]) => (
                <tr key={k}>
                  <td style={{ fontWeight: 600 }}>{k}</td>
                  <td>{v.score?.toFixed(1)}</td>
                  <td>{v.reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <div className="card-title">📍 赔率卡</div>
        <div className="grid grid-4">
          <div>
            枢轴点：<strong>{data.odds.pivot}</strong>
          </div>
          <div>
            止损：<strong style={{ color: '#f85149' }}>{data.odds.stopLoss}</strong>
          </div>
          <div>
            目标价：<strong style={{ color: '#3fb950' }}>{data.odds.targetPrice}</strong>
          </div>
          <div>
            上行 {data.odds.upsidePct}% / 下行 {data.odds.downsidePct}%
          </div>
        </div>
        {data.pattern && (
          <div style={{ marginTop: 10, color: '#8b949e' }}>
            形态：{data.pattern.pattern} · 置信度 {data.pattern.confidence} ·{' '}
            {data.pattern.breakout ? '✅ 已突破' : '⏳ 未突破'}
          </div>
        )}
      </div>

      {data.aiComment && (
        <div className="card" style={{ marginTop: 16 }}>
          <div className="card-title">🤖 AI 点评 {data.mockAi ? '(Mock)' : ''}</div>
          <div style={{ whiteSpace: 'pre-wrap', color: '#c9d1d9' }}>{data.aiComment}</div>
        </div>
      )}

      <div className="card" style={{ marginTop: 16 }}>
        <div className="card-title">操作建议</div>
        <div>{data.expected.action}</div>
      </div>
    </div>
  );
}

function calcMA(closes, n) {
  const out = [];
  for (let i = 0; i < closes.length; i++) {
    if (i < n - 1) out.push('-');
    else {
      let s = 0;
      for (let j = i - n + 1; j <= i; j++) s += closes[j];
      out.push((s / n).toFixed(3));
    }
  }
  return out;
}

// ============ 风控中心 ============
function RiskCenter() {
  const [alerts, setAlerts] = useState([]);
  const [rules, setRules] = useState({});
  const [form, setForm] = useState(null); // null = 只读，非null = 编辑中
  const [saving, setSaving] = useState(false);
  const [positions, setPositions] = useState([]);

  async function refresh() {
    const [a, r, p] = await Promise.all([
      API.get('/alerts'),
      API.get('/risk/rules'),
      API.get('/positions'),
    ]);
    setAlerts(a.data || []);
    setRules(r.data || {});
    setPositions(p.data || []);
  }

  async function saveRules() {
    setSaving(true);
    const payload = {
      STOP_LOSS_PCT: +form.STOP_LOSS_PCT / 100,
      SINGLE_POSITION_MAX: +form.SINGLE_POSITION_MAX / 100,
      INDUSTRY_MAX: +form.INDUSTRY_MAX / 100,
      HOLDINGS_MAX: +form.HOLDINGS_MAX,
      TREND_SCORE_MIN: +form.TREND_SCORE_MIN,
    };
    const r = await API.put('/risk/rules', payload);
    setRules(r.data || {});
    setForm(null);
    setSaving(false);
  }

  useEffect(() => {
    refresh();
  }, []);

  const indMap = {};
  let total = 0;
  for (const p of positions) {
    const v = (p.current_price || p.buy_price) * p.quantity;
    total += v;
    const ind = p.industry || '未分类';
    indMap[ind] = (indMap[ind] || 0) + v;
  }

  const barRef = useECharts(
    {
      tooltip: { trigger: 'axis' },
      grid: { left: 60, right: 20, top: 20, bottom: 30 },
      xAxis: {
        type: 'category',
        data: positions.map((p) => p.code),
        axisLabel: { color: '#8b949e' },
      },
      yAxis: {
        type: 'value',
        axisLabel: { formatter: '{value}%', color: '#8b949e' },
        splitLine: { lineStyle: { color: '#21262d' } },
      },
      series: [
        {
          type: 'bar',
          data: positions.map((p) =>
            total ? +(((p.current_price || p.buy_price) * p.quantity * 100) / total).toFixed(2) : 0
          ),
          itemStyle: { color: '#58a6ff' },
          markLine: {
            data: [{ yAxis: 15, lineStyle: { color: '#f85149' } }],
            label: { formatter: '单票上限15%', color: '#f85149' },
          },
        },
      ],
    },
    [positions]
  );

  const pieRef = useECharts(
    {
      tooltip: { trigger: 'item', formatter: '{b}<br/>{d}%' },
      legend: { bottom: 0, textStyle: { color: '#c9d1d9' } },
      series: [
        {
          type: 'pie',
          radius: ['35%', '60%'],
          data: Object.entries(indMap).map(([k, v]) => ({ name: k, value: +v.toFixed(0) })),
          label: { color: '#c9d1d9' },
        },
      ],
    },
    [positions]
  );

  return (
    <div>
      <h2 className="page-title">风控中心</h2>

      <div className="card">
        <div className="card-title" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span>风控规则</span>
          {form ? (
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn" onClick={saveRules} disabled={saving}>{saving ? '保存中…' : '保存'}</button>
              <button className="btn secondary" onClick={() => setForm(null)}>取消</button>
            </div>
          ) : (
            <button className="btn secondary" onClick={() => setForm({
              STOP_LOSS_PCT: (rules.STOP_LOSS_PCT * 100).toFixed(0),
              SINGLE_POSITION_MAX: (rules.SINGLE_POSITION_MAX * 100).toFixed(0),
              INDUSTRY_MAX: (rules.INDUSTRY_MAX * 100).toFixed(0),
              HOLDINGS_MAX: String(rules.HOLDINGS_MAX),
              TREND_SCORE_MIN: String(rules.TREND_SCORE_MIN),
            })}>编辑</button>
          )}
        </div>
        {form ? (
          <div className="grid grid-4" style={{ marginTop: 12 }}>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span style={{ color: '#8b949e', fontSize: 12 }}>止损线 %</span>
              <input className="input" type="number" min="1" max="30" step="1"
                value={form.STOP_LOSS_PCT} onChange={e => setForm({ ...form, STOP_LOSS_PCT: e.target.value })} />
            </label>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span style={{ color: '#8b949e', fontSize: 12 }}>单票上限 %</span>
              <input className="input" type="number" min="5" max="50" step="1"
                value={form.SINGLE_POSITION_MAX} onChange={e => setForm({ ...form, SINGLE_POSITION_MAX: e.target.value })} />
            </label>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span style={{ color: '#8b949e', fontSize: 12 }}>行业集中度 %</span>
              <input className="input" type="number" min="10" max="100" step="5"
                value={form.INDUSTRY_MAX} onChange={e => setForm({ ...form, INDUSTRY_MAX: e.target.value })} />
            </label>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span style={{ color: '#8b949e', fontSize: 12 }}>最大持仓数</span>
              <input className="input" type="number" min="1" max="50" step="1"
                value={form.HOLDINGS_MAX} onChange={e => setForm({ ...form, HOLDINGS_MAX: e.target.value })} />
            </label>
          </div>
        ) : (
          <div className="grid grid-4" style={{ marginTop: 12 }}>
            <div>止损线：<strong>{(rules.STOP_LOSS_PCT * 100).toFixed(0)}%</strong></div>
            <div>单票上限：<strong>{(rules.SINGLE_POSITION_MAX * 100).toFixed(0)}%</strong></div>
            <div>行业集中度：<strong>{(rules.INDUSTRY_MAX * 100).toFixed(0)}%</strong></div>
            <div>最大持仓数：<strong>{rules.HOLDINGS_MAX}</strong></div>
          </div>
        )}
      </div>

      <div className="grid grid-2" style={{ marginTop: 16 }}>
        <div className="card">
          <div className="card-title">单票仓位分布</div>
          <div ref={barRef} className="chart-container" style={{ height: 300 }} />
        </div>
        <div className="card">
          <div className="card-title">行业集中度</div>
          <div ref={pieRef} className="chart-container" style={{ height: 300 }} />
        </div>
      </div>

      <div className="card">
        <div className="card-title">预警历史</div>
        <table>
          <thead>
            <tr>
              <th>时间</th>
              <th>代码</th>
              <th>类型</th>
              <th>级别</th>
              <th>触发值</th>
              <th>阈值</th>
              <th>消息</th>
              <th>已推送</th>
            </tr>
          </thead>
          <tbody>
            {alerts.map((a) => (
              <tr key={a.id}>
                <td>{a.created_at}</td>
                <td>{a.code || '-'}</td>
                <td>{a.alert_type}</td>
                <td>
                  <Badge kind={a.level}>{a.level}</Badge>
                </td>
                <td>{a.trigger_value}</td>
                <td>{a.threshold}</td>
                <td>{a.message}</td>
                <td>{a.handled ? '✅' : '-'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ============ 回测工具 ============
function Backtest() {
  const [codes, setCodes] = useState('600519,000858,300750');
  const [start, setStart] = useState('2023-01-01');
  const [end, setEnd] = useState(new Date().toISOString().slice(0, 10));
  const [threshold, setThreshold] = useState(75);
  const [list, setList] = useState([]);
  const [current, setCurrent] = useState(null);
  const [running, setRunning] = useState(false);

  async function refresh() {
    const r = await API.get('/backtest');
    setList(r.data || []);
  }
  useEffect(() => {
    refresh();
  }, []);

  async function run() {
    setRunning(true);
    try {
      const r = await API.post('/backtest/run', {
        codes: codes.split(',').map((x) => x.trim()).filter(Boolean),
        start,
        end,
        buyThreshold: +threshold,
      });
      if (r.ok) {
        setCurrent(r.data);
        refresh();
      } else {
        alert('回测失败：' + r.error);
      }
    } finally {
      setRunning(false);
    }
  }

  async function loadOne(id) {
    const r = await API.get(`/backtest/${id}`);
    setCurrent(r.data);
  }

  const eqRef = useECharts(
    current
      ? {
          tooltip: { trigger: 'axis' },
          grid: { left: 60, right: 20, top: 20, bottom: 30 },
          xAxis: {
            type: 'category',
            data: current.equity_curve.map((e) => e.date),
            axisLabel: { color: '#8b949e' },
          },
          yAxis: {
            type: 'value',
            scale: true,
            axisLabel: { color: '#8b949e' },
            splitLine: { lineStyle: { color: '#21262d' } },
          },
          series: [
            {
              type: 'line',
              data: current.equity_curve.map((e) => e.value),
              smooth: true,
              showSymbol: false,
              areaStyle: { color: 'rgba(88,166,255,0.2)' },
              lineStyle: { color: '#58a6ff' },
            },
          ],
        }
      : {},
    [current]
  );

  return (
    <div>
      <h2 className="page-title">回测工具</h2>
      <div className="card">
        <div className="grid grid-4">
          <div className="form-row">
            <label>股票代码（逗号分隔）</label>
            <input value={codes} onChange={(e) => setCodes(e.target.value)} />
          </div>
          <div className="form-row">
            <label>开始</label>
            <input type="date" value={start} onChange={(e) => setStart(e.target.value)} />
          </div>
          <div className="form-row">
            <label>结束</label>
            <input type="date" value={end} onChange={(e) => setEnd(e.target.value)} />
          </div>
          <div className="form-row">
            <label>期望值买入阈值</label>
            <input
              type="number"
              value={threshold}
              onChange={(e) => setThreshold(e.target.value)}
            />
          </div>
        </div>
        <button className="btn" onClick={run} disabled={running}>
          {running ? '回测中…' : '开始回测'}
        </button>
      </div>

      {current && (
        <div className="card">
          <div className="card-title">回测结果</div>
          <div className="grid grid-4">
            <div className="stat">
              <div className="label">胜率</div>
              <div className="value">{(current.win_rate * 100).toFixed(1)}%</div>
            </div>
            <div className="stat">
              <div className="label">最大回撤</div>
              <div className="value">{(current.max_drawdown * 100).toFixed(2)}%</div>
            </div>
            <div className="stat">
              <div className="label">年化收益</div>
              <div className="value">{(current.annual_return * 100).toFixed(2)}%</div>
            </div>
            <div className="stat">
              <div className="label">夏普</div>
              <div className="value">{current.sharpe_ratio}</div>
            </div>
          </div>
          <div style={{ marginTop: 16 }}>
            <div className="card-title">权益曲线</div>
            <div ref={eqRef} className="chart-container" />
          </div>
          <div style={{ marginTop: 16 }}>
            <div className="card-title">逐笔交易（前20条）</div>
            <table>
              <thead>
                <tr>
                  <th>代码</th>
                  <th>动作</th>
                  <th>原因</th>
                  <th>买日</th>
                  <th>买价</th>
                  <th>卖日</th>
                  <th>卖价</th>
                  <th>数量</th>
                  <th>盈亏</th>
                </tr>
              </thead>
              <tbody>
                {(current.trades || []).slice(0, 20).map((t, i) => (
                  <tr key={i}>
                    <td>{t.code}</td>
                    <td>{t.action}</td>
                    <td>{t.reason}</td>
                    <td>{t.buyDate || '-'}</td>
                    <td>{t.buyPrice}</td>
                    <td>{t.sellDate || '-'}</td>
                    <td>{t.sellPrice || '-'}</td>
                    <td>{t.qty}</td>
                    <td className={t.pnl >= 0 ? 'bull' : 'bear'}>{t.pnl?.toFixed(0) || '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="card">
        <div className="card-title">历史回测</div>
        <table>
          <thead>
            <tr>
              <th>ID</th>
              <th>名称</th>
              <th>区间</th>
              <th>胜率</th>
              <th>年化</th>
              <th>最大回撤</th>
              <th>夏普</th>
              <th>时间</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {list.map((b) => (
              <tr key={b.id}>
                <td>{b.id}</td>
                <td>{b.name}</td>
                <td>
                  {b.start_date} ~ {b.end_date}
                </td>
                <td>{(b.win_rate * 100).toFixed(1)}%</td>
                <td>{(b.annual_return * 100).toFixed(2)}%</td>
                <td>{(b.max_drawdown * 100).toFixed(2)}%</td>
                <td>{b.sharpe_ratio}</td>
                <td>{b.created_at}</td>
                <td>
                  <button className="btn secondary" onClick={() => loadOne(b.id)}>
                    查看
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ============ 定时任务 ============
function SchedulerPage() {
  const [jobs, setJobs] = useState([]);
  const [triggering, setTriggering] = useState({});
  const [briefs, setBriefs] = useState([]);
  const [expandedBrief, setExpandedBrief] = useState(null);

  async function refresh() {
    const [jr, br] = await Promise.all([
      API.get('/scheduler/jobs'),
      API.get('/scheduler/briefs'),
    ]);
    setJobs(jr.data || []);
    setBriefs(br.data || []);
  }

  async function trigger(id) {
    setTriggering((t) => ({ ...t, [id]: true }));
    await API.post(`/scheduler/jobs/${id}/run`, {});
    await refresh();
    setTriggering((t) => ({ ...t, [id]: false }));
    setTimeout(refresh, 3000);
    setTimeout(refresh, 8000);
    setTimeout(refresh, 30000);
  }

  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, 5000);
    return () => clearInterval(timer);
  }, []);

  const statusStyle = (s) => ({
    idle:    { color: '#8b949e' },
    running: { color: '#e3b341' },
    success: { color: '#3fb950' },
    error:   { color: '#f85149' },
  }[s] || {});

  const statusLabel = { idle: '待机', running: '运行中', success: '成功', error: '失败' };

  const firstEnabled = jobs[0]?.schedulerEnabled;

  return (
    <div>
      <h2 className="page-title">定时任务</h2>

      {!firstEnabled && (
        <div className="card" style={{ borderColor: '#e3b341', marginBottom: 16 }}>
          <div style={{ color: '#e3b341' }}>
            ⚠️ 自动调度已禁用（当前为开发模式）。可通过下方按钮手动触发各任务。
            生产环境设置 <code>ENABLE_SCHEDULER=true</code> 启用自动调度。
          </div>
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {jobs.map((job) => (
          <div className="card" key={job.id}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
              <div>
                <div style={{ fontWeight: 600, marginBottom: 4 }}>{job.name}</div>
                <div style={{ color: '#8b949e', fontSize: 13, marginBottom: 8 }}>{job.desc}</div>
                <div style={{ fontSize: 12, color: '#8b949e' }}>
                  Cron：<code style={{ color: '#c9d1d9' }}>{job.cronExpr}</code>
                  {firstEnabled && <span style={{ marginLeft: 12 }}>自动调度：已启用</span>}
                </div>
              </div>
              <button
                className="btn secondary"
                disabled={job.status === 'running' || triggering[job.id]}
                onClick={() => trigger(job.id)}
                style={{ flexShrink: 0, marginLeft: 16 }}
              >
                {job.status === 'running' ? '运行中…' : '立即触发'}
              </button>
            </div>

            <div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid #21262d', display: 'flex', gap: 24, fontSize: 13 }}>
              <div>
                状态：<strong style={statusStyle(job.status)}>{statusLabel[job.status] || job.status}</strong>
              </div>
              <div>上次运行：{job.lastRunAt || '—'}</div>
              {job.lastDurationMs != null && (
                <div>耗时：{(job.lastDurationMs / 1000).toFixed(1)}s</div>
              )}
              {job.lastMsg && (
                <div style={{ color: job.status === 'error' ? '#f85149' : '#8b949e' }}>
                  结果：{job.lastMsg}
                </div>
              )}
            </div>
          </div>
        ))}
      </div>

      {briefs.length > 0 && (
        <div className="card" style={{ marginTop: 16 }}>
          <div className="card-title">历史简报</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>
            {briefs.map((b, i) => (
              <div key={i} style={{ borderBottom: '1px solid #21262d', paddingBottom: 8 }}>
                <div
                  style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', cursor: 'pointer' }}
                  onClick={() => setExpandedBrief(expandedBrief === i ? null : i)}
                >
                  <div>
                    <span style={{ marginRight: 12 }}>
                      {b.kind === 'morning' ? '📊 早盘简报' : '📋 收盘复盘'}
                    </span>
                    <span style={{ color: '#8b949e', fontSize: 13 }}>{b.date}</span>
                    {b.summary?.stats && (
                      <span style={{ color: '#8b949e', fontSize: 12, marginLeft: 12 }}>
                        扫描 {b.summary.stats.scanned} 只
                      </span>
                    )}
                  </div>
                  <span style={{ color: '#8b949e', fontSize: 12 }}>{expandedBrief === i ? '▲ 收起' : '▼ 展开'}</span>
                </div>
                {expandedBrief === i && (
                  <pre style={{
                    marginTop: 12, padding: 12, background: '#0d1117',
                    borderRadius: 6, fontSize: 13, lineHeight: 1.7,
                    whiteSpace: 'pre-wrap', color: '#c9d1d9', overflowX: 'auto',
                  }}>
                    {b.content}
                  </pre>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ============ 决策日志 ============
function DecisionLog() {
  const [data, setData] = useState({ data: [], accuracy: [] });
  async function refresh() {
    setData(await API.get('/decisions'));
  }
  useEffect(() => {
    refresh();
  }, []);

  return (
    <div>
      <h2 className="page-title">决策日志</h2>
      <div className="card">
        <div className="card-title">AI建议 vs 实际操作</div>
        <table>
          <thead>
            <tr>
              <th>AI建议</th>
              <th>用户操作</th>
              <th>次数</th>
            </tr>
          </thead>
          <tbody>
            {(data.accuracy || []).map((row, i) => (
              <tr key={i}>
                <td>{row.ai_signal || '-'}</td>
                <td>{row.user_action || '-'}</td>
                <td>{row.n}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="card">
        <div className="card-title">历史决策</div>
        <table>
          <thead>
            <tr>
              <th>时间</th>
              <th>代码</th>
              <th>AI建议</th>
              <th>期望值</th>
              <th>用户操作</th>
              <th>价格</th>
              <th>数量</th>
              <th>备注</th>
            </tr>
          </thead>
          <tbody>
            {(data.data || []).map((d) => (
              <tr key={d.id}>
                <td>{d.created_at}</td>
                <td>{d.code}</td>
                <td>{d.ai_signal}</td>
                <td>{d.ai_expected}</td>
                <td>{d.user_action}</td>
                <td>{d.user_price}</td>
                <td>{d.user_quantity}</td>
                <td>{d.note}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ============ AI 对话 ============
function AIChat() {
  const [msgs, setMsgs] = useState([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);

  async function send() {
    if (!input.trim()) return;
    const q = input;
    setInput('');
    setMsgs((m) => [...m, { role: 'user', content: q }]);
    setLoading(true);
    try {
      const r = await API.post('/chat', {
        system: '你是资深A股分析师，熟悉CANSLIM方法论与A股市场特点。回答简洁、有结构。',
        user: q,
      });
      setMsgs((m) => [...m, { role: 'ai', content: r.text || r.error || '无响应', mock: r.mock }]);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div>
      <h2 className="page-title">AI 对话</h2>
      <div className="card" style={{ minHeight: 400 }}>
        {msgs.map((m, i) => (
          <div key={i} style={{ marginBottom: 12 }}>
            <div style={{ color: m.role === 'user' ? '#58a6ff' : '#3fb950', fontWeight: 600 }}>
              {m.role === 'user' ? '你' : `AI ${m.mock ? '(Mock)' : ''}`}
            </div>
            <div style={{ whiteSpace: 'pre-wrap', marginTop: 4 }}>{m.content}</div>
          </div>
        ))}
        {loading && <div className="loading">思考中…</div>}
      </div>
      <div className="toolbar">
        <input
          style={{ flex: 1 }}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && send()}
          placeholder="问点什么，比如 600519 的投资机会"
        />
        <button className="btn" onClick={send} disabled={loading}>
          发送
        </button>
      </div>
    </div>
  );
}

// ============ App 路由 ============
function App() {
  const [route, setRoute] = useState(location.hash.slice(1) || '/dashboard');
  useEffect(() => {
    const h = () => setRoute(location.hash.slice(1) || '/dashboard');
    window.addEventListener('hashchange', h);
    return () => window.removeEventListener('hashchange', h);
  }, []);

  const nav = [
    ['/dashboard', '📊 仪表盘'],
    ['/positions', '💼 持仓管理'],
    ['/watchlist', '⭐ 自选池扫描'],
    ['/risk', '🛡️ 风控中心'],
    ['/backtest', '📈 回测工具'],
    ['/decisions', '📝 决策日志'],
    ['/scheduler', '⏰ 定时任务'],
    ['/chat', '🤖 AI 对话'],
  ];

  let page;
  if (route === '/dashboard') page = <Dashboard />;
  else if (route === '/positions') page = <Positions />;
  else if (route === '/watchlist') page = <WatchList />;
  else if (route.startsWith('/stock/')) page = <StockDetail code={route.split('/')[2]} />;
  else if (route === '/risk') page = <RiskCenter />;
  else if (route === '/backtest') page = <Backtest />;
  else if (route === '/decisions') page = <DecisionLog />;
  else if (route === '/scheduler') page = <SchedulerPage />;
  else if (route === '/chat') page = <AIChat />;
  else page = <Dashboard />;

  return (
    <div className="app">
      <div className="topbar">
        <div className="title">智能投资决策系统</div>
        <div className="meta">CANSLIM × 赔率/胜率 · 欧奈尔8%止损铁律</div>
      </div>
      <div className="layout">
        <div className="sidebar">
          {nav.map(([p, t]) => (
            <a
              key={p}
              className={'nav-item' + (route === p || route.startsWith(p + '/') ? ' active' : '')}
              onClick={() => (location.hash = '#' + p)}
            >
              {t}
            </a>
          ))}
        </div>
        <div className="main">{page}</div>
      </div>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<App />);
