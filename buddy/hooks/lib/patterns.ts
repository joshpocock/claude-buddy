// What counts as a send, a spend or a danger. Plain logic, no mods API, so it can be unit-tested.
// Pattern-based by design: it catches the known tools and commands, not every possible script.

export type Kind = 'danger' | 'spend' | 'send'

export type Hit = {
  kind: Kind
  // A short stable key for "approve all today", e.g. "gmail:send_message" or "host:api.apify.com".
  target: string
  // One line for the dialog.
  what: string
  // True when the call has a recipient field Buddy can rewrite to "me first".
  canSendToMe: boolean
}

const SHELL_TOOLS = new Set(['Bash', 'PowerShell', 'Monitor'])

// Connector (MCP) actions, matched on the part after the last "__".
const MCP_SEND = /^(send_message|send|reply|forward|post|publish|share_file|schedule_message|slack_send_message|slack_schedule_message|create_event|respond_to_event|upload)/i
const MCP_DANGER = /^(trash_|delete_|remove_|purge|destroy)/i
// Paid services, matched on the connector (server) name, plus the action that runs work.
const PAID_SERVER = /(apify|wavespeed|kie|elevenlabs|heygen|fal|replicate|openai|runway|luma|suno)/i
const PAID_ACTION = /(call-actor|call_actor|run|generate|create|text_to|speech|image|video|rag-web-browser|web-fetch)/i

// Hosts of paid APIs Josh and his audience call from scripts.
const PAID_HOSTS = [
  'api.apify.com',
  'api.wavespeed.ai',
  'api.kie.ai',
  'api.elevenlabs.io',
  'api.heygen.com',
  'fal.run',
  'queue.fal.run',
  'api.replicate.com',
  'api.openai.com',
  'api.runwayml.com',
  'api.anthropic.com',
  'generativelanguage.googleapis.com',
  'api.stability.ai',
  'api.mistral.ai',
  'api.together.xyz',
  'api.deepgram.com',
  'api.assemblyai.com',
  'api.lumalabs.ai',
  'api.suno.ai',
]

const DANGER_SHELL: [RegExp, string][] = [
  // Deleting one named file is routine; folders and wildcards are where work gets lost.
  [/\brm\s+([^\n;&|]*\s)?(-[a-zA-Z]*[rR][a-zA-Z]*|--recursive)\b/, 'delete a folder and everything in it (rm -r)'],
  [/\brm\s+[^\n;&|]*[*?]/, 'delete every file matching a wildcard (rm *)'],
  [/\bRemove-Item\b[^\n|;]*-Recurse\b/i, 'delete a folder and everything in it (Remove-Item -Recurse)'],
  [/\bRemove-Item\b[^\n|;]*[*?]/i, 'delete every file matching a wildcard (Remove-Item *)'],
  [/\b(rmdir|rd)\s+\/s\b/i, 'delete a folder (rmdir /s)'],
  [/\bdel\s+([^\n;&|]*\s)?\/s\b/i, 'delete files in every subfolder (del /s)'],
  [/\bdel\s+[^\n;&|]*\*/i, 'delete every file matching a wildcard (del *)'],
  [/\bgit\s+reset\s+--hard\b/i, 'wipe uncommitted changes (git reset --hard)'],
  [/\bgit\s+clean\s+-[a-z]*f/i, 'delete untracked files (git clean -f)'],
  [/\bgit\s+(checkout|restore)\s+(--\s+)?\.(\s|$)/i, 'discard all changes (git checkout/restore .)'],
  [/\bgit\s+push\b[^\n;|]*(--force\b|--force-with-lease\b|\s-f\b|\s\+\S)/i, 'force push (rewrites remote history)'],
  [/\bdrop\s+(table|database|schema)\b/i, 'drop a database table'],
  [/\b(prisma\s+migrate\s+reset|db:reset|supabase\s+db\s+reset)\b/i, 'reset a database'],
]

const SEND_SHELL: [RegExp, string, string][] = [
  [/\bgit\s+push\b/i, 'git:push', 'push code to the remote (git push)'],
  [/\bgh\s+(pr\s+(create|merge)|release\s+create|issue\s+create)\b/i, 'gh:publish', 'publish on GitHub (gh)'],
  [/\bvercel\b[^\n;|]*(--prod\b|\bdeploy\b)/i, 'vercel:deploy', 'deploy to Vercel'],
  [/\b(fly|flyctl)\s+deploy\b/i, 'fly:deploy', 'deploy to Fly.io'],
  [/\bnpm\s+publish\b/i, 'npm:publish', 'publish a package to npm'],
]

const WRITE_METHOD = /(-X\s*(POST|PUT|PATCH|DELETE)\b|--request\s+(POST|PUT|PATCH|DELETE)\b|\s(-d|--data\S*|-F|--form)\s|-Method\s+(Post|Put|Patch|Delete)\b|-Body\b)/i
const HTTP_CLIENT = /\b(curl|wget|Invoke-RestMethod|Invoke-WebRequest|irm|iwr|httpie|http)\b/i
const URL_HOST = /https?:\/\/([a-z0-9.-]+)/gi
const LOCAL_HOST = /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|[a-z0-9-]+\.localhost|[a-z0-9.-]+\.test)$/i

const short = (text: string, max: number) => (text.length > max ? text.slice(0, max - 1) + '…' : text)

export function hostsIn(command: string): string[] {
  const out: string[] = []
  for (const m of command.matchAll(URL_HOST)) out.push(m[1].toLowerCase())
  return out
}

