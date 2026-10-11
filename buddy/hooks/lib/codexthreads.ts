// Reading Codex's own session logs (~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl). Pure helpers, no `$`.
// Logs can be gigabytes, so the caller dumps only a small slice of each file: the start (which
// holds the project folder) and the end (which holds the status and the last reply).

export type CodexThread = {
  id: string
  name: string
  project: string
  folder: string
  from: string
  updatedAt: number
  status: 'working' | 'idle'
  lastReply: string
}

const HEAD_BYTES = 8192
const TAIL_BYTES = 16384

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

// The commands that print, per file, a marker, its first bytes and its last bytes.
export function dumpArgv(windows: boolean, files: string[]): string[] {
  if (windows) {
    const list = files.map(f => `'${f.replace(/'/g, "''")}'`).join(',')
    return [
      'powershell',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      // Byte reads, not Get-Content: a log can be gigabytes and -Tail crawls on those.
      `[Console]::OutputEncoding=[Text.Encoding]::UTF8; foreach ($f in @(${list})) { '@@FILE ' + $f; $s=[IO.File]::Open($f,'Open','Read','ReadWrite'); try { $n=[Math]::Min($s.Length,${HEAD_BYTES}); $b=New-Object byte[] $n; [void]$s.Read($b,0,$n); [Text.Encoding]::UTF8.GetString($b); '@@TAIL'; $m=[Math]::Min($s.Length,${TAIL_BYTES}); [void]$s.Seek(-$m,'End'); $b=New-Object byte[] $m; [void]$s.Read($b,0,$m); [Text.Encoding]::UTF8.GetString($b) } finally { $s.Close() } }`,
    ]
  }
  return ['sh', '-c', `for f; do echo "@@FILE $f"; head -c ${HEAD_BYTES} "$f"; echo; echo "@@TAIL"; tail -c ${TAIL_BYTES} "$f"; echo; done`, 'sh', ...files]
}

// A JSON string field from a slice that may be cut off: "key":"value", unescaped.
function field(text: string, key: string): string {
  const m = text.match(new RegExp(`"${key}":"((?:[^"\\\\]|\\\\.)*)"`))
  if (!m) return ''
  try {
    return JSON.parse(`"${m[1]}"`)
  } catch {
    return m[1]
  }
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
    const project = field(head, 'cwd').replace(/\\/g, '/')
    const folder = project.split('/').filter(Boolean).pop() ?? ''
    const originator = field(head, 'originator')
    const source = field(head, 'source')
    const from = originator.includes('Desktop') ? 'Codex app' : source === 'exec' ? 'Codex CLI' : 'Codex'
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
      project,
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

// Threads grouped by project, projects ordered by their newest thread.
export function byProject(threads: CodexThread[]): { project: string; folder: string; threads: CodexThread[] }[] {
  const groups = new Map<string, { project: string; folder: string; threads: CodexThread[] }>()
  for (const t of threads) {
    const key = t.project || '(no project)'
    if (!groups.has(key)) groups.set(key, { project: key, folder: t.folder || 'No project', threads: [] })
    groups.get(key)!.threads.push(t)
  }
  return [...groups.values()].sort((a, b) => (b.threads[0]?.updatedAt ?? 0) - (a.threads[0]?.updatedAt ?? 0))
}

// Ids the Codex app named "Guardian review": its own safety checks, skipped before scanning.
export function guardianIds(index: Record<string, string>): Set<string> {
  return new Set(Object.entries(index).filter(([, n]) => n === 'Guardian review').map(([id]) => id))
}

// Pass 1: just each file's project folder, for every log in the given day folders. The folders are
// passed (not the files) so the command line stays short however many logs there are.
export function projectsArgv(windows: boolean, dirs: string[]): string[] {
  if (windows) {
    const list = dirs.map(d => `'${d.replace(/'/g, "''")}'`).join(',')
    return [
      'powershell',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `[Console]::OutputEncoding=[Text.Encoding]::UTF8; foreach ($d in @(${list})) { if (Test-Path -LiteralPath $d) { foreach ($e in Get-ChildItem -LiteralPath $d -Filter 'rollout-*.jsonl') { $s=[IO.File]::Open($e.FullName,'Open','Read','ReadWrite'); try { $n=[Math]::Min($s.Length,${HEAD_BYTES}); $b=New-Object byte[] $n; [void]$s.Read($b,0,$n); $h=[Text.Encoding]::UTF8.GetString($b); $m=[regex]::Match($h,'"cwd":"([^"]*)"'); '@@P ' + $e.Name + [char]9 + $m.Groups[1].Value } finally { $s.Close() } } } }`,
    ]
  }
  return [
    'sh',
    '-c',
    `for d; do for f in "$d"/rollout-*.jsonl; do [ -f "$f" ] || continue; c=$(head -c ${HEAD_BYTES} "$f" | grep -o '"cwd":"[^"]*"' | head -n 1 | cut -d'"' -f4); printf '@@P %s\\t%s\\n' "$(basename "$f")" "$c"; done; done`,
    'sh',
    ...dirs,
  ]
}

// Pass 1 output to thread id -> project path (forward slashes).
export function parseProjects(stdout: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of stdout.split('\n')) {
    if (!line.startsWith('@@P ')) continue
    const [file, cwd = ''] = line.slice(4).split('\t')
    const id = idFromFile(file.trim().replace(/\\/g, '/'))
    if (id) out[id] = cwd.trim().replace(/\\\\/g, '/').replace(/\\/g, '/')
  }
  return out
}

