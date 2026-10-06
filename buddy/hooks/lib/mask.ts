// Recording mode: hide secrets, emails, phone numbers, money and named clients on screen.
// Display only: Claude still reads the real text. Pure functions, no `$`.

const BAR = (n: number) => '█'.repeat(Math.max(4, Math.min(n, 12)))

// Known key shapes first, then "NAME=value" for anything called a key, token, secret or password.
const SECRETS: RegExp[] = [
  /\bsk-(?:ant-|proj-|live-|test-)?[A-Za-z0-9_-]{16,}/g,
  /\bAIza[0-9A-Za-z_-]{30,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{30,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{30,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\b(?:rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/g,
]
const NAMED_SECRET = /\b([A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|PWD)[A-Za-z0-9_]*["']?\s*[=:]\s*)(["']?)([^\s"',;]{6,})/gi
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g
const PHONE = /(?:\+\d{1,3}[\s.-]?)?\(?\b\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b/g
const MONEY = /(?:[$€£]\s?\d[\d,]*(?:\.\d+)?(?:\s?(?:k|K|m|M|bn|million|billion|thousand))?)|(?:\b\d[\d,]*(?:\.\d+)?\s?(?:USD|CAD|EUR|GBP|dollars)\b)/g

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

export function maskText(text: string, names: string[] = []): string {
  if (!text) return text
  let out = text
  for (const re of SECRETS) out = out.replace(re, m => BAR(m.length))
  out = out.replace(NAMED_SECRET, (_m, name: string, quote: string, value: string) => `${name}${quote}${BAR(value.length)}`)
  out = out.replace(EMAIL, '███@███')
  out = out.replace(PHONE, '███-███-████')
  out = out.replace(MONEY, m => (/^[$€£]/.test(m) ? `${m[0]}███` : '███'))
  for (const name of names) {
    if (name.length < 2) continue
    out = out.replace(new RegExp(`\\b${escapeRe(name)}\\b`, 'gi'), m => BAR(m.length))
  }
  return out
}

// Masks every string inside a value and keeps its shape, so tool rows still draw.
export function maskDeep<T>(value: T, names: string[] = [], depth = 0): T {
  if (depth > 8) return value
  if (typeof value === 'string') return maskText(value, names) as unknown as T
  if (Array.isArray(value)) return value.map(v => maskDeep(v, names, depth + 1)) as unknown as T
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = maskDeep(v, names, depth + 1)
    return out as T
  }
  return value
}

export const nameList = (raw: unknown) =>
  String(raw ?? '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)

// What a cold cache costs: the whole chat re-written to cache at 1.25x (5 min) or 2x (1 hour) the input price.
// Per-million input prices, US dollars, from Anthropic's published pricing (2026-10).
export function inputPrice(model: string): number {
  const m = model.toLowerCase()
  if (/fable|mythos/.test(m)) return 10
  if (/opus-5-5|opus-5\.5/.test(m)) return 4
  if (/opus/.test(m)) return 5
  if (/sonnet/.test(m)) return 2
  if (/haiku/.test(m)) return 1
  return 4
}

export function coldCost(tokens: number, model: string, cacheMinutes: number) {
  const price = inputPrice(model)
  const writeRate = cacheMinutes >= 60 ? 2 : 1.25
  const cold = (tokens / 1e6) * price * writeRate
  const warm = (tokens / 1e6) * price * (/fable|mythos/i.test(model) ? 0.025 : /opus-5-5|opus-5\.5/i.test(model) ? 0.05 : 0.1)
  return { cold, warm }
}
