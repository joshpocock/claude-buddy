# Buddy: a pet sidekick for Claude Code

Claude Code once had an April Fools pet called Buddy. He's gone, so this mod brings him back as a sidekick that does real work.

Hatch him from an egg and he lives in a panel next to your chat. He naps, walks around while Claude works, and dances when a task finishes. Meanwhile he does this:

## What Buddy does

**Does things for you**
- **To-do inbox:** when a chat is stuck waiting on you (add an API key, log in), it lands on Buddy's to-do list instead of getting buried in a long reply. Press **Done** and that chat carries on by itself, even if it's a different chat. Items fade after a day (you choose how long), and **Done all** / **Skip all** clear the list.
- **Recording mode:** filming or sharing your screen? One button covers API keys, emails, phone numbers, dollar amounts and any names you list (clients, your company) everywhere on screen, in every chat. A red REC chip shows it's on. Claude still sees the real text.
- **Cache price check:** after a break, Claude's cache goes cold and your next message re-reads the whole chat at full price. Claude Code's cache lasts about an hour. Buddy warns you a minute before it goes cold, and after that tells you what the message will cost and offers to compact first.

**Claude is the boss of Codex (Codex tab)**
- **Start OpenAI Codex agents from Claude:** from the panel, or just ask Claude ("have Codex review this while you build the next part"). Read-only by default; letting Codex edit files asks you first.
- **All your Codex threads in one list,** from the Codex app and CLI: name, folder, working or idle, last reply. Peek at any of them, and message an idle one from Claude. Codex picks up with its memory.
- **Watch them work:** each agent shows who started it, what it's doing now, tokens used and its answer. Claude gets the answers back automatically.
- Needs the Codex CLI installed and logged in. Off by default, because whatever goes to Codex goes to OpenAI.

**Runs a team (Threads tab)**
- **Helpers:** start a helper agent from the panel (Sonnet, Opus or Fable), or let Claude split a job across helpers. Each one shows who started it, how long it's run, its steps and what it's doing right now, with **Peek**, **Message** and **Stop**.
- **Separate chats:** start a whole separate Claude chat in the background with its own model and memory (`/thread <task>`, or Claude starts them itself). Its answer comes back to the chat that started it, and you can send it follow-ups. Works on Windows and Mac; no tmux.
- **Message any chat:** every open chat on the Chats board gets a message box, and Claude can message your other chats too, so one chat can run the others.

**Manages your skills (Skills tab)**
- Every skill you have, global and in this project (names hidden while recording mode is on), with how often Claude actually uses each one (Buddy counts every time a skill loads, across all chats).
- What they cost: an estimate of the tokens your skill names and descriptions add to every chat, plus a "Never used" sort to find dead weight.
- One click to make a skill global, add a global one to this project, copy it to another project, move it, or delete it. Moves and deletes ask first and keep a backup. Buddy never touches linked folders.

**Sees everything at a glance**
- **All your chats:** every Claude Code chat you have open, live: working, waiting on you, or your turn. A ping when one finishes or needs you.
- **Status tab:** your home screen. **Health** shows how full this chat is, about how many replies are left, your 5-hour and weekly limits (and when you'll run out at this pace), the cache timer, cost at API rates.

**One-click power moves**
- Switch to Fable, Opus or Sonnet, or change effort, from buttons.
- Compact now, or save a handoff note so a fresh chat picks up where you left off.

**A safety net, only where it matters**
- **Send check (on):** before Claude sends an email or Slack message, pushes or deploys, Buddy shows who it's going to and what it says: **Send**, **Send to me first**, **Approve all today** or **Cancel**.
- **Spend check (on):** paid API calls (OpenAI, Anthropic, Gemini, ElevenLabs, Replicate, fal, Apify and any you add) wait for your OK.
- **Locked files:** Claude can't edit `.env` (or anything you add). **Delete check** is there too, off by default.
- Every job switches on or off in the **Jobs** tab, with an **Activity** log of everything Buddy stepped in on.

**The fun part:** pick a bunny, cat, dog, bear, frog, owl, ghost or dragon. Hatch, rename, pet.

## Install

You need Claude Code 2.1.287 or later (`claude --version`; `claude update` if older). Buddy draws in the terminal and in the Code tab of the Claude desktop app (not in the VS Code chat panel or WSL).

```bash
claude plugin marketplace add joshpocock/claude-buddy
claude plugin install buddy@claude-buddy --scope user
```

Open a new chat and type `/buddy`. If the installer says options are "not yet set", that's fine: Buddy uses sensible defaults, and you can change everything in his **Settings** tab.

**Check it first, like any mod:** after cloning, run `claude plugin validate ./buddy`. It lists everything Buddy can do: no internet access; he reads and writes small status files in `~/.claude/buddy/` for the chats board; the programs he runs are Claude itself (for separate chats you start), Codex (only if you switch it on), and your system's copy and delete commands (only when you copy, move or delete a skill).

## Use

- `/buddy` opens the panel. Tabs: **Status**, **Chats**, **Jobs**, **Pets**, **Settings**, **Help**
- `/buddy rec` recording mode on or off
- `/thread <task>` start a separate background chat
- `/buddy-skills` what the Skills tab runs (scan, copy, move, delete)
- `/buddy hatch` new egg · `/buddy pet dragon` pick a pet · `/buddy name Rex` rename · `/buddy reset` zero the counter
- `/handoff` save a handoff note · `/codex <question>` ask Codex (when on)

## Limits

- Recording mode covers the chat transcript and Buddy's panel. It can't cover the permission pop-up, the prompt box while you type, other mods' panels, or the desktop app's own sidebar titles. Check your screen before you hit record.
- Separate chats run without anyone to answer pop-ups, so Buddy's send and spend checks cancel anything they would have asked about, and tools that need approval follow the permission mode in Settings (acceptEdits by default).
- The cache price is an estimate at API rates. On a subscription you don't pay it in dollars; it comes out of your usage limit.
- Buddy recognizes connectors, git, deploys, known paid APIs and web requests by name. A custom script that sends or spends inside its own code can go around him. Mods are not sandboxed and run with your permissions, so only install mods you've checked.

## Update and uninstall

```bash
claude plugin marketplace update claude-buddy
claude plugin update buddy@claude-buddy
claude plugin uninstall buddy@claude-buddy
```

## It's a work in progress

Buddy is a starting point, not a finished product. Fork it, change it, add your own jobs. Every job is its own file in `buddy/hooks/jobs/`, so adding one is easy. Pull requests welcome.

MIT licensed. Made by Josh Pocock.
