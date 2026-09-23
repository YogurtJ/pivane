# Pivane user guide

[简体中文](../USER_GUIDE.md) · [English home](../../README.en.md) · [Install](INSTALL.md)

Pivane runs on your computer or server. You can open it from another device's browser, but project paths, Shell commands and Agent tools operate on the **server's filesystem**.

## Start your first session

1. Follow the [installation guide](INSTALL.md), start your instance and open its URL.
2. Open **Settings → Providers and models** and check the configuration shared with Pi CLI. Sign in with an API key or OAuth only if usable credentials are missing. If the CLI has models but Pivane does not, check the identity and startup environment using [existing Pi users](INSTALL.md#existing-pi-cli-users). Enter credentials in settings, not in chat. For remote OAuth, a localhost callback refers to the server; use a device code or manual callback if the provider offers one.
3. Close settings, select an existing server project directory and create a thread. Select its model and thinking level. Open threads refresh the model catalog when idle; if no model is available, follow the settings link in the composer.

On desktop, click the model name in the session header to see favorites, the current model and recently used models. The project picker uses a folder icon, and the status strip shows the thread title alongside connection state, truncating long titles. On phones, tap the compact context ring immediately left of Send for a focused model, thinking and context sheet; the ring shows a number without `%` (`35` means 35%). Tapping Model opens the same searchable picker. When the composer has focus, a compact row shows the current model, thinking level and full context percentage. The folder/project name at the top opens the project picker directly, including the option to add a directory; the status strip shows the thread title or connection state. Files, history and the Reading/Full record view control are in the `i` details pane, not the model sheet. Reading is the default for a new browser; an existing browser retains its saved view choice. Context usage shows `--` when no reliable measurement is available, not a fabricated 0%.

Search names, full IDs or providers across the entire available catalog, or choose **View all models** to browse by provider. Stars only change favorites; clicking a model row switches the session. Favorites are saved on the Pivane instance and shared across devices; up to five recent models remain local to each browser. Existing browser favorites merge once when that browser loads the new picker. Reopening the picker or returning to the page reads the latest favorites; an open picker checks every five seconds. This does not change the global default. On phones and touch devices, the bottom sheet initially focuses its close button, so search input only receives focus when tapped.
4. Send a simple question. Refresh and reopen the persistent thread to verify that the reply is retained. This request uses your own provider account.

Before selecting a project, you can manage global Pi settings, Packages and Skills. `@` inserts a server project file path. Attachment uploads, paste and drag-and-drop read files supplied by your browser; they are different workflows.

## Workspace navigation

The colorful π at the top identifies Pivane. Pi Agent uses a conversation icon, and the Media Lab uses a flask; the active entry uses the theme accent color. On desktop, use the sidebar panel button beside the Pivane title to collapse navigation. The same button appears below the brand icon when collapsed. A single arrow inside the icon indicates the action direction; hover shows a soft accent background and an action label. The browser remembers your choice. Clicking the brand icon remains a shortcut.

Narrow tablets use an icon rail, with entry names available on hover. Phones use bottom navigation with visible labels. These layouts do not show the desktop collapse button.

## Models and capabilities

**Settings → Models & capabilities** combines Multimodal services (image, video and speech) with Subagents, powered by pi-subagents. Default installation attempts to download the pinned plugin version; failure leaves other Pivane features usable. Missing, disabled and unsupported versions are shown explicitly and cannot be configured here. A missing plugin can be installed after confirmation; use Packages to manage existing installations.

Subagent defaults and role overrides use the plugin's existing Pi settings, with global/project scope. Expand a role card to change its settings and view the original role ID; translated display names do not change role identity. The model picker supports search by name, full ID or provider, a provider filter, and batches of 40 results. Selecting a model still requires saving. Unavailable saved selections remain intact. **Automatic** removes the override for this scope; **Discard changes** clears only its unsaved draft. Plugin details and custom role overrides are under the expandable help section.

The role list contains bundled native roles and saved overrides, not complete live discovery. Adding an override by name does not create a role definition. Model options come from the available Pi catalog. Saved values may be overridden by role definitions, provider-specific settings or per-run choices. Saving does not launch tasks or interrupt existing runs; reopen the runtime when idle to apply changes.

## Customize system prompts

Open **Settings → System prompts**, choose all projects or the current project, and edit **Additional instructions** for response preferences and working habits. The advanced section replaces Pi's base instructions. Preview Markdown or review changes before saving. Restore default/inheritance first creates a draft; save it to remove this scope's file. Private backups retain the previous content.

Project prompts require project trust. A project prompt file takes precedence over its global counterpart; project and global additional instructions are not combined automatically. Saving does not interrupt tasks. When the conversation is idle, use **Reload and verify**, or open **Conversation details → Currently loaded resources → View system prompt** to inspect the current text, inferred sources and capture time. Other open conversations need their own reload. Refreshing the browser does not guarantee a new runtime.

Drafts stay in this page's memory across settings tabs and scopes; save before refreshing the browser. On a conflict, use **Refresh and compare draft**, review the latest disk content against your draft, then save. See the detailed [native configuration contract](../NATIVE_SETTINGS.md#系统提示词查看与编辑) in Chinese for file locations and limits.

## Interface language

The current source provides Simplified Chinese and English in one application. With no explicit preference, Pivane uses the first supported language in the browser's preference list. Chinese variants use Simplified Chinese; English variants use English. If no supported language is listed, English is used.

Under **Settings → Preferences → Interface language**, choose **Follow browser**, **简体中文** or **English**. The choice is stored on this browser for this site; other browsers and devices can choose independently. If browser storage is blocked, Pivane reports that the setting could not be saved.

A saved change applies the next time you open or refresh the page. Pivane does not refresh automatically: your current draft, attachments and temporary side chat stay available. Preserve them before refreshing, since a refresh ends temporary sessions and side chats and clears unsent page content.

Language selection changes application labels, dialogs, known application messages and displayed dates/numbers. It does not translate chat history, model replies, code, filenames, custom model names, saved prompts or user-defined metadata. It does not choose a speech language or add a language instruction to model requests. Built-in prompt-template examples are offered in the page's language when creating a new template; existing templates retain their original content.

Advanced documents, upstream/third-party diagnostics and background push notification text may retain their original language. The legacy media interface is outside this initial bilingual scope. The published RC1 archive predates this feature; its download is unchanged.

## Extensions, featured items and installed resources

Open **Extensions** in the desktop navigation, or at the top of the project/thread drawer on mobile. Empty conversations also offer **Explore skills**. The mobile bottom bar keeps its existing buttons. Settings retains links to **Installed packages** and **Installed skills**.

The extension center has **Featured**, **Installed packages** and **Installed skills** tabs. Search featured items by name, purpose or author. The directory includes [PPT Master](https://github.com/hugohe3/ppt-master), [pi-mcp-adapter](https://pi.dev/packages/pi-mcp-adapter), [pi-web-access](https://pi.dev/packages/pi-web-access), [pi-computer-use](https://github.com/injaneity/pi-computer-use), [pi-subagents](https://pi.dev/packages/pi-subagents) and [pi-hermes-memory](https://pi.dev/packages/pi-hermes-memory?name=memory). Cards show sources, requirements and examples. PPT Master requires Python and project dependencies; computer use requires a graphical session and OS permissions on the deployment machine. Memory setup should review storage scope, automatic learning and native dependency compatibility.

Cards show **Installed** with its scope, **Not installed**, **Configured · files unavailable**, or an unknown status requiring a check. Select global or current-project scope (including global resources), and use **Refresh installation status** to read the native inventory again. Matching uses registered sources, not skill names; manually copied skills need an assistant check. Untrusted project scope cannot establish that an item is absent. Failed reads clear stale status labels. Installed does not mean loaded in the current session or validated for your task.

**Learn & set up** passes the exact source to the Extension Assistant. **Add custom** accepts other needs or links. Browsing and searching do not install anything or send model requests. Installed resources continue to use the native inventory; after installation, reload resources in an idle session and verify them.

Execution records use readable labels for skill-file reads, inventory checks and package operations. Extension tools with recorded call-time provenance show a source label; expand the row to inspect the original tool name, source, arguments and result. Older records are not attributed using today's installation. Reading a skill file does not prove the model followed it. Reading mode still folds tool records; expand them or use the full record view.

Use **Composer + → Add capabilities…** or **Extensions → Installed packages / Installed skills → Set up with assistant** to create a dedicated Extension Assistant session. Choose an installation scope, describe a task or paste a source link, then select **Continue to assistant** in the footer. Installation host and project details can be expanded when needed. The request is placed in the composer for you to send; opening the assistant does not call a model or install anything. The Check for updates bubble drafts a request to inspect all installed Packages and Skills, verify their scopes, sources and versions, and propose updates with compatibility notes. Unknown versions are flagged, and updates wait for your confirmation. The Office documents example checks Word/PDF capabilities, sources, setup and compatibility before proposing installation. The Presentations bubble has been removed; use PPT Master in Featured. The question mark on each package or skill offers **About this package / skill** and **Troubleshoot**. About requests a read-only explanation of purpose, suitable tasks, an example and dependencies; troubleshooting requests a diagnosis and proposed fixes. Both include the exact source and scope in a draft for you to send.

The assistant checks existing resources, sources, licenses, dependencies and compatibility, then proposes a setup plan. Package changes use the native management service and a confirmation dialog. Standalone skill files and dependency setup use the session's enabled Agent tools. Installs run on the Pivane host. **Return to original chat** preserves the original draft and attachments in this page's memory; refresh clears unsent drafts. Existing runtimes need an explicit idle reload. Publicly available files are not automatically licensed for adaptation or redistribution, and arbitrary third-party packages are not guaranteed to work. See the [detailed assistant contract](../NATIVE_SETTINGS.md#扩展助手).

Open **Extensions → Installed packages** and choose all projects or the current project. Cards show package names, scope and installation status. Expand **Install from a link** to use npm, Git or a local path on the server. Installation, updates and removal still require confirmation of the source and scope.

**Advanced settings** starts collapsed and contains configured resource counts and controls; counts do not indicate what a conversation has loaded. Resources use available skill names, with directory or file names as a fallback instead of repeated SKILL.md or index.ts labels. Search the resource list, browse batches of 40, or expand **View source** to inspect a full path. Choose enabled, disabled or project inheritance and save. Untrusted projects cannot receive project writes. If a read fails, refresh to verify the current configuration; operations are not retried automatically. Reload resources when the conversation is idle. See the detailed [native settings contract](../NATIVE_SETTINGS.md).

On touch devices, Preferences scrolls vertically, with language, automatic titles, planner and notification controls fitting the available width. Browser zoom controls remain available.

## Versions and updates

Open **Settings → Versions and updates** to see the running Pivane and Pi versions and the Pi version bundled with this release. **Check for updates** queries GitHub and npm from the server; results are cached for five minutes. Choose stable Pivane releases or include prereleases. **Automatically check for Pi updates** is enabled by default: while the page is visible, the instance checks stable Pi versions at most once every 24 hours. A dot marks an available update; a light reminder appears once when work is idle. Dismiss it, snooze for three days, or skip that version. Devices share these choices, and network failures back off silently. **Review and update** opens the existing confirmation dialog; automatic checks never install anything. Use **Preview update reminder** to inspect the card at any time. Its example versions and buttons do not check for updates, change preferences or start an installation.

The page provides **Update Pi**, **Back up only** and **Restart instance**. Click Update Pi, confirm, then view the actual command, stdout/stderr, exit code and resulting version in the output area. Both `node server.js` and `npm start` automatically support this flow; existing service startup commands can stay unchanged after loading the new backend. Pi updates support Node 22 or 24 with the default local Pi installation. Since upstream `pi update` rejects project-local dependencies, Pivane uses an equivalent local npm update and shows the command it actually runs.

After you confirm that drafts are saved and external writers have stopped, Pivane rechecks its own activity, pauses scheduled messages and blocks new work. Updates install the exact Pi version and its matching packages in a separate directory and run isolated SDK/RPC/session checks before stopping for backup and activation. The old installation is retained. **Back up only** also stops and restarts the service; **Restart instance** does not create another data backup. Closing settings or losing the connection does not cancel or repeat an accepted operation.

Backups include Pi identity, sessions, configuration and media history/files, but exclude project source and external link targets. They stay in the private `.pivane-runtime` directory. Verify data and resume scheduled messages individually after maintenance. Installation compatibility checks do not certify every third-party extension or provider. The managed release contains a snapshot of Pivane's code; later edits to the original source directory do not automatically change it. Use `start:direct` in a separate development instance.

Pivane application updates are available from the version card when the managed launcher supports them. After confirmation, the server downloads and verifies the official archive, installs its locked dependencies, backs up data and switches releases. Busy instances reject the operation; retry after tasks finish. A global Pi CLI and extensions managed under Packages remain separate. For backup limits, failure handling and the offline restore command, see the detailed [update contract](../UPDATES.md) in Chinese. The automatic update flow has been exercised on Linux ARM64 with Node 22; other server platforms have not received native acceptance for this new flow.

## Conversation and tools

**Reading** is the default view and groups consecutive thinking and tool records. **Full record** shows them individually. The browser remembers your selection. While a task runs, send steering or follow-up messages, or stop the task. After a timeout or disconnect, check thread state before repeating a request.

Final replies in the main chat show the local message time to the right of the action icons. Hover to see the full date and time. This uses the native message timestamp, which can mark the start of generation rather than its exact completion. Missing or invalid timestamps are omitted.

Long user messages in the main chat use a generous folding threshold: text blocks exceeding 2,400 characters or 30 lines show a preview of about 20 lines. Choose **Show full message** to expand, or **Collapse message** to fold it again. Short messages stay fully visible, image attachments remain visible, and copying a question still copies its complete text. Expansion is retained during chat updates and resets to the default after a page refresh.

In the main composer, `!command` runs server Shell; `!!command` keeps its output out of later model context while retaining the native execution record. Tools use the server user's permissions. Project roots are not a sandbox. Install only trusted Packages, extensions and Skills.

Temporary sessions do not save a session file and end on refresh or disconnect. Unsent drafts and attachments live only in the current page.

## Task progress

When the Agent creates a plan for a substantial task, a **Task progress** card appears above the composer. It shows the completed count and pending, in-progress and completed steps. Click the heading to expand or collapse it; the collapsed card shows the current step, and a completed plan collapses automatically. Long lists scroll inside the card without changing drafts or attachments.

The built-in `update_plan` tool needs no extra package or user prompt configuration. The Agent decides when planning helps; you can also ask it to create and maintain a plan. Progress is reported by the Agent. Stopping, errors or a finished reply do not automatically complete unfinished steps. Ask the Agent to revise or clear the plan when needed.

Persistent threads restore the latest plan from the native Pi session after refresh, reconnect or restart. History navigation and forks follow their selected branch, and compaction preserves the plan. Temporary sessions retain it only during their lifetime; side chat has no progress card. Existing workers need an idle extension reload or runtime restart to acquire the new tool; refreshing the browser alone is insufficient.

## Archive projects and threads

The sidebar opens in **All**. Choose **Archive project** to move a project into **Archived projects** at the bottom, or **Archive thread** to move one thread into **Archived threads** under its project. Both sections start collapsed. Expand either section to open and read a thread directly; only **Restore project / Restore thread** moves it back to the regular list.

The two archive states are independent. Restoring a project keeps individually archived threads archived; restoring a thread does not restore its project. **Project archived** identifies a thread collected under its project's archive. Archiving preserves directories and native session records and does not stop running tasks. Archive state is shared by devices; disclosure state stays in this page.

The work view still shows running, unread, failed and waiting archived threads with an archive label. Archived threads stay out of Recent. Sidebar search and cross-thread content search exclude archives unless you check **Include archived**. Archive actions are available only when supported by the backend.

The thread menu groups **Session tree**, **Search history and bookmarks**, and **Export records** under **History and records**. The existing Copy submenu retains thread name and session ID. Arrow keys, Back and Escape work within the same popup.

## Auxiliary models

**Settings → Preferences → Auxiliary models** groups title generation and media planning by purpose. Each row offers provider/model selectors; its gear button opens guidance and implemented options. Click **Save changes** to apply edits. Existing title and media Feature Agent selections are retained without migration. Reopening this page reads the latest local model catalog while preserving unsaved selections. Subagent and auxiliary settings use native model configuration; models registered only by session extensions must also be configured under **Providers and models** to be available here.

Title generation’s **Auto** follows the current thread model. Media planning’s **Auto** uses its planner defaults, described in the row. Both purposes may share the same inexpensive model. An unavailable or failing dedicated model is not replaced with another model. **Set all to Auto** stages automatic choices for saving while preserving the automatic-title switch.

This does not change chat models, media execution models or resource installation. The Extension Assistant uses a normal dedicated conversation and its model selector; it does not add an auxiliary-model route. See the detailed [auxiliary model contract](../AUXILIARY_MODELS.md) for scope and future integration.

## Thread list display

Regular thread cards show a title and a compact metadata row without repeating the first question. Named titles use one line, with the full title available on hover. Unnamed threads use up to two lines from the first question. Update time, message count and selection highlighting remain visible; the work view also identifies the project.

Running, tool use, compaction, retries, waiting, unread, failure, stopped and unknown connection states remain visible. A retained runtime shows a green circle-check icon and **Idle** label with a tooltip explaining `/quit`; threads without a workspace runtime omit the inactive label. When a search match in the first question needs context, the card shows a nearby excerpt; clearing search removes it. Temporary threads retain their unsaved/disconnection notice.

The project menu groups **Import Pi session**, **Project trust**, and **Copy project path** under **More actions**. Common actions such as creating, pinning, refreshing and archiving remain at the top level. Thread menus omit the duplicate **Pending messages** entry; use the pending-message count/manage control above the composer. Queue indicators remain on thread cards.

Idle does not mean resources have been released. The default idle eviction threshold is 15 minutes, but eviction also requires no browser subscribers, running tasks or operations that prevent eviction; retained recovery drafts can also prevent it. Switching threads does not immediately stop the runtime. To release one explicitly, open that thread and use `/quit`.

## Conversation titles

The **Automatically name conversations** switch is under the gear button in **Settings → Preferences → Auxiliary models → Title generation**. It is enabled by default and shared by devices using this instance. New persistent threads created without a name receive a short title after their first substantive exchange. Greetings defer naming; later turns keep the title stable. Until then, the list shows a shortened first question. Existing history, copied/imported threads and manual names are protected.

In the title row, keep **Auto · current thread model** or choose a dedicated provider and model, then click **Save changes**. This choice is independent of other auxiliary purposes and chat defaults. Saving checks availability without running a generation. Disabling automatic naming preserves the model selection and still permits manual generation.

Choose **Generate a new title** in the thread menu to preview a suggestion using this preference. Edit it and save, or close the window to keep the existing name. If the name or conversation changes while generating, saving the stale suggestion is rejected. The regular **Rename** action remains available. A successful suggestion shows the model used and the input, output and cache token counts returned by Pi. Missing fields show “—”; entirely missing usage is identified as unreported.

Generation uses at most six recent questions/completed answers, capped at 2,000 characters each and 8,000 characters total. A long conversation never causes its full history to be sent. Thinking, tool output and images are excluded. If you select a different provider, that provider receives the excerpt. Generation adds no chat messages, but incurs additional model usage, currently outside persistent-session usage statistics; no cumulative title-usage log is stored. Failures keep the existing title and are not automatically retried. Models that depend on extension registration or request hooks may not support independent title generation; use manual naming in that case. Turning the feature off or changing the title model does not cancel a request already sent to the provider. The new choice applies to subsequent requests and prevents the previous in-flight automatic result from being applied. Manual suggestions identify the model actually used and still require saving.

## History, files and side chat

Use History to search records, manage bookmarks and view the session tree. Navigation, edit-and-retry and version restoration change the conversation position; **they do not undo files, commands or external requests**. Copying or forking creates a new thread sharing the same project files.

HTML exports are for reading. JSONL exports contain the current active branch for import and continuation, not the complete session tree. A complete backup requires stopping the service and preserving the data directories.

Open **Files → Project files** to browse the selected project's directory tree or find a file by name or relative path, including folders you have not expanded. Clicking a file reads its current contents. Breadcrumbs, Reveal in project and Copy file path help navigate. Browsing does not call a model or add file contents to its context; refresh directories and files explicitly.

On desktop, **Expand reader** provides more space and shows the tree beside the preview when the panel is wide enough. Narrow screens switch between browsing and reading. The hidden-file toggle retains private-path restrictions. Folder expansion and a bounded set of reading positions stay in this page only.

**Files this turn** retains successful edit/write tool records. Diffs and recorded write contents describe those operations. **Current file** reads the current disk file only when requested; use Refresh to update its snapshot. See [file browsing and viewing](../FILE_VIEWER.md) for preview limits and search scope.

Side chat freezes the main task's effective context when created. With `sideChatTools` enabled, it can read and search current files. Explicit modification requests can use edit, write and command tools after an approval inside side chat; the grant lasts for that reply and is reset afterwards. Main and side agents share files: avoid concurrent edits to the same files, and remember that stopping does not undo completed changes. Tool activity is shown in side chat; selected text can still be explicitly appended to the main draft. This page can retain a limited number of side chats across persistent threads. Refresh, closing the page and signing out end them.

## Media lab and read aloud

A new installation has no executable image, video or speech service. Add your own service URL, key and model ID under **Settings → Media models** or through the lab's connection manager. Select a protocol supported by the service's documentation. Chat credentials do not automatically configure media services.

Describe what you want, ask the Agent to create a plan, or edit common parameters. Review the submission checklist and explicitly confirm one generation. A plan, connection probe and generation are distinct operations. If a request fails or its result is uncertain, check service tasks and history first; Pivane does not automatically repeat it.

Configure read-aloud defaults under Preferences. Clicking a reply's speaker button authorizes generation of that reply's audio with those defaults and may incur a charge. Interface language does not change the selected voice, language or audio parameters.

## Settings, usage and notifications

Current source uses Pivane names while retaining compatibility with existing settings and session metadata. Ordinary upgrades do not require manual file renaming. Moving a project requires a separate offline migration of its native session ownership and runtime paths; never replace path strings throughout conversation JSONL. Maintainer details are in [naming and migration](../development/NAMING.md).

Usage statistics read native persistent-session records. Costs are historical estimates, not provider invoices. Temporary sessions, side chats, title generation and media planning are outside persistent-session usage statistics.

Saved Pi configuration generally applies to new runtimes. Existing tasks are not automatically stopped. When a setting requires reopening the runtime, finish the task, use `/quit`, then reopen the thread. Refreshing the webpage can reconnect to the same existing worker.

Page notifications and sounds can notify you while the page is running. Background push requires HTTPS and browser/system support. On iPhone/iPad, use a supported iOS version and add the site to the Home Screen. System sleep, permission and power settings can prevent notifications. Background push messages currently retain the server's original text.

Before upgrades or backups, pause scheduled messages, finish tasks, preserve drafts and stop the service. Follow [installation and recovery](INSTALL.md). For detailed feature and API contracts, use the [documentation index](../README.md); these detailed documents are primarily in Chinese.
