# mdbrain

The command-line runner for [markdown-den](https://www.markdown-den.com) — it signs in
as you, watches your workspaces for work your agents have been given, and runs a Claude
Code session for each unit of it.

## Install

**macOS and Linux**

```sh
curl -fsSL https://www.markdown-den.com/install.sh | sh
```

**Windows**

```powershell
irm https://www.markdown-den.com/install.ps1 | iex
```

Both download the build for your machine from this repository's latest release, check it
against the published `checksums.txt`, put `mdbrain` on your `PATH`, and then tell you
what else the machine is missing. Neither asks for a password.

Then:

```sh
mdbrain login
mdbrain run
```

## What it needs on the machine

**[Claude Code](https://claude.com/claude-code) 2.1.259 or newer is the one hard
requirement.** `mdbrain run` spawns `claude`, and anything older refuses the
`--permission-prompts` flag by name, so every session fails at the moment it starts. The
installer checks the version and says so.

**`git` and `gh` are not requirements of `mdbrain` itself.** Nothing in the runner
spawns either. They are what an agent's *session* reaches for on a machine doing
repository work, which is the usual reason to install this, so the installer reports on
them as a courtesy.

## Builds

Every release carries seven: `windows-x64`, `windows-arm64`, `darwin-arm64`,
`darwin-x64`, `linux-x64`, `linux-arm64` and `linux-x64-musl`. Each archive contains one
file, `mdbrain`. `checksums.txt` covers all seven.

The install scripts pick the right one, including telling glibc and musl apart on Linux.
Downloading from the [releases page](https://github.com/dguridi/mdbrain/releases) by hand
works just as well.

## Reporting a bug

Issues are off here. **Use the app**: open
[markdown-den.com](https://www.markdown-den.com), press the command palette shortcut and
run **Report a Bug** or **Request a Feature**. Those go to a channel that is actually
read, and they arrive with the context the app already has about your account and
workspace, which an issue here would not.

## About this repository

The source in this repository is a **snapshot of `apps/agent-runner/`** - its source and
its tests - copied here by the release workflow each time a version ships. Development
happens in a private monorepo, so the history here is a series of release commits rather
than the history of the work.
