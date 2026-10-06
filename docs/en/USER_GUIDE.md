# Pivane user guide

[简体中文](../USER_GUIDE.md) · [Install](INSTALL.md) · [Documentation](../README.md)

Pivane runs on your computer or server. Other devices can use its browser interface, but project paths, Shell commands and Agent tools use the **server's filesystem and OS permissions**.

## Start your first session

1. Follow the [installation guide](INSTALL.md), start the instance and open its URL.
2. In **Settings → Providers and models**, check existing Pi configuration. Add an API key or complete OAuth if credentials are missing. Keep credentials out of chat. For remote OAuth, localhost means the server; use the provider's device-code or manual-callback flow when available.
3. Return to Pi Agent, select a server project directory and choose **New chat**, a model and its thinking level.
4. Send a simple question, then refresh and reopen the persistent thread to check that the reply is retained. Requests use your provider account.

If Pi CLI has models but the browser does not, check its identity directory and startup environment using [existing Pi users](INSTALL.md#existing-pi-cli-users). Global models and extensions can be managed before selecting a project.

## Workspace navigation

- **Pi Agent** groups threads by directory; **Assistant chat** groups them by identity and project category. Profiles, extensions, scheduled tasks and the media lab have separate pages.
- Phones place additional entries under **More**. Navigation remains available while the project/thread drawer is open; selecting another entry closes it first.
- **Projects** browses directories; **Activity** shows running work, items needing attention and recent threads. Sidebar search matches titles and first questions. **Search text** searches conversation content; Ctrl/Cmd+K focuses sidebar search.
- Text search retains its query, results page and reading position within the current page. **Locate current thread** adjusts the list and focus without changing archive state or restarting the session.
- Details, Files, History and Side chat share the right panel. Desktop panels dock and resize; narrow desktops temporarily hide the thread list. Phones use a drawer with Close and Esc support. Closing a panel does not stop its task.

Opening management pages does not end the session. When switching between Pi Agent and Assistant chat, select the thread again to continue. Drafts and loaded attachments are retained per thread within the page; **preserve unsent content before refreshing or closing it**.

## Models and capabilities

Click the model name on desktop, or the context ring on phones. Search by name, ID or provider. Favorites are shared across devices using the instance; recent selections stay in the browser. Models, thinking levels and speed options come from actual capabilities and require an idle conversation to change.

Channels supporting Fast or Ultrafast show a separate Speed control with cost multipliers. Defaults are managed under **Providers and models**; see [model settings](../PROVIDER_SETTINGS.md).

**Settings → Models & capabilities** manages image, video, speech and subagent settings. Media entries show their own category; Speech separates TTS from ASR. Changing a shared service URL or credential affects all its models. Chat credentials do not automatically configure media services.

### Use subagents

Ask the main Agent explicitly to delegate. The **Subagents** chip above the composer shows status, models, tools and usage. Steer sends guidance, Stop requests cancellation, and Continue is offered for eligible runs. Actual availability depends on the run's state. Check uncertain outcomes before repeating an action.

Subagents ship with Pivane. Global/project defaults and role overrides are saved in Models & capabilities; an override does not create a role definition. Saving leaves active tasks unchanged, and an idle runtime reopen applies new settings. See [bundled capabilities](../BUNDLED_CAPABILITIES.md).

**Session kept open** means background work is still active. Closing the page does not stop it; maintenance also waits. Use the run's Stop control when needed. Result notices and requests can be expanded from their compact rows.

## Conversation and tools

`@` inserts a server project path; attachments, paste and drag-and-drop upload browser-supplied files. Persistent threads accept DOCX, XLSX, PPTX and PDF originals, up to 20 MiB each and five documents per message. Ask the Agent to summarize or analyze them; it reads selected ranges on demand, and file cards download originals. Formulas use saved cached values, scanning requires a separate OCR workflow, and Office layout preview/editing is not included. See [document attachments](../COMPOSER_TOOLS.md#上传办公文档与-pdf). While the Agent runs, choose Steer or Follow-up from Add. An empty draft shows Stop; text, quotes or attachments show Send.

Choose a message display mode under **Settings → Preferences**:

| Mode | Display |
|---|---|
| Compact | Final reply per turn, with expandable execution details |
| Reading | Every reply, with grouped thinking and tool records |
| Full record | Individual records for inspection |

Expand tool details before using browser Find to search their output. Long inline code wraps; code blocks and wide formulas scroll within their own areas. Invalid or over-budget formulas retain their source. Long user messages can be expanded, and Copy still returns their complete text. Reply timestamps may indicate generation start rather than completion.

`!command` runs server Shell; `!!command` excludes it from later model context but retains its native execution record. Project roots are not a sandbox. Install only trusted extensions. After a timeout, disconnect or uncertain Stop/Take queue result, verify state before repeating a request. Stopping does not undo completed file changes or external requests.

Temporary sessions have no saved session file and end on refresh or disconnect. See [composer tools](../COMPOSER_TOOLS.md), [Shell](../WEB_SHELL.md) and [runtime controls](../NATIVE_CONTROLS.md).

### Voice input

Tap the microphone to record and again to stop and transcribe. Text enters an editable draft for you to send. Recording lasts up to two minutes and requires HTTPS or localhost plus browser permission. Audio goes to the selected service and may incur a charge; failures are not retried automatically. The setup link opens **Models & capabilities → Speech → ASR**. See [transcription](../COMPOSER_TOOLS.md#语音转录).

## Task progress

The **Task progress** chip opens an Agent-maintained step list. You can ask the Agent to create, revise or clear it. Progress is reported, not independently verified; a stop or final reply does not automatically complete unfinished steps. Persistent threads restore the latest plan for their current branch. Side chat does not offer this card.

## Agent task threads and messages

Ask “open another thread to handle this” to create and immediately start a persistent task in the same project. You may specify its model and thinking level; otherwise new-thread defaults apply. Results return as receipts without automatically waking the source. Stopping the source does not stop the new thread.

If creation is uncertain, inspect the original task instead of creating it again. Threads share project files, so assign distinct editing responsibilities. Agents can also contact existing project threads; delivery waits for idle, and **Leave a note only** does not actively wake the recipient. Repeated automatic exchanges eventually stop waking threads. Agent messages identify their source and do not extend user authorization. See [task threads and messages](../AGENT_THREADS.md).

## Assistant identities and memory

Create an identity under **Assistant profiles**, with SOUL (behavior), USER (preferences) and MEMORY (long-term memory). Select it in Assistant chat, then choose a project category and thread. New ordinary Pi Agent threads do not bind an identity.

Categories may share a server directory and add different instructions, but **files, AGENTS.md and memory scoped to the physical directory remain shared**. Identities are not security sandboxes, and opening a thread does not change its existing identity. See [assistant profiles](../AGENT_PROFILES.md).

Use **Learning & skills** to manage memories, learned skills, deleted records and supported undo operations. Feedback distinguishes saved content from pending indexing. Saved or injected content does not prove that an open runtime has loaded it or that the model followed it.

Chat memory cards show receipts and eligible undo, correction or edit controls. Enabled skills need an idle resource reload. Background learning is off by default and requires dedicated auxiliary models; missing models, exhausted budgets, full memory and failures are shown explicitly. It does not silently use the chat model.

Consolidation prepares a proposal for review before applying it; stale item versions cannot overwrite newer content. Project memory editing requires a verified session scope. Correction and long-term preference triggers support customization; one-time requests can be excluded. Suspected credentials and prompt injection are rejected. Store credentials through model settings or a credential manager. See [memory and learning](../PROFILE_MEMORY.md#background-learning) for limits, migration and recovery.

## Customize system prompts

Under **Settings → System prompts**, select All projects or This project, edit and save instructions, then **Update current conversation** when idle. **Project instructions replace shared instructions; they do not automatically combine.** Project writes require trust.

**View current conversation** shows the actual assembled prompt and sources. Saving does not interrupt tasks; browser refresh may reconnect the same runtime. After a conflict or uncertain save, refresh and compare your draft first. See [system prompt configuration](../NATIVE_SETTINGS.md#系统提示词查看与编辑).

## Extensions, featured items and installed resources

Open **Extensions** on desktop or **More → Extensions** on phones:

- **Discover** shows sources and requirements. Learn & set up places a request in a dedicated Extension Assistant draft for you to send; browsing does not install or call a model.
- **Installed** filters Packages, Skills, extension modules, templates and terminal themes. Enable/disable is in the row; update, remove and restore inheritance are in its menu. Review source, scope and code-execution implications before installation.
- **MCP** manages global or trusted-project configuration. Saving is separate from connecting or reloading. Existing credentials stay unless explicitly replaced or removed. Status, reconnect and OAuth use an open persistent thread.

Installed does not mean loaded in the current conversation. Reload idle resources and verify them after setup. Untrusted projects cannot receive project writes. Legacy MCP adapter migration requires stopped backups; see [MCP](../MCP.md) and [native resources](../NATIVE_SETTINGS.md).

Use **Add → Add capabilities…** for setup or troubleshooting. Package operations use web confirmation, and tools run on the deployment machine. Computer-use extensions do not directly control the phone viewing Pivane. Third-party resources need their own dependencies and permissions.

## Scheduled tasks

Use **Scheduled tasks** for recurring or one-off work in a chosen thread or an identity's main thread. Add in the composer can create a task for the current thread. Check the timezone, next run, budget and missed-run behavior before enabling it.

Pausing a schedule and stopping its current run are separate actions. The server must remain running; busy work waits, and uncertain outcomes need verification. See [scheduled tasks](../SCHEDULED_TASKS.md).

## Thread list display

The list shows thread titles and status; hover reveals the full title and available statistics. Idle does not mean the runtime has been released. Use `/quit` in the relevant thread to exit it explicitly; switching threads does not immediately stop its worker.

## Archive projects and threads

Archive from the project or thread menu and read or restore entries in the Archived groups. Their archive states are independent. Archiving changes display preferences without deleting data or stopping work. Activity still surfaces running and unread archived threads; enable **Include archived** when searching old content.

## Move a thread to another project

Choose **Move to project… → Check and preview → Confirm move**. The destination is a server directory; empty projects can be entered manually. Moving preserves session ID, full history and bookmarks. Future tools use the target directory; project files are not moved with the thread.

Only eligible idle ordinary persistent sessions can move. The preview lists blockers such as assistant bindings, task relationships, schedules or background work. Verify both locations after a failed or uncertain result before retrying. See [move and recovery boundaries](../SESSION_WORKFLOWS.md#移动线程到其他项目).

## Conversation titles

New unnamed threads can receive a title after their first substantive exchange. Existing history and manual names are protected. **Generate a new title** offers a suggestion to edit and save; direct Rename remains available.

Title generation sends a bounded question/answer excerpt to the selected provider, incurs extra usage and is outside persistent-chat statistics. Configure its model and automatic switch under Auxiliary models.

## Auxiliary models

**Settings → Preferences → Auxiliary models** assigns models by purpose: titles, media planning and background learning. Title Auto follows the thread; media Auto follows the displayed rules; learning needs dedicated models. An explicitly selected model is not silently replaced on failure. Saving does not execute a request. See [auxiliary models](../AUXILIARY_MODELS.md).

## History, files and side chat

**History** supports search, bookmarks, trees, forks and conversation navigation. Restoring a conversation position **does not undo files, commands or external requests**. HTML exports are for reading; JSONL exports contain the active branch. Back up stopped data directories to preserve complete session trees. See [history](../HISTORY.md), [workflows](../SESSION_WORKFLOWS.md) and [import/export](../SESSION_TRANSFER.md).

**Files** browses and searches the project without adding contents to model context. Historical diffs, Current file and immutable Deliverables are distinct sources. Expand reading on desktop, or enter Full-screen reader; Esc/Back to sidebar preserves PDF page, zoom and table pagination. Images and SVG support drag, wheel and pinch zoom. Audio does not autoplay. The 16 MiB file limit and private-path restrictions remain. Self-contained HTML starts as an isolated static preview; enable interaction only for trusted pages, since isolation does not guarantee complete network blocking. Ask the Agent to use `deliver_files` for stable output links. See [files and deliverables](../FILE_VIEWER.md).

**Side chat** handles a separate question with main-chat background frozen at its first send. It can use its own model and read current project files. Writes and commands require approval for that reply. Both chats share files, so avoid concurrent edits. A settled side chat releases its runtime after 12 idle hours; refreshing its background can keep older sections on the page, but the new Agent does not inherit their discussion. Refreshing, closing the page or signing out ends temporary side chats. Copy useful content back to the main chat first. See [side chat](../SIDE_CHAT.md).

### Discuss selected text

Select message text to add a quote to the main draft, ask in side chat or read the selection aloud. Nothing is sent automatically; phones retain system copying. Unsent quotes disappear on refresh, and read-aloud may incur charges. See [quotes](../COMPOSER_TOOLS.md#选中文字提问).

## Generate images, video and speech in chat

Configure a media model, then ask “draw a cover for this report” or “read this paragraph aloud.” The Agent prepares a card; **nothing is generated or charged until you confirm it**.

- Edit parameters before confirming. Server-normalized changes return for another review.
- Results appear in the card and lab history, including after reconnecting or changing devices. The same card is not submitted twice.
- Multiple confirmed cards queue for available slots and can be cancelled before starting. Remote services allow 4 concurrent items (2 videos); local backends allow 1.
- A timeout may mean the provider is still processing and charging. Check history and the remote task first. Failures and uncertain results are not retried automatically; another generation needs confirmation.

Side chat does not provide generation cards. See [the media lab](../MEDIA_LAB.md).

## Media lab and read aloud

New installations have no executable media service. Add a URL, credentials, model and supported protocol through Models & capabilities or the lab. Upload supported reference material, edit parameters directly or ask for planning help, then review and confirm.

A reply's speaker button authorizes that audio request using read-aloud defaults and may incur a charge. Interface language does not change its voice or speech language. See [media connections](../MEDIA_CONNECTIONS.md) and [read aloud](../REPLY_TTS.md).

## Network & access

**Settings → Network & access** manages sign-in, listening scope and proxy settings. Listening and proxy changes are saved separately and apply after a safe service restart; saving does not restart or open a firewall. Enable sign-in before allowing other devices. Localhost in a proxy URL means the server. See [network and access](../ACCESS_CONTROL.md).

## Appearance and interface language

Theme and font size apply immediately under Preferences and stay local to this browser. Browser zoom still works; phone inputs remain at least 16px.

### Interface language

Simplified Chinese and English follow the browser preference by default, falling back to English. A saved language change applies on next open or refresh. Preserve drafts, attachments and side-chat content first. Language settings do not translate conversations, files or custom names, or change model requests and speech language. See [language](../I18N.md).

## Missing project directories

The picker is limited by server `PI_PROJECT_ROOTS` and OS permissions. Projects need not live in Documents, and a remote browser cannot select its device's local folders as server projects. Change the server startup configuration and safely restart; moving sessions is unnecessary. See [directory troubleshooting](../INSTALL_RECOVERY.md#项目选择器找不到目录).

## Versions and updates

**Settings → Versions and updates** checks Pivane and Pi versions without installing them. Copy the independent-Agent prompt to a separate Agent on the host to inspect compatibility, backups and an update plan. An Agent inside the service must not directly stop the service hosting its own conversation. Pi and Pivane are upgraded together. See [updates](../UPDATES.md).

## Settings, usage and notifications

- Usage covers persistent conversations and supported side-chat calls. Costs are estimates, not provider invoices; exclusions such as titles, temporary sessions and media planning are documented under [usage](../USAGE.md).
- Saving configuration generally leaves open runtimes unchanged. Finish work before reloading; browser refresh may reconnect to the same worker.
- Notifications, sounds and background push depend on browser/system permissions. See [notifications](../NOTIFICATIONS.md).
- Before upgrading, preserve drafts and wait for tasks and other active operations to finish, then follow [installation and recovery](INSTALL.md). Ordinary upgrades do not require renaming data files.

For help, supply redacted errors, steps and instance paths, not credentials. Detailed feature contracts in the [documentation index](../README.md) are primarily in Chinese.
