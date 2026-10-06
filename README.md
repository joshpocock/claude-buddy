# Buddy: a pet sidekick for Claude Code

Claude Code once had an April Fools pet called Buddy. He's gone, so this mod brings him back as a sidekick that actually helps.

Hatch him from an egg and he lives in a panel next to your chat. He naps, walks around while Claude works, and dances when a task finishes. While he's there, he keeps an eye on everything for you.

## What Buddy does

**Sees everything at a glance**
- **All your chats:** every Claude Code chat you have open, live: working, waiting on you, or your turn. Buddy pings you when another chat finishes or needs you.
- **Health:** how full this chat is, your 5-hour and weekly limits, when the cache goes cold, cost at API rates.
- **Agents:** every helper agent Claude starts, running or done, with times.
- **Activity:** a log of every time Buddy stepped in, and what you chose.

**One-click power moves**
- Switch to Fable, Opus or Sonnet, or change effort, from buttons.
- Compact now, or save a handoff note so a fresh chat picks up where you left off.
- Ask OpenAI Codex for a read-only second opinion from an Ask box (off by default).

**A safety net, only where it matters**
- **Send check (on):** before Claude sends an email or Slack message, or pushes or deploys, Buddy shows exactly who it's going to and what it says: **Send**, **Send to me first** (a test copy only to you), **Approve all today** or **Cancel**.
- **Spend check (on):** paid API calls (OpenAI, Anthropic, Gemini, ElevenLabs, Replicate, fal, Apify and any you add) wait for your OK. "Approve all today" quiets a service for the day.
- **Delete check (off by default)** and **locked files** (`.env` by default) if you want them.
- Every job switches on or off in the **Jobs** tab.

**The fun part:** pick a bunny, cat, dog, bear, frog, owl, ghost or dragon. Hatch, rename, pet.

## Install

You need Claude Code 2.1.287 or later (`claude --version`; `claude update` if older). Buddy draws in the terminal and in the Code tab of the Claude desktop app (not in the VS Code chat panel or WSL).

```bash
claude plugin marketplace add joshpocock/claude-buddy
claude plugin install buddy@claude-buddy --scope user
```

Open a new chat and type `/buddy`. If the installer says options are "not yet set", that's fine: Buddy uses sensible defaults, and you can change everything in his **Settings** tab.

**Check it first, like any mod:** after cloning, run `claude plugin validate ./buddy`. It lists everything Buddy can do: no internet access; he reads and writes small status files in `~/.claude/buddy/` for the chats board; the only program he runs is Codex, and only if you switch it on.

## Use

- `/buddy` opens the panel. Tabs: **Status**, **Chats**, **Jobs**, **Pets**, **Settings**, **Help**
- `/buddy hatch` new egg · `/buddy pet dragon` pick a pet · `/buddy name Rex` rename · `/buddy reset` zero the counter
- `/handoff` save a handoff note · `/codex <question>` ask Codex (when on)

## Limits

Buddy recognizes connectors, git, deploys, known paid APIs and web requests by name. A custom script that sends or spends inside its own code can go around him. Mods are not sandboxed and run with your permissions, so only install mods you've checked.

## Update and uninstall

```bash
claude plugin marketplace update claude-buddy
claude plugin update buddy@claude-buddy
claude plugin uninstall buddy@claude-buddy
```

MIT licensed. Made by Josh Pocock.
