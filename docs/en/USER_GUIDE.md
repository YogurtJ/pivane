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
- Phones place additional entries under **More**. Bottom and header navigation remain available while the project/thread drawer is open. The header drawer button closes it directly; the project name opens the project picker. Opening another entry or panel closes the drawer first.
- **Projects** browses directories; **Activity** shows running work, items needing attention and recent threads. Sidebar search matches titles and first questions. **Search text** searches conversation content; Ctrl/Cmd+K focuses sidebar search.
- Text search retains its query, results page and reading position within the current page. **Locate current thread** adjusts the list and focus without changing archive state or restarting the session.
- Details, Files, History and Side chat share the right panel. Desktop panels dock and resize; narrow desktops temporarily hide the thread list. Phones use a drawer with Close and Esc support. Closing a panel does not stop its task.

Opening management pages does not end the session. Returning to Assistant chat reloads its projects and threads while retaining drafts and attachments within the page. When switching between Pi Agent and Assistant chat, select the thread again to continue. Drafts and loaded attachments are retained per thread within the page; **preserve unsent content before refreshing or closing it**.

Management pages load on first use, showing a loading state and a Retry action if resources cannot be read. You can navigate elsewhere while loading; a late result will not return you to the old page. Chat identity names, configuration viewers and automatic update reminders work before you visit a management page.

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

Enable **Show average reply request speed** in the same section to display `Request average ≈ … tok/s` below finished replies. It is hidden by default and saved per browser. Hover or focus the value for valid request count, output tokens and request time. The rate divides this reply segment's valid main-model output tokens by their combined request time, including first-output waiting, reasoning, network and retries within a request. Tools, compaction summaries and waits between requests are excluded. Automatic compaction preserves the running totals; failed, aborted or unmeasurable requests are excluded and the remaining result is marked partial. Reasoning tokens are already included in reported output. Legacy messages without measurements show no value; side chat and subagent calls are not merged into the main reply.

Timing uses boundary-only monotonic clock reads and a small snapshot stored with each native assistant message. It adds no per-token listener, timer, model request or separate statistics file. The visibility preference does not disable this lightweight recording.

Expand tool details before using browser Find to search their output. Long inline code wraps; code blocks and wide formulas scroll within their own areas. Invalid or over-budget formulas retain their source. Common Chinese punctuation (`，。、；：！？`) inside formulas renders normally; other strict checks and rendering limits remain in place. Main chat, side chat and Markdown file previews support `$…$`, `\(…\)`, `$$…$$`, `\[…\]` and `math`/`latex` fences. Formulas may follow prose without a blank line; standalone equals or minus signs inside math do not become headings. Lists, quotes, tables and bold/italic text protect formula pipes, stars and subscripts; `\|x\|` in tables retains its norm meaning. Incomplete display formulas retain their source while streaming and render when closed. Bold closing markers may follow punctuation and immediately precede Chinese characters. These display adaptations preserve original messages, code examples and escapes, and also apply when old messages are rendered again. Long user messages can be expanded, and Copy still returns their complete text. Reply timestamps may indicate generation start rather than completion.

Long replies scan formula starts within the current paragraph and reuse repeated formulas in a bounded cache. Consecutive nested-tool updates share a display frame. Streaming main and side chat retain unchanged paragraph, code and formula nodes, rebuilding them when later content changes their meaning. Finished replies are corrected from native records. Original messages and rendering limits are preserved.

Math commands follow the bundled KaTeX support: common fractions, roots, matrices, cases, multiline alignment and display equation numbering with `\tag` are supported. Put Chinese prose inside `\text{…}`. Custom macros apply only within one formula; external LaTeX packages are not loaded. The chemistry extension `\ce`, cross-formula `\label`/`\ref`/`\eqref` references and environments without math delimiters are not automatically rendered.

`!command` runs server Shell; `!!command` excludes it from later model context but retains its native execution record. Project roots are not a sandbox. Install only trusted extensions. After a timeout, disconnect or uncertain Stop/Take queue result, verify state before repeating a request. Stopping does not undo completed file changes or external requests.

When a connection cannot keep up with queued output, the server closes that slow connection. Persistent threads attempt to reconnect and read current records; accepted operations and other connections continue. The page does not automatically repeat requests whose outcome is unknown. Temporary sessions have no saved session file and end on refresh or disconnect. See [composer tools](../COMPOSER_TOOLS.md), [Shell](../WEB_SHELL.md) and [runtime controls](../NATIVE_CONTROLS.md).

