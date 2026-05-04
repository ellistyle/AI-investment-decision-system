# A股智能投资决策系统

> 个人私有部署的 A股趋势交易决策辅助工具：CANSLIM × 赔率/胜率 × 欧奈尔8%止损铁律
> 详见 `../A股智能投资决策系统_PRD.docx`

## 特性
- **CANSLIM 评分引擎**（A股本土化权重，M维度一票否决）
- **赔率/胜率 + 期望值** 综合评分（PRD §3.2）
- **技术指标**：MA/MACD/KDJ + 杯柄/VCP/平台突破形态识别 + 枢轴点
- **多 Agent 体系**：市场Agent / 个股Agent / 风控Agent + Orchestrator（阿里百炼 qwen）
- **风控规则引擎**：纯代码、毫秒级响应（止损/仓位/集中度/趋势走坏）
- **微信推送**：OpenClaw → 文件传输助手；macOS 开发机自动 Mock 控制台
- **回测引擎**：胜率/盈亏比/最大回撤/夏普 + 权益曲线
- **React + ECharts 看板**：7 个页面，零构建即可运行（CDN 模式）
- **跨平台**：macOS 开发 / Ubuntu 生产，运行时自动切换行为

## 主要功能页面
<img width="2728" height="1528" alt="58913613be9bb54be7fe9603b68eac11" src="https://github.com/user-attachments/assets/d998f1d0-ab01-47ce-a1f0-c0f597884037" />
<img width="2738" height="1436" alt="cfdc2e616d98ee029d32d043d99c6210" src="https://github.com/user-attachments/assets/51af8a9d-7bd3-4e57-a725-0b17feeba6a7" />
<img width="2744" height="1566" alt="332ed7575d89844234386073954a7540" src="https://github.com/user-attachments/assets/102d727b-50f6-49af-9a54-d93a0d1a79bf" />
<img width="2690" height="1550" alt="67bbbab85a24b672385a53b943e013a0" src="https://github.com/user-attachments/assets/e02f2685-35fb-4800-a974-3fd9b39cbaee" />



## 目录结构

```
investment-system/
├── package.json               依赖
├── .env.example               环境变量模板
├── ecosystem.config.js        pm2 配置
├── config.js                  跨平台配置（macOS Mock / Linux 真实）
├── server.js                  Express 入口
├── database/
│   ├── init.js                better-sqlite3 初始化
│   ├── schema.sql             7 张核心表 + 行情/财务/北向/龙虎榜
│   └── repo.js                数据访问层
├── scripts/
│   ├── fetch_data.py          akshare 采集（行情/财务/北向/龙虎榜/指数）
│   └── pyrunner.js            Node 调 Python 的封装
├── engine/
│   ├── technical.js           MA/MACD/KDJ/52周高点/量比/RS
│   ├── pattern.js             杯柄/VCP/平台突破
│   ├── canslim.js             7 维评分（A股权重）
│   └── odds.js                赔率比 / 期望值 / 信号映射
├── agents/
│   ├── llm.js                 阿里百炼 qwen 调用
│   ├── market-agent.js        大盘 M 信号 + 情绪温度计
│   ├── stock-agent.js         个股全分析（CANSLIM+赔率+AI点评）
│   ├── risk-agent.js          风控规则引擎
│   └── orchestrator.js        协调 + 汇总报告
├── push/
│   └── wechat.js              OpenClaw 推送（含 Mock）
├── api/
│   └── routes.js              REST API
├── scheduler/
│   └── jobs.js                node-cron 定时任务
├── backtest/
│   └── engine.js              回测引擎
├── frontend/public/           React + ECharts 单页（CDN，零构建）
└── tests/
    └── smoke.test.js          引擎冒烟测试
```

## 快速开始

### 1. 安装依赖

```bash
cd investment-system
npm install

# Python 数据采集需要 akshare（首次较慢）
pip3 install akshare pandas
```

### 2. 配置环境变量

