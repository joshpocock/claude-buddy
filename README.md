# Buddy: a pet sidekick for Claude Code

Claude Code once had an April Fools pet called Buddy. He's gone, so this mod brings him back as a sidekick that does real work.

Hatch him from an egg and he lives in a panel next to your chat. He naps, walks around while Claude works, and dances when a task finishes. Meanwhile he does this:

## What Buddy does

**Does things for you**
- **To-do inbox:** when Claude needs you (add an API key, log in, approve something), it lands on Buddy's to-do list instead of getting buried in a long reply. Press **Done** and that chat carries on by itself, even if it's a different chat.
- **Recording mode:** filming or sharing your screen? One button covers API keys, emails, phone numbers, dollar amounts and any names you list (clients, your company) everywhere on screen, in every chat. A red REC chip shows it's on. Claude still sees the real text.
- **Cache price check:** after a break, Claude's cache goes cold and your next message re-reads the whole chat at full price. Buddy warns you a minute before it happens, and when it has, tells you what the message will cost and offers to compact first.

**Sees everything at a glance**
- **All your chats:** every Claude Code chat you have open, live: working, waiting on you, or your turn. A ping when one finishes or needs you.
- **Health:** how full this chat is, your 5-hour and weekly limits, the cache timer, cost at API rates.
- **Agents:** every helper agent Claude starts, running or done, with times.

**One-click power moves**
- Switch to Fable, Opus or Sonnet, or change effort, from buttons.
- Compact now, or save a handoff note so a fresh chat picks up where you left off.
- Ask OpenAI Codex for a read-only second opinion (off by default).

**A safety net, only where it matters**
- **Send check (on):** before Claude sends an email or Slack message, pushes or deploys, Buddy shows who it's going to and what it says: **Send**, **Send to me first**, **Approve all today** or **Cancel**.
- **Spend check (on):** paid API calls (OpenAI, Anthropic, Gemini, ElevenLabs, Replicate, fal, Apify and any you add) wait for your OK.
- **Locked files:** Claude can't edit `.env` (or anything you add). **Delete check** is there too, off by default.
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
- `/buddy rec` recording mode on or off
- `/buddy hatch` new egg · `/buddy pet dragon` pick a pet · `/buddy name Rex` rename · `/buddy reset` zero the counter
- `/handoff` save a handoff note · `/codex <question>` ask Codex (when on)

## Limits

- Recording mode covers the chat transcript and Buddy's panel. It can't cover the permission pop-up, the prompt box while you type, other mods' panels, or the desktop app's own sidebar titles. Check your screen before you hit record.
- The cache price is an estimate at API rates. On a subscription you don't pay it in dollars; it comes out of your usage limit.
- Buddy recognizes connectors, git, deploys, known paid APIs and web requests by name. A custom script that sends or spends inside its own code can go around him. Mods are not sandboxed and run with your permissions, so only install mods you've checked.

## Update and uninstall

```bash
claude plugin marketplace update claude-buddy
claude plugin update buddy@claude-buddy
claude plugin uninstall buddy@claude-buddy
```

MIT licensed. Made by Josh Pocock.