// Text fed to a program through a heredoc (<<EOF ... EOF) is data, not a command:
// a script that merely mentions "rm -rf" or "git push" should not trip a guard.
export function stripHeredocs(command: string): string {
  return command.replace(/<<-?\s*(['"]?)([A-Za-z_]\w*)\1[^\n]*\n[\s\S]*?\n[ \t]*\2[ \t]*(?=\n|$)/g, '<<HEREDOC')
}

// Extra paid hosts from Buddy's settings (e.g. "api.stripe.com, api.twilio.com").
let extraPaidHosts: string[] = []
export function setExtraPaidHosts(list: string | undefined) {
  extraPaidHosts = (list ?? '')
    .split(',')
    .map(s => s.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, ''))
    .filter(Boolean)
}

export function classifyShell(command: string): Hit | undefined {
  const cmd = stripHeredocs(command).trim()
  for (const [re, what] of DANGER_SHELL) {
    if (re.test(cmd)) return { kind: 'danger', target: 'shell:' + what, what: `${what}: ${short(cmd, 120)}`, canSendToMe: false }
  }
  const hosts = hostsIn(cmd)
  const paid = hosts.find(h => [...PAID_HOSTS, ...extraPaidHosts].some(p => h === p || h.endsWith('.' + p)))
  if (paid && HTTP_CLIENT.test(cmd)) {
    return { kind: 'spend', target: 'host:' + paid, what: `paid API call to ${paid}: ${short(cmd, 120)}`, canSendToMe: false }
  }
  if (/\bapify\s+(call|run|actors\s+call)\b/i.test(cmd)) {
    return { kind: 'spend', target: 'cli:apify', what: `paid Apify run: ${short(cmd, 120)}`, canSendToMe: false }
  }
  for (const [re, target, what] of SEND_SHELL) {
    if (re.test(cmd)) return { kind: 'send', target, what: `${what}: ${short(cmd, 120)}`, canSendToMe: false }
  }
  const external = hosts.find(h => !LOCAL_HOST.test(h))
  if (external && HTTP_CLIENT.test(cmd) && WRITE_METHOD.test(cmd)) {
    return { kind: 'send', target: 'host:' + external, what: `send data to ${external}: ${short(cmd, 120)}`, canSendToMe: false }
  }
  return undefined
}

export function classifyMcp(tool: string, args: Record<string, unknown>): Hit | undefined {
  if (!tool.startsWith('mcp__')) return undefined
  const parts = tool.split('__')
  const server = parts[1] ?? ''
  const action = parts[parts.length - 1] ?? ''
  const label = `${server.replace(/^claude_ai_/, '')}:${action}`
  // Drafts never leave your account, so creating, updating or deleting one is not held.
  if (/draft/i.test(action)) return undefined
  if (MCP_DANGER.test(action)) {
    return { kind: 'danger', target: 'mcp:' + label, what: `${label}`, canSendToMe: false }
  }
  const readOnly = /^(get|list|search|abort|fetch-|read|describe|status)/i.test(action)
  if (PAID_SERVER.test(server) && !readOnly && PAID_ACTION.test(action)) {
    return { kind: 'spend', target: 'mcp:' + label, what: `${label}`, canSendToMe: false }
  }
  if (MCP_SEND.test(action) || /send|post|publish/i.test(action)) {
    const hasRecipient = 'to' in args || 'recipient' in args
    return { kind: 'send', target: 'mcp:' + label, what: `${label}`, canSendToMe: hasRecipient }
  }
  return undefined
}

export function classify(tool: string, input: Record<string, unknown>): Hit | undefined {
  if (SHELL_TOOLS.has(tool)) {
    const command = typeof input.command === 'string' ? input.command : ''
    return command ? classifyShell(command) : undefined
  }
  return classifyMcp(tool, input)
}

// What the call is about, for the dialog: recipient, subject and body when the tool has them.
export function describeArgs(args: Record<string, unknown>): string {
  const pick = (...keys: string[]) => {
    for (const k of keys) if (args[k] !== undefined && args[k] !== '') return args[k]
    return undefined
  }
  const fmt = (v: unknown, max: number) => short(typeof v === 'string' ? v : JSON.stringify(v), max)
  const to = pick('to', 'recipient', 'recipients', 'channel', 'channel_id', 'attendees')
  const subject = pick('subject', 'title', 'summary', 'name')
  const body = pick('body', 'text', 'message', 'content', 'description', 'input')
  const parts: string[] = []
  if (to !== undefined) parts.push(`To: ${fmt(to, 80)}`)
  if (subject !== undefined) parts.push(`Subject: ${fmt(subject, 80)}`)
  if (body !== undefined) parts.push(`"${fmt(body, 160)}"`)
  return parts.join(' | ')
}

// Rewrite a send so it reaches only me: recipient replaced, cc and bcc removed.
export function toMeOnly(args: Record<string, unknown>, myEmail: string): Record<string, unknown> | undefined {
  if (!myEmail) return undefined
  const out: Record<string, unknown> = { ...args }
  if ('to' in args) out.to = Array.isArray(args.to) ? [myEmail] : myEmail
  else if ('recipient' in args) out.recipient = myEmail
  else return undefined
  for (const k of ['cc', 'bcc', 'Cc', 'Bcc', 'ccRecipients', 'bccRecipients']) delete out[k]
  return out
}
