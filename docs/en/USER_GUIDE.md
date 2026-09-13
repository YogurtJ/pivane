# Pivane user guide

[简体中文](../USER_GUIDE.md) · [English home](../../README.en.md) · [Install](INSTALL.md)

Pivane runs on your computer or server. You can open it from another device's browser, but project paths, Shell commands and Agent tools operate on the **server's filesystem**.

## Start your first session

1. Follow the [installation guide](INSTALL.md), start your instance and open its URL.
2. Open **Settings → Providers and models**, expand your provider and sign in with an API key or OAuth. Enter credentials in settings, not in chat. For remote OAuth, a localhost callback refers to the server; use a device code or manual callback if the provider offers one.
3. Close settings, select an existing server project directory and create a thread. Select its model and thinking level. Open threads refresh the model catalog when idle; if no model is available, follow the settings link in the composer.
4. Send a simple question. Refresh and reopen the persistent thread to verify that the reply is retained. This request uses your own provider account.

Before selecting a project, you can manage global Pi settings, Packages and Skills. `@` inserts a server project file path. Attachment uploads, paste and drag-and-drop read files supplied by your browser; they are different workflows.

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

## Packages and resources

Open **Settings → Packages** and choose all projects or the current project. The overview shows enabled and total configured extensions, skills, prompts and themes; it does not indicate what a conversation has loaded. Install from npm, Git or a local path on the server. Installation, updates and removal still require confirmation of the source and scope.

Package cards show source, scope and installation status. Search the resource list, browse batches of 40, or expand **View source** to inspect a full path. Choose enabled, disabled or project inheritance and save. Untrusted projects cannot receive project writes. If a read fails, refresh to verify the current configuration; operations are not retried automatically. Reload resources when the conversation is idle. See the detailed [native settings contract](../NATIVE_SETTINGS.md).

On touch devices, Preferences scrolls vertically, with language, automatic titles, planner and notification controls fitting the available width. Browser zoom controls remain available.

## Versions and updates

Open **Settings → Versions and updates** to see the running Pivane and Pi versions and the Pi version bundled with this release. **Check for updates** queries GitHub and npm from the server; results are cached for five minutes. Choose stable releases or include prereleases. Opening the page does not automatically contact either source.

The page provides **Update Pi**, **Back up only** and **Restart instance**. Click Update Pi, confirm, then view the actual command, stdout/stderr, exit code and resulting version in the output area. Both `node server.js` and `npm start` automatically support this flow; existing service startup commands can stay unchanged after loading the new backend. Pi updates support Node 22 or 24 with the default local Pi installation. Since upstream `pi update` rejects project-local dependencies, Pivane uses an equivalent local npm update and shows the command it actually runs.

After you confirm that drafts are saved and external writers have stopped, Pivane rechecks its own activity, pauses scheduled messages and blocks new work. Updates install the exact Pi version and its matching packages in a separate directory and run isolated SDK/RPC/session checks before stopping for backup and activation. The old installation is retained. **Back up only** also stops and restarts the service; **Restart instance** does not create another data backup. Closing settings or losing the connection does not cancel or repeat an accepted operation.

Backups include Pi identity, sessions, configuration and media history/files, but exclude project source and external link targets. They stay in the private `.pivane-runtime` directory. Verify data and resume scheduled messages individually after maintenance. Automatic checks do not certify every third-party extension or provider. The managed release contains a snapshot of Pivane's code; later edits to the original source directory do not automatically change it. Use `start:direct` in a separate development instance.

Pivane application updates still use the official release archive and manual platform guides. A global Pi CLI and extensions managed under Packages remain separate. For backup limits, failure handling and the offline restore command, see the detailed [update contract](../UPDATES.md) in Chinese. The automatic update flow has been exercised on Linux ARM64 with Node 22; other server platforms have not received native acceptance for this new flow.

## Conversation and tools

**Reading** is the default view and groups consecutive thinking and tool records. **Full record** shows them individually. The browser remembers your selection. While a task runs, send steering or follow-up messages, or stop the task. After a timeout or disconnect, check thread state before repeating a request.

In the main composer, `!command` runs server Shell; `!!command` keeps its output out of later model context while retaining the native execution record. Tools use the server user's permissions. Project roots are not a sandbox. Install only trusted Packages, extensions and Skills.

Temporary sessions do not save a session file and end on refresh or disconnect. Unsent drafts and attachments live only in the current page.

## Archive projects and threads

The sidebar opens in **All**. Choose **Archive project** to move a project into **Archived projects** at the bottom, or **Archive thread** to move one thread into **Archived threads** under its project. Both sections start collapsed. Expand either section to open and read a thread directly; only **Restore project / Restore thread** moves it back to the regular list.

The two archive states are independent. Restoring a project keeps individually archived threads archived; restoring a thread does not restore its project. **Project archived** identifies a thread collected under its project's archive. Archiving preserves directories and native session records and does not stop running tasks. Archive state is shared by devices; disclosure state stays in this page.

The work view still shows running, unread, failed and waiting archived threads with an archive label. Archived threads stay out of Recent. Sidebar search and cross-thread content search exclude archives unless you check **Include archived**. Archive actions are available only when supported by the backend.

