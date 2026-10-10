// Reading Codex's own session logs (~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl). Pure helpers, no `$`.
// Logs can be gigabytes, so the caller dumps only each file's first line and last lines.

export type CodexThread = {
  id: string
  name: string
  folder: string
  from: string
  updatedAt: number
  status: 'working' | 'idle'
  lastReply: string
}

const short = (text: string, max: number) => (text.length > max ? text.slice(0, max - 1) + '…' : text)

// The day folders to look in: today back `days` days.
export function dayDirs(home: string, days: number, now = Date.now()): string[] {
  const out: string[] = []
  for (let i = 0; i < days; i++) {
    const d = new Date(now - i * 86400000)
    out.push(`${home}/.codex/sessions/${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`)
  }
  return out
}

export const idFromFile = (name: string) => (name.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/) ?? [])[1] ?? ''

// The shell commands that print, per file, a marker, the first line and the last 60 lines.
export function dumpArgv(windows: boolean, files: string[]): string[] {
  if (windows) {
    const list = files.map(f => `'${f.replace(/'/g, "''")}'`).join(',')
    return [
      'powershell',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      // Byte reads, not Get-Content: a log can be gigabytes and -Tail crawls on those.
      `[Console]::OutputEncoding=[Text.Encoding]::UTF8; foreach ($f in @(${list})) { '@@FILE ' + $f; $s=[IO.File]::Open($f,'Open','Read','ReadWrite'); try { $n=[Math]::Min($s.Length,131072); $b=New-Object byte[] $n; [void]$s.Read($b,0,$n); $h=[Text.Encoding]::UTF8.GetString($b); $i=$h.IndexOf([char]10); if ($i -ge 0) { $h=$h.Substring(0,$i) }; $h; '@@TAIL'; $m=[Math]::Min($s.Length,98304); [void]$s.Seek(-$m,'End'); $b=New-Object byte[] $m; [void]$s.Read($b,0,$m); [Text.Encoding]::UTF8.GetString($b) } finally { $s.Close() } }`,
    ]
  }
  return ['sh', '-c', 'for f; do echo "@@FILE $f"; head -c 131072 "$f" | head -n 1; echo; echo "@@TAIL"; tail -c 98304 "$f"; echo; done', 'sh', ...files]
}

// Turns the dump into threads. `names` maps thread id to the name the Codex app gave it.
export function parseDump(stdout: string, names: Record<string, string>, mtimes: Record<string, number>): CodexThread[] {
  const out: CodexThread[] = []
  for (const block of stdout.split('@@FILE ').slice(1)) {
    const nl = block.indexOf('\n')
    const file = block.slice(0, nl).trim()
    const rest = block.slice(nl + 1)
    const [head, tail = ''] = rest.split('@@TAIL')
    const id = idFromFile(file.replace(/\\/g, '/'))
    if (!id) continue
    let folder = ''
    let from = 'Codex'
    try {
      const meta = JSON.parse(head.trim().split('\n')[0]).payload ?? {}
      folder = String(meta.cwd ?? '').replace(/\\/g, '/').split('/').filter(Boolean).pop() ?? ''
      from = String(meta.originator ?? '').includes('Desktop') ? 'Codex app' : String(meta.source ?? '') === 'exec' ? 'Codex CLI' : 'Codex'
    } catch {
      // keep defaults
    }
    let lastReply = ''
    let open = false
    for (const line of tail.split('\n')) {
      let d: any
      try {
        d = JSON.parse(line)
      } catch {
        continue
      }
      const p = d.payload ?? {}
      if (d.type === 'event_msg' && p.type === 'task_started') open = true
      if (d.type === 'event_msg' && p.type === 'task_complete') {
        open = false
        if (p.last_agent_message) lastReply = String(p.last_agent_message)
      }
      if (d.type === 'event_msg' && p.type === 'agent_message' && p.message) lastReply = String(p.message)
    }
    // Codex's own background safety checks, not threads the user started.
    if (names[id] === 'Guardian review' || lastReply.startsWith('{"risk_level"')) continue
    const updatedAt = mtimes[id] ?? 0
    out.push({
      id,
      name: names[id] || (folder ? `${folder} thread` : 'Codex thread'),
      folder,
      from,
      updatedAt,
      status: open && Date.now() - updatedAt < 15 * 60000 ? 'working' : 'idle',
      lastReply: short(lastReply.replace(/\s+/g, ' ').trim(), 600),
    })
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt)
}

export function parseIndex(text: string): Record<string, string> {
  const names: Record<string, string> = {}
  for (const line of text.split('\n')) {
    try {
      const r = JSON.parse(line)
      if (r.id && r.thread_name) names[r.id] = String(r.thread_name)
    } catch {
      // skip
    }
  }
  return names
}
