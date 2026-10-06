# Buddy: the Claude Code mod that has your back

Claude Code once had an April Fools pet called Buddy. He's gone, so this mod brings him back with a real job.

Hatch him from an egg and he lives in a panel next to your chat. He naps, walks around while Claude works, and dances when a task finishes. More importantly, **Claude can't send, spend or delete anything until Buddy shows you exactly what's about to happen.**

## What Buddy does

| | Job | What it does |
|---|---|---|
| Guards | **Send gate** | Holds emails, Slack messages, invites, shares, `git push`, deploys and posts to outside APIs. You pick **Send**, **Send to me first** (strips every other recipient, CC and BCC included), **Approve all today** or **Cancel** |
| Guards | **Spend gate** | Holds paid API calls (OpenAI, Anthropic, Gemini, ElevenLabs, Replicate, fal, Runway, HeyGen, Apify and any you add) |
| Guards | **Danger guard** | Holds `rm -rf`, PowerShell deletes, `git reset --hard`, force pushes and database drops |
| Guards | **Locked files** | Claude can't edit files you lock (`.env` by default) |
| Watches | Health | Chat memory, your 5-hour and weekly limits, a cache timer, cost at API rates |
| Watches | Agents | Every helper agent, running or done, with times |
| Watches | Activity | Every time Buddy stepped in, and what you chose |
| Watches | Done ping | A pop-up when a long task finishes |
| Helps | Codex sidekick | Ask OpenAI Codex for a read-only second opinion (off by default) |
| Helps | Quick switch | One-click model and effort buttons |
| Helps | Handoff note | Saves a summary so a fresh chat picks up where you left off |
| Helps | House rules | Rules Claude gets every chat, plus a warning on banned words |
| Fun | Pets | Bunny, cat, dog, bear, frog, owl, ghost or dragon. Hatch, rename, pet |

Every guard fails closed: if Buddy's check ever breaks, the answer is no.

## Install

You need Claude Code 2.1.287 or later (`claude --version`; `claude update` if older). Buddy draws in the terminal and in the Code tab of the Claude desktop app (not in the VS Code chat panel or WSL).

```bash
claude plugin marketplace add joshpocock/claude-buddy
claude plugin install buddy@claude-buddy --scope user
```

Open a new chat and type `/buddy`. If the installer says options are "not yet set", that is fine: Buddy uses sensible defaults, and you can change everything in his **Settings** tab.

**Check it first, like any mod:** after cloning, run `claude plugin validate ./buddy`. It lists everything Buddy can do: no internet access, and the only program he runs is Codex, and only if you switch it on.

## Use

- `/buddy` opens the panel. Tabs: **Status**, **Jobs** (turn each job on or off), **Pets**, **Settings**, **Help**
- `/buddy hatch` gives you a new egg, `/buddy pet dragon` picks a pet, `/buddy name Rex` renames, `/buddy reset` zeroes the counter
- `/handoff` saves a handoff note, `/codex <task>` asks Codex (when on)

Set your email, locked files, extra paid APIs, house rules and banned words in the **Settings** tab.

## What Buddy can't catch

He recognizes connectors, git, deploys, known paid APIs and web requests by name. A custom script that sends or spends inside its own code can go around him. Mods are not sandboxed and run with your permissions, so only install mods you've checked.

## Uninstall

```bash
claude plugin uninstall buddy@claude-buddy
```

MIT licensed. Made by Josh Pocock.
