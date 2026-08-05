// 翻译适配器：免费(Google/MyMemory) + AI(DeepSeek/智谱/OpenAI/通义千问，均为 OpenAI 兼容)
// 密钥由 host 传入，绝不下发 webview；报错时抹掉密钥相关字段。

export type Provider =
  | 'free-google'
  | 'free-mymemory'
  | 'openai'
  | 'deepseek'
  | 'glm'
  | 'qwen';

export type AdapterKind = 'free' | 'openai';

export interface ProviderMeta {
  label: string;
  kind: AdapterKind;
  baseUrl: string;
  model: string;
  needsKey: boolean;
  /** 获取 API Key 的外部链接 */
  keyLink?: string;
}

export const PROVIDERS: Record<Provider, ProviderMeta> = {
  'free-google': { label: 'Google 翻译（免费·非官方）', kind: 'free', baseUrl: '', model: '', needsKey: false },
  'free-mymemory': { label: 'MyMemory（免费·有额度）', kind: 'free', baseUrl: '', model: '', needsKey: false },
  deepseek: {
    label: 'DeepSeek',
    kind: 'openai',
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
    needsKey: true,
    keyLink: 'https://platform.deepseek.com/api_keys',
  },
  glm: {
    label: '智谱 GLM',
    kind: 'openai',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    model: 'glm-4-flash',
    needsKey: true,
    keyLink: 'https://open.bigmodel.cn/usercenter/apikeys',
  },
  openai: {
    label: 'OpenAI',
    kind: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    needsKey: true,
    keyLink: 'https://platform.openai.com/api-keys',
  },
  qwen: {
    label: '通义千问',
    kind: 'openai',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen-turbo',
    needsKey: true,
    keyLink: 'https://dashscope.console.aliyun.com/apiKey',
  },
};

const SYSTEM_PROMPT =
  'You are a translator. Translate the user message into Simplified Chinese (简体中文). ' +
  'Keep it natural and faithful to the original. Output ONLY the translation — no notes, no quotes, no source language.';

export interface TranslateConfig {
  provider: Provider;
  baseUrl: string;
  model: string;
  apiKey: string;
}

export async function translate(text: string, cfg: TranslateConfig): Promise<string> {
  const meta = PROVIDERS[cfg.provider];
  if (!meta) throw new Error(`未知引擎：${cfg.provider}`);
  const src = text.trim();
  if (!src) return '';
  switch (meta.kind) {
    case 'free':
      return cfg.provider === 'free-mymemory' ? myMemory(src) : google(src);
    case 'openai':
      return openaiCompatible(src, cfg);
  }
}

function clean(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

// 仅取状态/正文，绝不打印请求头或带 key 的 URL
async function errMsg(res: Response): Promise<string> {
  let body = '';
  try {
    body = await res.text();
  } catch {
    /* ignore */
  }
  return `HTTP ${res.status} ${res.statusText} ${body.slice(0, 300)}`;
}

async function google(text: string): Promise<string> {
  const url =
    'https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=zh-CN&dt=t&q=' +
    encodeURIComponent(text);
  const res = await fetch(url, { headers: { 'User-Agent': 'vscode-4chan/0.1' } });
  if (!res.ok) throw new Error(`Google 翻译 ${await errMsg(res)}`);
  const data = (await res.json()) as unknown;
  const segs = (data as unknown[][])[0] ?? [];
  const out = segs.map((seg) => (seg as unknown[])[0]).join('');
  const r = clean(out);
  if (!r) throw new Error('Google 翻译返回为空');
  return r;
}

async function myMemory(text: string): Promise<string> {
  const q = text.slice(0, 500); // MyMemory 单次长度有限
  const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(q)}&langpair=en|zh-CN`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`MyMemory ${await errMsg(res)}`);
  const data = (await res.json()) as { responseData?: { translatedText?: string } };
  const r = clean(data.responseData?.translatedText ?? '');
  if (!r) throw new Error('MyMemory 返回为空');
  return r;
}

async function openaiCompatible(text: string, cfg: TranslateConfig): Promise<string> {
  if (!cfg.apiKey) throw new Error('未设置 API Key（点 ⚙ → 高级设置）');
  const base = (cfg.baseUrl || '').replace(/\/$/, '');
  if (!base) throw new Error('未设置 BaseUrl（点 ⚙ → 高级设置）');
  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
    body: JSON.stringify({
      model: cfg.model,
      temperature: 0.2,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: text },
      ],
    }),
  });
  if (!res.ok) throw new Error(await errMsg(res));
  const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  const r = clean(data.choices?.[0]?.message?.content ?? '');
  if (!r) throw new Error('AI 返回为空');
  return r;
}
