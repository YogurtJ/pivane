# Pivane

![Pivane](public/brand/logo-192.png)

**Bring your own AI workspace to every screen.**

[简体中文](README.md) · English

Pivane is a self-hosted AI workspace powered by **Pi Coding Agent**. Work on code, manage projects and files, follow Agent tasks, and use your own image, video and speech models from a desktop, tablet or phone.

[Releases](https://github.com/YogurtJ/pivane/releases) · [Install](docs/en/INSTALL.md) · [User guide](docs/en/USER_GUIDE.md) · [Report an issue](https://github.com/YogurtJ/pivane/issues)

## From a question to completed work

Choose a project directory and work with Pi Agent in your browser. Review replies, tool execution and file changes in the same workspace. Attach images or text files, run manual Shell commands, steer an active task, queue a follow-up, or compact context when needed.

The default reading view groups consecutive thinking and tool records. Switch to the full record when you want to inspect each step. Markdown, code highlighting, formulas and Mermaid diagrams support longer technical conversations.

## Native sessions and practical workflows

Session history uses Pi's native SessionManager and JSONL files. Search conversations, add bookmarks, inspect the session tree, fork a discussion, edit and retry a question, or export HTML and the active JSONL branch.

A temporary side chat can reference the main task's context, read files and search code. With `sideChatTools` enabled, explicit modification requests can use edit, write and command tools after an approval for that reply. Main and side agents share files; avoid concurrent edits to the same files. You can also explicitly append selected content to your main draft. Session navigation changes the conversation position; it does not undo files or external actions.

## Your models and deployment

Connect API keys or OAuth providers in settings, manage custom models and thinking levels, and choose Packages, Skills and prompt templates. Credentials are stored in your deployment and requests go to the providers you select.

The media lab accepts your own image, video and speech services. Ask an Agent to prepare a plan, review editable parameters, then explicitly confirm a single generation. Planning does not execute a request. Clicking a reply's speaker button authorizes that reply's audio generation using your read-aloud defaults.

## One workspace across devices

Run the server on Linux, macOS or Windows, then access it through a browser. Desktop layouts provide project, conversation and detail panes; tablet and phone layouts use responsive panels and drawers. Multiple browsers opening the same persistent thread share one managed Pi worker.

The current source supports **Simplified Chinese and English**. It follows the browser's preferred supported language on first use; other languages fall back to English. Choose a language under **Settings → Preferences → Interface language**. The choice is saved for this browser and applies on the next page load, without automatically refreshing or interrupting your current work. Model replies, user content and speech language are independent.

The bilingual interface is included starting with **1.0.0-rc.2**. The older RC archives remain unchanged. **1.0.0-rc.4** is the current release candidate and is pinned to **Pi 0.86.0**; RC3 remains a historical artifact with Pi 0.85.1. See the [RC4 notes](docs/releases/1.0.0-rc.4.md) for the current release scope.

## Install

Use **Node.js 22.x** and the locked dependencies. RC4 is pinned to Pi 0.86.0 and is validated against the exact archive and its isolated acceptance report. You do not need a global Pi installation, a frontend build, or a compiler for the packaged native components.

| Server platform | Validated RC baseline |
|---|---|
| Linux | Debian ARM64 and Ubuntu 24.04 x86_64 |
| macOS | Apple Silicon M2, macOS 26.5.1 |
| Windows | Windows 11 x64 on NTFS, running natively without WSL |

Follow the [English installation guide](docs/en/INSTALL.md) to verify the package, reuse your native Pi identity, create instance media/schedule directories, install dependencies and start the server. The [platform validation document](docs/RELEASE_INSTALL_VALIDATION.md) records additional limits; the RC baseline does not certify every platform or later source change.

Already using Pi CLI? The installer instructions resolve your actual Pi identity through Pi's public API, respecting `PI_CODING_AGENT_DIR` and native Windows/macOS/Linux home paths. Existing model configuration is shared without copying credentials; see [existing Pi users](docs/en/INSTALL.md#existing-pi-cli-users).

Open **Settings → Providers and models**, check existing configuration or log in if credentials are missing, choose a server project directory and create a thread. Media services are configured separately; a fresh installation has no executable media service by default.

## Data and access

Pivane is intended for individually deployed personal instances. It does not provide separate accounts or data isolation for multiple people sharing one instance. Project roots enforce path checks, but are **not an Agent tool sandbox**. Tools, Packages, Skills and extensions may execute code with the server user's permissions.

Use trusted HTTPS or a private trusted network for remote access, and configure access authentication before exposing the workspace. `localhost` refers to the device running the browser.

Persistent sessions live on the server. Unsent drafts, attachments and temporary side chats are not disk backups. Before updating or backing up, pause scheduled messages, finish tasks, preserve unsaved content and stop the service. Keep the complete Agent, media, project and instance configuration directories together. See [installation and recovery](docs/en/INSTALL.md).

The current source includes **Settings → Versions and updates** for version checks and official downloads, plus managed Pi updates, data backups and instance restarts. Both `node server.js` and `npm start` support these actions without changing service startup commands. The page displays the actual command output, exit code and final version. Pi is installed and checked in a separate directory before the service stops for backup and activation. Pivane application updates still use release archives. See [the user guide](docs/en/USER_GUIDE.md#versions-and-updates).

## Documentation and contribution

Start with the [English user guide](docs/en/USER_GUIDE.md). Detailed feature, API and development documentation is currently primarily in Chinese and is linked from the [documentation index](docs/README.md). An Agent helping with deployment should begin with [the operational Agent guide](docs/AGENT_GUIDE.md); source contributors should read [CONTRIBUTING.md](CONTRIBUTING.md) and [AGENTS.md](AGENTS.md).

In an isolated development environment:

```bash
npm ci
npm test
npm run check
npm run check:docs
npm audit --omit=dev
npm run pack:trial
```

Changes are recorded in [CHANGELOG.md](CHANGELOG.md). Pivane uses the [ISC license](LICENSE); dependencies retain their own licenses, listed in [Third-party notices](THIRD_PARTY_NOTICES.md).
