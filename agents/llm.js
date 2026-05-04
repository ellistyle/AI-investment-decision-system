// 阿里百炼（DashScope）客户端 - OpenAI 兼容接口
const axios = require('axios');
const config = require('../config');

async function chat({
  system,
  user,
  temperature = 0.3,
  maxTokens = 1500,
  model = config.ai.model,
}) {
  if (!config.ai.enabled) {
    return {
      ok: false,
      mock: true,
      text: mockResponse({ system, user }),
      reason: 'AI disabled (no DASHSCOPE_API_KEY)',
    };
  }
  try {
    const resp = await axios.post(
      config.ai.endpoint,
      {
        model,
        messages: [
          ...(system ? [{ role: 'system', content: system }] : []),
          { role: 'user', content: user },
        ],
        temperature,
        max_tokens: maxTokens,
      },
      {
        headers: {
          Authorization: `Bearer ${config.ai.apiKey}`,
          'Content-Type': 'application/json',
        },
        timeout: 60000,
      }
    );
    const text = resp.data?.choices?.[0]?.message?.content || '';
    return {
      ok: true,
      text,
      usage: resp.data?.usage,
    };
  } catch (e) {
    return {
      ok: false,
      error: e.response?.data?.error?.message || e.message,
      status: e.response?.status,
    };
  }
}

function mockResponse({ system, user }) {
  // 本地开发无 API KEY 时的降级：返回结构化文本说明
  return [
    '【Mock AI 响应 - 开发模式】',
    'System: ' + (system || '').slice(0, 100) + '…',
    'User  : ' + (user || '').slice(0, 100) + '…',
    '',
    '（配置 DASHSCOPE_API_KEY 后启用真实分析）',
  ].join('\n');
}

module.exports = { chat };