```bash
cp .env.example .env
# 编辑 .env：
#   - DASHSCOPE_API_KEY (阿里百炼控制台获取；不填则 AI 走 Mock)
#   - OPENCLAW_URL / TOKEN (生产用；macOS 自动 Mock)
```

### 3. 初始化数据库（首次）

```bash
npm run init-db
```
> 数据库文件落在 `~/.investment-system/data.db`

### 4. 启动服务

```bash
# 开发模式（macOS）
npm run dev

# 生产模式（Ubuntu，建议 pm2）
NODE_ENV=production pm2 start ecosystem.config.js
```

### 5. 访问

- Web: http://localhost:3000
- API health: http://localhost:3000/api/health

## 核心使用流程

### 每日操作（个人散户）

1. **添加自选**：自选池扫描页 → 输入代码 → 加入自选
2. **录入持仓**：持仓管理页 → + 添加持仓（系统自动按买入价 ×0.92 设止损）
3. **早盘扫描**：仪表盘 → 生成早盘简报（自动 CANSLIM + 赔率分析 + 推送）
4. **个股复盘**：点击代码 → 看 K线 / CANSLIM 雷达 / AI 点评 / 赔率卡
5. **风控检查**：交易时间内每 5 分钟自动轮询；红色预警立即推送

### 关键命令行

```bash
# 跑一次完整扫描（控制台输出）
node -e "require('./agents/orchestrator').runDailyBrief({force:true}).then(r=>console.log(JSON.stringify(r,null,2)))"

# 单股票分析
node -e "require('./agents/stock-agent').analyzeStock('600519',{force:true}).then(r=>console.log(JSON.stringify(r,null,2)))"

# 跑测试
npm test
```

## 决策模型摘要

### CANSLIM 加权（PRD §3.1）
| 维度 | 权重 | 阈值 |
|---|---|---|
| C 当季EPS | 20% | 同比 >25% |
| A 年度EPS | 15% | 3年均增速 >25% |
| N 新高 | 20% | 距52周高点 <-15% |
| S 量价 | 20% | 突破时 >均量 180% |
| L 相对强度 | 15% | RS >80分位 |
| I 机构 | 5% | 北向+基金 |
| M 大盘 | 一票否决 | 上证+创业板双确认 |

### 期望值映射
- ≥ 75 → **BUY_STRONG** 强烈买入
- 60-74 → **BUY_WATCH** 关注买入
- 45-59 → **HOLD** 持有观望
- < 45 → **AVOID** 回避/止损

### 赔率/期望值（PRD §3.2）
```
赔率比 = 上行空间 ÷ 下行风险（欧奈尔8%作为下行）
期望值得分 = CANSLIM × 0.6 + 赔率得分 × 0.4
```
赔率比 < 1.5 直接回避；> 2.0 才考虑。

### 风控（PRD §3.5）
- 🔴 持仓回撤 ≥ 8% → 立即推送，强制止损
- 🔴 单票仓位 > 15% → 立即推送
- 🟡 单行业 > 40% → 推送预警
- 🟡 持仓 > 10 只 → 提示分散

## 部署到 Ubuntu

```bash
# 服务器上：
git pull   # 或 scp 项目目录
cd investment-system
npm install --production
cp .env.example .env && vi .env
npm run init-db

# 安装 OpenClaw（参考其文档）配置好 OPENCLAW_URL
npm install -g pm2
pm2 start ecosystem.config.js
pm2 save && pm2 startup
```

局域网访问：将 PORT 暴露到局域网（无需域名/HTTPS）。

## 系统局限性（PRD §8）

- akshare 免费数据延迟（通常 T+1），不适用日内短线
- 北向资金 15 分钟延迟
- AI 不预测未来；最终决策由用户承担
- 欧奈尔 8% 止损铁律为核心风控，**严格执行，不因任何理由例外**

---

> 投资有风险，入市需谨慎。本系统输出不构成投资建议。