// Pass 2 picks: the newest `perProject` threads of every project (all of `focus`), newest first, capped.
export function pickPerProject<T extends { id: string; mtime: number }>(files: T[], projectOf: Record<string, string>, perProject: number, focus = '', cap = 140): T[] {
  const seen: Record<string, number> = {}
  const picked: T[] = []
  for (const f of [...files].sort((a, b) => b.mtime - a.mtime)) {
    const p = projectOf[f.id] ?? ''
    const limit = p === focus && focus ? 60 : perProject
    seen[p] = (seen[p] ?? 0) + 1
    if (seen[p] <= limit) picked.push(f)
    if (picked.length >= cap) break
  }
  return picked
}

// How many threads each project has in total (for "Show all (N)").
export function projectCounts(projectOf: Record<string, string>): Record<string, number> {
  const out: Record<string, number> = {}
  for (const p of Object.values(projectOf)) out[p || '(no project)'] = (out[p || '(no project)'] ?? 0) + 1
  return out
}

// Pass 1 for a few files only (the new ones since last time), so the command line stays short.
export function projectsArgvFiles(windows: boolean, files: string[]): string[] {
  if (windows) {
    const list = files.map(f => `'${f.replace(/'/g, "''")}'`).join(',')
    return [
      'powershell',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `[Console]::OutputEncoding=[Text.Encoding]::UTF8; foreach ($f in @(${list})) { $s=[IO.File]::Open($f,'Open','Read','ReadWrite'); try { $n=[Math]::Min($s.Length,${HEAD_BYTES}); $b=New-Object byte[] $n; [void]$s.Read($b,0,$n); $h=[Text.Encoding]::UTF8.GetString($b); $m=[regex]::Match($h,'"cwd":"([^"]*)"'); '@@P ' + [IO.Path]::GetFileName($f) + [char]9 + $m.Groups[1].Value } finally { $s.Close() } }`,
    ]
  }
  return [
    'sh',
    '-c',
    `for f; do c=$(head -c ${HEAD_BYTES} "$f" | grep -o '"cwd":"[^"]*"' | head -n 1 | cut -d'"' -f4); printf '@@P %s\\t%s\\n' "$(basename "$f")" "$c"; done`,
    'sh',
    ...files,
  ]
}
