# Pivane

![Pivane](public/brand/logo-192.png)

**Bring your own AI workspace to every screen.**

[简体中文](README.md) · English

Pivane is a self-hosted AI workspace powered by **Pi Coding Agent**. Work on code, manage projects and files, follow Agent tasks, and use your own image, video and speech models from a desktop, tablet or phone.

[Download 1.4.0](https://github.com/YogurtJ/pivane/releases/tag/v1.4.0) · [Install](docs/en/INSTALL.md) · [User guide](docs/en/USER_GUIDE.md) · [Report an issue](https://github.com/YogurtJ/pivane/issues)

Stable release **1.4.0** pins Pi **0.99.1**, integrates native MCP/Codemode and nested tools, and improves side chat, long-session loading and settings. Legacy pi-mcp-adapter configuration requires explicit review and migration; OAuth is not converted automatically. Deployment and public release are verified separately; old archives remain unchanged. See [native MCP](docs/MCP.md) and the [1.4.0 release notes](docs/releases/1.4.0.md).

Current source is the **1.5.0 candidate / Pi 1.0.0**, with model speed controls, voice transcription, cross-project thread moves and compare-before-write knowledge handling. It is not publicly released; see [candidate notes](docs/releases/1.5.0.md) for upgrade boundaries and validation status.

## From a question to completed work

Choose a project directory and work with Pi Agent in your browser. Review replies, tool execution and file changes in the same workspace. Attach images or text files, run manual Shell commands, steer an active task, queue a follow-up, or compact context when needed.

The default reading view groups consecutive thinking and tool records. Switch to the full record when you want to inspect each step. Markdown, code highlighting, formulas and Mermaid diagrams support longer technical conversations.

## Native sessions and practical workflows

Session history uses Pi's native SessionManager and JSONL files. Search conversations, add bookmarks, inspect the session tree, fork a discussion, edit and retry a question, or export HTML and the active JSONL branch.

A temporary side chat can reference the main task's context, read files and search code. With `sideChatTools` enabled, explicit modification requests can use edit, write and command tools after an approval for that reply. Main and side agents share files; avoid concurrent edits to the same files. Its runtime starts on the first send and expires after 12 idle hours. Previous messages remain readable on this page but are not inherited by a new Agent; copy useful content to your main draft. Session navigation changes the conversation position; it does not undo files or external actions.

## Your models and deployment

Connect API keys or OAuth providers in settings, manage custom models and thinking levels, and choose Packages, Skills and prompt templates. Credentials are stored in your deployment and requests go to the providers you select.

The media lab accepts your own image, video and speech services. Ask an Agent to prepare a plan, review editable parameters, then explicitly confirm a single generation. Planning does not execute a request. Clicking a reply's speaker button authorizes that reply's audio generation using your read-aloud defaults.

## One workspace across devices

Run the server on Linux, macOS or Windows, then access it through a browser. Desktop layouts provide project, conversation and detail panes; tablet and phone layouts use responsive panels and drawers. Multiple browsers opening the same persistent thread share one managed Pi worker.

The current source supports **Simplified Chinese and English**. It follows the browser's preferred supported language on first use; other languages fall back to English. Choose a language under **Settings → Preferences → Interface language**. The choice is saved for this browser and applies on the next page load, without automatically refreshing or interrupting your current work. Model replies, user content and speech language are independent.

The bilingual interface is included starting with **1.0.0-rc.2**. Version **1.0.0** was the first stable release, pinned to Pi 0.86.1. Historical artifacts remain available with their original validation records.

## Install

The current stable release, **1.4.0**, is pinned to **Pi 0.99.1**, with DOMPurify 3.4.16. See the [release notes](docs/releases/1.4.0.md). The exact archive passed 530 Node tests, 19 Chromium suites, independent installation, upgrade from 1.3.0 and byte-identical same-path restoration of 18 files on Linux ARM64 with Node 22. Production audit reports zero vulnerabilities. macOS and Windows keep their historical baselines. Running instances change only after an explicit update.

Use **Node.js 22.x** and the locked dependencies. Validation results are attached to the exact archive SHA256. You do not need a global Pi installation or a frontend build. The current source bundles pi-subagents 0.74.0 and pi-hermes-memory 0.9.9; `node scripts/install.cjs` prepares both without rewriting your CLI package declarations and uses the SQLite binaries shipped in the dependency package. Older published archives without this installer retain their original `npm ci` instructions. SQLite may require Python and C/C++ build tools when no matching prebuilt binary exists. See [bundled capabilities](docs/BUNDLED_CAPABILITIES.md).

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

The default installation runs in the background. After configuring the instance, run `node scripts/install-service.cjs`: Linux uses a user systemd service, macOS a LaunchAgent, and Windows a login task. macOS and Windows also receive a desktop browser shortcut. Linux servers need linger or an equivalent system service for startup before login. See [service management and validation limits](docs/BACKGROUND_SERVICE.md). Foreground `npm start` is for trials and troubleshooting.

**Settings → Versions and updates** now shows current and available Pivane/Pi versions, links to the official release pages, and offers a prompt to copy to an independent Agent on the host. It no longer provides in-page installation, backup, restart or archive downloads. Existing managed-maintenance backend APIs remain for compatibility; version checks do not execute them. See [the user guide](docs/en/USER_GUIDE.md#versions-and-updates).

Current source introduces Pivane configuration names and `PIVANE_` aliases for workspace settings, while preserving existing files, browser preferences and Pi-native identity variables. Project directory moves require a verified offline migration; see [naming and compatibility](docs/development/NAMING.md).

## Documentation and contribution

Start with the [English user guide](docs/en/USER_GUIDE.md). Detailed feature, API and development documentation is currently primarily in Chinese and is linked from the [documentation index](docs/README.md). An Agent helping with deployment should begin with [the operational Agent guide](docs/AGENT_GUIDE.md); source contributors should read [CONTRIBUTING.md](CONTRIBUTING.md), [AGENTS.md](AGENTS.md) and the [module map](docs/development/MODULES.md).

Prepare locked dependencies with `node scripts/install.cjs` in an isolated development environment. Use the [targeted test entry point](docs/development/WORKFLOW.md#node-测试入口与计时) during iteration and follow the [validation matrix](docs/development/WORKFLOW.md#验证矩阵) for source delivery and releases. Ordinary installations do not require development tests.

Changes are recorded in [CHANGELOG.md](CHANGELOG.md). Pivane uses the [ISC license](LICENSE); dependencies retain their own licenses, listed in [Third-party notices](THIRD_PARTY_NOTICES.md).