### Voice input

Tap the microphone to record and again to stop and transcribe. Text enters an editable draft for you to send. Recording lasts up to two minutes and requires HTTPS or localhost plus browser permission. Audio goes to the selected service and may incur a charge; failures are not retried automatically. The setup link opens **Models & capabilities → Speech → ASR**. See [transcription](../COMPOSER_TOOLS.md#语音转录).

## Task progress

The **Task progress** chip opens an Agent-maintained step list. You can ask the Agent to create, revise or clear it. Progress is reported, not independently verified; a stop or final reply does not automatically complete unfinished steps. Persistent threads restore the latest plan for their current branch. Side chat does not offer this card.

## Agent task threads and messages

Ask “open another thread to handle this” to create and immediately start a persistent task in the same project. You may specify its model and thinking level; otherwise new-thread defaults apply. Results return as receipts without automatically waking the source. Stopping the source does not stop the new thread.

If creation is uncertain, inspect the original task instead of creating it again. Threads share project files, so assign distinct editing responsibilities. Agents can also contact existing project threads; delivery waits for idle, and **Leave a note only** does not actively wake the recipient. Repeated automatic exchanges eventually stop waking threads. Agent messages identify their source and do not extend user authorization. See [task threads and messages](../AGENT_THREADS.md).

## Assistant identities and memory

Create an identity under **Assistant profiles**, then select it in Assistant chat and choose a project category and thread. New ordinary Pi Agent threads do not bind an identity. An identity has five pages: **Overview** summarizes memories, skills, learning status and items that need attention; **Persona** edits the name, avatar, capability switches and SOUL (behavior, optionally starting from an example template); **Memories** manages entries for About you (USER), Long-term memory (MEMORY) and Project memory, with a Full text mode for editing USER.md or MEMORY.md directly; **Skills** reviews drafts and manages learned skills; **Learning** configures background learning and the daily budget. Identities you no longer use can be moved to the trash and restored at any time; no data is deleted.

Categories may share a server directory and add different instructions, but **files, AGENTS.md and memory scoped to the physical directory remain shared**. Identities are not security sandboxes, and opening a thread does not change its existing identity. See [assistant profiles](../AGENT_PROFILES.md).

Use the **Memories** and **Skills** pages to manage entries, deleted records and supported undo operations. Feedback distinguishes saved content from pending indexing. Saved or injected content does not prove that an open runtime has loaded it or that the model followed it. "Found by search N times" on a memory entry counts the times the assistant's memory search returned it; the full USER/MEMORY documents are provided every turn, so a missing count does not mean the entry was unseen, and editing an entry restarts its count.

Chat memory cards show receipts and eligible undo, correction or edit controls. Enabled skills need an idle resource reload. Background learning is off by default and requires dedicated auxiliary models; missing models, exhausted budgets, full memory and failures are shown explicitly. It does not silently use the chat model. The daily budget offers Economy, Balanced (default) and Active presets or a custom limit of up to 500 runs and 5 million tokens per day; Today's usage shows whether runs or reserved tokens ran out first and when the budget resets. Every option on the Learning page has an (i) explanation.

Consolidation prepares a proposal for review before applying it; stale item versions cannot overwrite newer content. Project memory editing requires a verified session scope. Correction and long-term preference triggers support customization; one-time requests can be excluded. Suspected credentials and prompt injection are rejected. Store credentials through model settings or a credential manager. See [memory and learning](../PROFILE_MEMORY.md#background-learning) for limits, migration and recovery.

## Customize system prompts

Under **Settings → System prompts**, select All projects or This project, edit and save instructions, then **Update current conversation** when idle. **Project instructions replace shared instructions; they do not automatically combine.** Project writes require trust.

**View current conversation** shows the actual assembled prompt and sources. Saving does not interrupt tasks; browser refresh may reconnect the same runtime. After a conflict or uncertain save, refresh and compare your draft first. See [system prompt configuration](../NATIVE_SETTINGS.md#系统提示词查看与编辑).

## Extensions, featured items and installed resources

Open **Extensions** on desktop or **More → Extensions** on phones:

- **Discover** filters curated items by type (packages, skills, messaging, MCP) and installation state. Cards show the installation state and installed version, and **Update available** after the latest check found a newer version; requirements and examples expand inside the card. Learn & set up places a request in a dedicated Extension Assistant draft for you to send; browsing and filtering do not install or call a model.
- **Installed** filters Packages, Skills, extension modules, templates and terminal themes, and shows package and skill versions (from the package manifest or SKILL.md; package resources show their package version). **Check for updates** queries npm and Git remotes only when you click it; packages with a newer version get an inline **Update**. Pinned versions, local paths and Pivane components are not checked, and offline mode makes no network request. Enable/disable is in the row; other update, remove and restore-inheritance actions are in its menu. Review source, scope and code-execution implications before installation.
- **Messaging** summarises the connector, accounts, bindings and messages that need attention, and guides unfinished setup through install → QR login → thread binding. Allowed users are added and removed as tags, with a save bar only for unsaved changes; uninstall and disable live in the `⋯` menu and ask for confirmation. It binds text/image DMs, file deliveries, slash commands and scheduled notifications to native threads. Use **Connect to WeChat…** in a thread menu to preselect it. See [messaging channels](../MESSAGE_CHANNELS.md).
- **MCP** manages global or trusted-project configuration. Saving is separate from connecting or reloading. Existing credentials stay unless explicitly replaced or removed. Status, reconnect and OAuth use an open persistent thread.

Installed does not mean loaded in the current conversation. Reload idle resources and verify them after setup. Untrusted projects cannot receive project writes. Legacy MCP adapter migration requires stopped backups; see [MCP](../MCP.md) and [native resources](../NATIVE_SETTINGS.md).

Use **Add → Add capabilities…** for setup or troubleshooting. Package operations use web confirmation, and tools run on the deployment machine. Computer-use extensions do not directly control the phone viewing Pivane. Third-party resources need their own dependencies and permissions.

## Scheduled tasks

Use **Scheduled tasks** for recurring or one-off work in a chosen thread or an identity's main thread. Add in the composer can create a task for the current thread. Check the timezone, next run, budget and missed-run behavior before enabling it.

Pausing a schedule and stopping its current run are separate actions. The server must remain running; busy work waits, and uncertain outcomes need verification. See [scheduled tasks](../SCHEDULED_TASKS.md).

## Thread list display

The list shows thread titles and status; hover reveals the full title and available statistics. The card stays visible while the conversation streams or scrolls, and closes when its row is left or the thread list scrolls. Activity refreshes preserve the list's reading position and expanded sections. Thread menus stay open during refreshes that leave the layout unchanged, and close when the viewport or anchor position changes. Idle does not mean the runtime has been released. Use `/quit` in the relevant thread to exit it explicitly; switching threads does not immediately stop its worker.

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

On desktop, the **conversation outline** on the chat's left edge shows one tick per question: point at a tick to preview the question and a reply summary, click to jump, and bookmark from the card or the question header (on phones, use the question header). Bookmarks are native Pi labels and also appear in the terminal `/tree`. After context compaction, earlier questions and replies stay above the “Context compacted” marker; scroll up to keep reading. They are for reading only—the model no longer reads that original text—and the outline includes them too.

**History** supports search, bookmarks, trees, forks and conversation navigation; **Show in conversation** in a preview jumps back to the record in context. Restoring a conversation position **does not undo files, commands or external requests**. HTML exports are for reading; JSONL exports contain the active branch. Back up stopped data directories to preserve complete session trees. See [history](../HISTORY.md), [workflows](../SESSION_WORKFLOWS.md) and [import/export](../SESSION_TRANSFER.md).

**Files** browses and searches the project and linked folders without adding contents to model context. Use the location selector to switch roots; Add or manage folders can open a server folder temporarily or save it for this project, without changing the chat working directory. External file links offer Open file only or Link folder and open, without requiring delivery first. Unlinking never deletes files. Historical diffs, Current file and immutable Deliverables are distinct sources. File cards below replies support keyboard navigation and collapse after expanding more files; focus stays with the control you explicitly select. Expand reading on desktop, or enter Full-screen reader; Esc/Back to sidebar preserves PDF page, zoom and table pagination. Images and SVG support drag, wheel and pinch zoom. Audio does not autoplay. The 16 MiB file limit and private-path restrictions remain. Self-contained HTML starts as an isolated static preview; enable interaction only for trusted pages, since isolation does not guarantee complete network blocking. Ask the Agent to use `deliver_files` for stable output links. See [files and deliverables](../FILE_VIEWER.md).

**Side chat** handles a separate question with main-chat background frozen at its first send. It can use its own model and read current project files. Writes and commands require approval for that reply. Both chats share files, so avoid concurrent edits. A settled side chat releases its runtime after 12 idle hours; refreshing its background can keep older sections on the page, but the new Agent does not inherit their discussion. Refreshing, closing the page or signing out ends temporary side chats. Copy useful content back to the main chat first. See [side chat](../SIDE_CHAT.md).

### Discuss selected text

Select message text to add a quote to the main draft, ask in side chat or read the selection aloud. Nothing is sent automatically; phones retain system copying. Unsent quotes disappear on refresh, and read-aloud may incur charges. See [quotes](../COMPOSER_TOOLS.md#选中文字提问).

## Generate images, video and speech in chat

Configure a media model, then ask “draw a cover for this report” or “read this paragraph aloud.” The Agent prepares a card. **Settings → Models & capabilities → Automatic generation in chat** controls execution by media type: image and speech cards can run automatically when enabled; video asks for confirmation by default. Automatic execution can incur the same provider charges as confirming a card.

- For a staged video workflow, first ask for opening/ending frames or reference images and wait for those cards to finish, confirming them when required. In the next turn, ask the Agent to use those images for a video. It reads current-branch results and uses stable asset references; the card shows frame roles and reference order. Finished videos can be played, downloaded and reused as video references.
- Video requests default to a two-hour wait, configurable up to 24 hours; existing saved values are preserved. For accepted asynchronous jobs, Continue querying original task retrieves the same job after a timeout or restart without creating another generation. Synchronous requests without a task ID need checking at the provider.
- To edit an image, upload a PNG/JPEG/WebP in Pi Agent or an assistant conversation and describe the changes. The Agent selects a model with image inputs and shows the reference on the confirmation card. You can also ask to edit a completed card image, or replace the reference under Edit parameters. Available inputs depend on the model.
- Use Edit parameters to review or change a card. When confirmation is required, server-normalized changes return for another review.
- Results appear in the card and lab history, including after reconnecting or changing devices. The same card is not submitted twice. Status refreshes preserve unsaved parameter edits on the page and playback progress for unchanged results; switching threads releases the old cards. Status queries and generation jobs have separate timeout limits.
- Multiple accepted cards queue for available slots and can be cancelled before starting. Remote services allow 4 concurrent items (2 videos); local backends allow 1.
- A timeout may mean the provider is still processing and charging. Check history and the remote task first. Failures and uncertain results are not retried automatically; another generation needs confirmation.

Side chat does not provide generation cards. See [the media lab](../MEDIA_LAB.md).

## Media lab and read aloud

New installations have no executable media service. Add a URL, credentials, model and supported protocol through Models & capabilities or the lab. Upload supported reference material, edit parameters directly or ask for planning help, then review and confirm.

A reply's speaker button authorizes that audio request using read-aloud defaults and may incur a charge. Interface language does not change its voice or speech language. See [media connections](../MEDIA_CONNECTIONS.md) and [read aloud](../REPLY_TTS.md).

## Network & access

**Settings → Network & access** manages sign-in, listening scope and proxy settings. Listening and proxy changes are saved separately and apply after a safe service restart; saving does not restart or open a firewall. Enable sign-in before allowing other devices. Localhost in a proxy URL means the server. See [network and access](../ACCESS_CONTROL.md).

## Appearance and interface language

Theme and font size apply immediately under Preferences (or from the palette button in the sidebar) and stay local to this browser. Browser zoom still works; phone inputs remain at least 16px.

Themes: Daylight (sky blue), Mint (teal green), Oat (warm paper with a terracotta accent), Graphite (neutral black and white) and Dark (deep gray with sky blue). Backgrounds stay close to neutral; the theme colour marks buttons, selections and links. System switches between Daylight and Dark. Added lines and healthy connections stay green in every theme. The retired Slate blue and Lilac themes open as Daylight until you pick a theme again.

### Interface language

Simplified Chinese and English follow the browser preference by default, falling back to English. Changing it reloads the page at once and restores unsent composer text. If draft attachments, a temporary session, side chats or a message being submitted would be affected, Settings lists them first: choose “Switch now” or let the change apply on the next refresh. Language settings do not translate conversations, files or custom names, or change model requests and speech language. See [language](../I18N.md).

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