The thread menu groups **Session tree**, **Search history and bookmarks**, and **Export records** under **History and records**. The existing Copy submenu retains thread name and session ID. Arrow keys, Back and Escape work within the same popup.

## Auxiliary models

**Settings → Preferences → Auxiliary models** groups title generation and media planning by purpose. Each row offers provider/model selectors; its gear button opens guidance and implemented options. Click **Save changes** to apply edits. Existing title and media Feature Agent selections are retained without migration.

Title generation’s **Auto** follows the current thread model. Media planning’s **Auto** uses its planner defaults, described in the row. Both purposes may share the same inexpensive model. An unavailable or failing dedicated model is not replaced with another model. **Set all to Auto** stages automatic choices for saving while preserving the automatic-title switch.

This does not change chat models, media execution models or resource installation. Packages/Skills still use their existing management tools; there are no separate AI discovery/review purposes yet. See the detailed [auxiliary model contract](../AUXILIARY_MODELS.md) for scope and future integration.

## Conversation titles

The **Automatically name conversations** switch is under the gear button in **Settings → Preferences → Auxiliary models → Title generation**. It is enabled by default and shared by devices using this instance. New persistent threads created without a name receive a short title after their first substantive exchange. Greetings defer naming; later turns keep the title stable. Until then, the list shows a shortened first question. Existing history, copied/imported threads and manual names are protected.

In the title row, keep **Auto · current thread model** or choose a dedicated provider and model, then click **Save changes**. This choice is independent of other auxiliary purposes and chat defaults. Saving checks availability without running a generation. Disabling automatic naming preserves the model selection and still permits manual generation.

Choose **Generate a new title** in the thread menu to preview a suggestion using this preference. Edit it and save, or close the window to keep the existing name. If the name or conversation changes while generating, saving the stale suggestion is rejected. The regular **Rename** action remains available. A successful suggestion shows the model used and the input, output and cache token counts returned by Pi. Missing fields show “—”; entirely missing usage is identified as unreported.

Generation uses at most six recent questions/completed answers, capped at 2,000 characters each and 8,000 characters total. A long conversation never causes its full history to be sent. Thinking, tool output and images are excluded. If you select a different provider, that provider receives the excerpt. Generation adds no chat messages, but incurs additional model usage, currently outside persistent-session usage statistics; no cumulative title-usage log is stored. Failures keep the existing title and are not automatically retried. Models that depend on extension registration or request hooks may not support independent title generation; use manual naming in that case. Turning the feature off or changing the title model does not cancel a request already sent to the provider. The new choice applies to subsequent requests and prevents the previous in-flight automatic result from being applied. Manual suggestions identify the model actually used and still require saving.

## History, files and side chat

Use History to search records, manage bookmarks and view the session tree. Navigation, edit-and-retry and version restoration change the conversation position; **they do not undo files, commands or external requests**. Copying or forking creates a new thread sharing the same project files.

HTML exports are for reading. JSONL exports contain the current active branch for import and continuation, not the complete session tree. A complete backup requires stopping the service and preserving the data directories.

Successful edit/write tool records produce a file list for each turn. Diffs and recorded write contents describe those operations. **Current file** reads the current disk file only when requested; use Refresh to update its snapshot. Large code, formulas and diagrams stay in their own viewing areas.

Side chat freezes the main task's effective context when created and has no tools. Discuss independently, then explicitly append selected text to the main draft. This page can retain a limited number of side chats across persistent threads. Refresh, closing the page and signing out end them.

## Media lab and read aloud

A new installation has no executable image, video or speech service. Add your own service URL, key and model ID under **Settings → Media models** or through the lab's connection manager. Select a protocol supported by the service's documentation. Chat credentials do not automatically configure media services.

Describe what you want, ask the Agent to create a plan, or edit common parameters. Review the submission checklist and explicitly confirm one generation. A plan, connection probe and generation are distinct operations. If a request fails or its result is uncertain, check service tasks and history first; Pivane does not automatically repeat it.

Configure read-aloud defaults under Preferences. Clicking a reply's speaker button authorizes generation of that reply's audio with those defaults and may incur a charge. Interface language does not change the selected voice, language or audio parameters.

## Settings, usage and notifications

Usage statistics read native persistent-session records. Costs are historical estimates, not provider invoices. Temporary sessions, side chats, title generation and media planning are outside persistent-session usage statistics.

Saved Pi configuration generally applies to new runtimes. Existing tasks are not automatically stopped. When a setting requires reopening the runtime, finish the task, use `/quit`, then reopen the thread. Refreshing the webpage can reconnect to the same existing worker.

Page notifications and sounds can notify you while the page is running. Background push requires HTTPS and browser/system support. On iPhone/iPad, use a supported iOS version and add the site to the Home Screen. System sleep, permission and power settings can prevent notifications. Background push messages currently retain the server's original text.

Before upgrades or backups, pause scheduled messages, finish tasks, preserve drafts and stop the service. Follow [installation and recovery](INSTALL.md). For detailed feature and API contracts, use the [documentation index](../README.md); these detailed documents are primarily in Chinese.
