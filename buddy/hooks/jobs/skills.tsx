import { atom, read, update } from 'claude-code'

// Skills manager: every skill you have (global and this project), how often Claude actually
// uses each one, what their descriptions cost every chat, and copy / move / delete between
// projects. Copies and deletes back up first, never touch linked folders, and ask before deleting.

export type SkillItem = {
  name: string
  scope: 'global' | 'project'
  path: string
  isLink: boolean
  descChars: number
  description: string
}
export type SkillScan = { at: number; cwd: string; items: SkillItem[]; codexLink: boolean }
export type SkillUse = Record<string, { count: number; last: number }>

const skillScan = atom({ plugin: 'buddy', key: 'skillScan' } as const, null as SkillScan | null)
const tick = atom({ plugin: 'buddy', key: 'tick' } as const, 0)

export const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '')
const quotePs = (p: string) => `'${p.replace(/'/g, "''")}'`

// Reads the name and description from a SKILL.md's frontmatter (single line, quoted, or a | / > block).
export function frontmatter(text: string): { name?: string; description: string } {
  const m = text.match(/^---\s*\n([\s\S]*?)\n---/)
  if (!m) return { description: '' }
  const lines = m[1].split('\n')
  let name: string | undefined
  let description = ''
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const nm = line.match(/^name:\s*(.+)$/)
    if (nm) name = nm[1].trim().replace(/^["']|["']$/g, '')
    const dm = line.match(/^description:\s*(.*)$/)
    if (dm) {
      const first = dm[1].trim()
      if (first === '|' || first === '>' || first === '|-' || first === '>-' || first === '') {
        const block: string[] = []
        for (let j = i + 1; j < lines.length && /^\s+\S/.test(lines[j]); j++) block.push(lines[j].trim())
        description = block.join(' ')
      } else description = first.replace(/^["']|["']$/g, '')
    }
  }
  return { name, description }
}

async function homeDir($: any): Promise<string> {
  return norm(((await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')) ?? '.') as string)
}

async function scanDir($: any, dir: string, scope: 'global' | 'project'): Promise<SkillItem[]> {
  if (!(await $.fs.exists(dir))) return []
  const out: SkillItem[] = []
  for (const ent of await $.fs.list(dir)) {
    if (ent.name.startsWith('.')) continue
    const path = `${dir}/${ent.name}`
    if (ent.kind !== 'dir' && !ent.isLink) continue
    let text = ''
    try {
      text = await $.fs.read(`${path}/SKILL.md`)
    } catch {
      continue
    }
    const fm = frontmatter(text)
    out.push({
      name: fm.name || ent.name,
      scope,
      path,
      isLink: Boolean(ent.isLink),
      descChars: fm.description.length + (fm.name || ent.name).length,
      description: fm.description.slice(0, 220),
    })
  }
  return out
}

async function runScan($: any): Promise<SkillScan> {
  const home = await homeDir($)
  const cwd = norm(await $.session.cwd())
  const global = await scanDir($, `${home}/.claude/skills`, 'global')
  const project = cwd === home ? [] : await scanDir($, `${cwd}/.claude/skills`, 'project')
  const codexLink = await $.fs.exists(`${cwd}/.agents/skills`)
  const scan: SkillScan = { at: Date.now(), cwd, items: [...project, ...global], codexLink }
  await update($, skillScan, () => scan)
  return scan
}

// True when the folder, or anything inside it, is a link: Buddy never moves or deletes through one.
async function hasLink($: any, dir: string, depth = 0): Promise<boolean> {
  if (depth > 6) return true
  const st = await $.fs.stat(dir)
  if (st.isLink) return true
  for (const ent of await $.fs.list(dir)) {
    if (ent.isLink || ent.kind === 'other') return true
    if (ent.kind === 'dir' && (await hasLink($, `${dir}/${ent.name}`, depth + 1))) return true
  }
  return false
}

async function copyDir($: any, src: string, dst: string): Promise<string> {
  const windows = (await $.env.get('OS')) === 'Windows_NT'
  const parent = dst.slice(0, dst.lastIndexOf('/'))
  const r = windows
    ? await $.process.run([
        'powershell',
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `New-Item -ItemType Directory -Force -Path ${quotePs(parent)} | Out-Null; Copy-Item -LiteralPath ${quotePs(src)} -Destination ${quotePs(dst)} -Recurse -Force`,
      ])
    : await $.process.run(['sh', '-c', 'mkdir -p "$1" && cp -R "$2" "$3"', 'sh', parent, src, dst])
  return r.exitCode === 0 ? '' : (r.stderr || r.stdout || 'copy failed').slice(0, 200)
}

async function removeDir($: any, path: string): Promise<string> {
  const windows = (await $.env.get('OS')) === 'Windows_NT'
  const r = windows
    ? await $.process.run(['powershell', '-NoProfile', '-NonInteractive', '-Command', `Remove-Item -LiteralPath ${quotePs(path)} -Recurse -Force`])
    : await $.process.run(['rm', '-rf', path])
  return r.exitCode === 0 ? '' : (r.stderr || r.stdout || 'delete failed').slice(0, 200)
}

// Copies a skill to a destination skills folder; with `move`, backs up and removes the original after asking.
async function placeSkill($: any, item: SkillItem, destSkillsDir: string, move: boolean, label: string): Promise<string> {
  const folder = item.path.slice(item.path.lastIndexOf('/') + 1)
  const dst = `${norm(destSkillsDir)}/${folder}`
  if (norm(dst) === norm(item.path)) return 'It is already there.'
  if (await $.fs.exists(dst)) return `${label} already has a skill folder called ${folder}. Nothing changed.`
  if (await hasLink($, item.path)) return `${item.name} is (or contains) a linked folder. Buddy only copies and moves real folders, so nothing changed.`
  const err = await copyDir($, item.path, dst)
  if (err) return `Copy failed: ${err}`
  if (!move) return `Copied ${item.name} to ${label}.`
  let answer = ''
  try {
    answer = await $.ui.ask(`Buddy copied ${item.name} to ${label}. Remove the original from ${item.scope === 'project' ? 'this project' : 'your global skills'}? A backup is kept in ~/.claude/buddy/skill-backups.`, ['Remove the original', 'Keep both'])
  } catch {
    answer = ''
  }
  if (answer !== 'Remove the original') return `Copied ${item.name} to ${label} and kept the original.`
  const backup = `${await homeDir($)}/.claude/buddy/skill-backups/${folder}-${new Date().toISOString().replace(/[:.]/g, '-')}`
  const berr = await copyDir($, item.path, backup)
  if (berr) return `Copied, but the backup failed (${berr}), so the original was kept.`
  const rerr = await removeDir($, item.path)
  return rerr ? `Copied and backed up, but removing the original failed: ${rerr}` : `Moved ${item.name} to ${label}. Backup kept.`
}

async function deleteSkill($: any, item: SkillItem): Promise<string> {
  if (await hasLink($, item.path)) return `${item.name} is (or contains) a linked folder. Buddy won't delete it.`
  let answer = ''
  try {
    answer = await $.ui.ask(`Delete the skill ${item.name} from ${item.scope === 'project' ? 'this project' : 'your global skills'}? Buddy keeps a backup in ~/.claude/buddy/skill-backups.`, ['Delete it', 'Cancel'])
  } catch {
    answer = ''
  }
  if (answer !== 'Delete it') return 'Nothing deleted.'
  const folder = item.path.slice(item.path.lastIndexOf('/') + 1)
  const backup = `${await homeDir($)}/.claude/buddy/skill-backups/${folder}-${new Date().toISOString().replace(/[:.]/g, '-')}`
  const berr = await copyDir($, item.path, backup)
  if (berr) return `Backup failed (${berr}), so nothing was deleted.`
  const rerr = await removeDir($, item.path)
  return rerr ? `Backed up, but the delete failed: ${rerr}` : `Deleted ${item.name}. Backup kept.`
}

export function registerSkills(on: any) {
  // Usage: every time Claude loads a skill, count it (kept across chats and projects).
  on('tool.call', { tool: 'Skill' }, async ($: any, e: any, next: any) => {
    try {
      const name = String(e.skill ?? '').replace(/^\//, '')
      if (name) {
        const use = ((await $.store.get('skillUse')) ?? {}) as SkillUse
        const since = (await $.store.get('skillUseSince')) as number | undefined
        if (!since) await $.store.set('skillUseSince', Date.now())
        await $.store.set('skillUse', { ...use, [name]: { count: (use[name]?.count ?? 0) + 1, last: Date.now() } })
      }
    } catch {
      // counting only
    }
    return next(e)
  })

  // /buddy-skills scan | copy <scope>:<folder> <project path> | here <folder> | global <folder> | moveglobal <folder> | delete <scope>:<folder>
  on('command.run', { command: 'buddy-skills' }, async ($: any, e: any) => {
    const args = String(e.args ?? '').trim()
    const [verb, ref, ...rest] = args.split(/\s+/)
    const scan = verb === 'scan' || !verb ? await runScan($) : ((await read($, skillScan)) ?? (await runScan($)))
    if (verb === 'scan' || !verb) {
      await update($, tick, (n: number) => n + 1)
      return { text: `Buddy found ${scan.items.length} skills.` }
    }
    const [scope, folder] = (ref ?? '').includes(':') ? (ref ?? '').split(':') : ['', ref ?? '']
    const item = scan.items.find(i => i.path.endsWith(`/${folder}`) && (!scope || i.scope === scope))
    if (!item) return { text: `No skill folder called ${folder}.` }
    const home = await homeDir($)
    let msg = ''
    if (verb === 'copy') {
      const target = norm(rest.join(' ').replace(/^["']|["']$/g, ''))
      if (!target || !(await $.fs.exists(target))) msg = `That project folder doesn't exist: ${target || '(empty)'}`
      else msg = await placeSkill($, item, `${target}/.claude/skills`, false, target.split('/').pop() ?? target)
    } else if (verb === 'here') msg = await placeSkill($, item, `${scan.cwd}/.claude/skills`, false, 'this project')
    else if (verb === 'global') msg = await placeSkill($, item, `${home}/.claude/skills`, false, 'your global skills')
    else if (verb === 'moveglobal') msg = await placeSkill($, item, `${home}/.claude/skills`, true, 'your global skills')
    else if (verb === 'delete') msg = await deleteSkill($, item)
    else return { text: 'Usage: /buddy-skills scan | here <folder> | global <folder> | moveglobal <folder> | copy <scope>:<folder> <project path> | delete <scope>:<folder>' }
    await runScan($)
    await update($, tick, (n: number) => n + 1)
    $.ui.toast(`Buddy: ${msg}`)
    return { text: msg }
  })
}
