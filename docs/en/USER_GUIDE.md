# Pivane user guide

[简体中文](../USER_GUIDE.md) · [English home](../../README.en.md) · [Install](INSTALL.md)

Pivane runs on your computer or server. You can open it from another device's browser, but project paths, Shell commands and Agent tools operate on the **server's filesystem**.

## Start your first session

1. Follow the [installation guide](INSTALL.md), start your instance and open its URL.
2. Open **Settings → Providers and models**, expand your provider and sign in with an API key or OAuth. Enter credentials in settings, not in chat. For remote OAuth, a localhost callback refers to the server; use a device code or manual callback if the provider offers one.
3. Close settings, select an existing server project directory and create a thread. Select its model and thinking level. Open threads refresh the model catalog when idle; if no model is available, follow the settings link in the composer.
4. Send a simple question. Refresh and reopen the persistent thread to verify that the reply is retained. This request uses your own provider account.

Before selecting a project, you can manage global Pi settings, Packages and Skills. `@` inserts a server project file path. Attachment uploads, paste and drag-and-drop read files supplied by your browser; they are different workflows.

## Interface language

The current source provides Simplified Chinese and English in one application. With no explicit preference, Pivane uses the first supported language in the browser's preference list. Chinese variants use Simplified Chinese; English variants use English. If no supported language is listed, English is used.

Under **Settings → Preferences → Interface language**, choose **Follow browser**, **简体中文** or **English**. The choice is stored on this browser for this site; other browsers and devices can choose independently. If browser storage is blocked, Pivane reports that the setting could not be saved.

A saved change applies the next time you open or refresh the page. Pivane does not refresh automatically: your current draft, attachments and temporary side chat stay available. Preserve them before refreshing, since a refresh ends temporary sessions and side chats and clears unsent page content.

Language selection changes application labels, dialogs, known application messages and displayed dates/numbers. It does not translate chat history, model replies, code, filenames, custom model names, saved prompts or user-defined metadata. It does not choose a speech language or add a language instruction to model requests. Built-in prompt-template examples are offered in the page's language when creating a new template; existing templates retain their original content.

Advanced documents, upstream/third-party diagnostics and background push notification text may retain their original language. The legacy media interface is outside this initial bilingual scope. The published RC1 archive predates this feature; its download is unchanged.

## Conversation and tools

**Reading** is the default view and groups consecutive thinking and tool records. **Full record** shows them individually. The browser remembers your selection. While a task runs, send steering or follow-up messages, or stop the task. After a timeout or disconnect, check thread state before repeating a request.

In the main composer, `!command` runs server Shell; `!!command` keeps its output out of later model context while retaining the native execution record. Tools use the server user's permissions. Project roots are not a sandbox. Install only trusted Packages, extensions and Skills.

Temporary sessions do not save a session file and end on refresh or disconnect. Unsent drafts and attachments live only in the current page.

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

Usage statistics read native persistent-session records. Costs are historical estimates, not provider invoices. Temporary sessions, side chats and media planning are outside persistent-session usage statistics.

Saved Pi configuration generally applies to new runtimes. Existing tasks are not automatically stopped. When a setting requires reopening the runtime, finish the task, use `/quit`, then reopen the thread. Refreshing the webpage can reconnect to the same existing worker.

Page notifications and sounds can notify you while the page is running. Background push requires HTTPS and browser/system support. On iPhone/iPad, use a supported iOS version and add the site to the Home Screen. System sleep, permission and power settings can prevent notifications. Background push messages currently retain the server's original text.

Before upgrades or backups, pause scheduled messages, finish tasks, preserve drafts and stop the service. Follow [installation and recovery](INSTALL.md). For detailed feature and API contracts, use the [documentation index](../README.md); these detailed documents are primarily in Chinese.
