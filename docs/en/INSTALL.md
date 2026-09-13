# Install, update and recover Pivane

[English home](../../README.en.md) · [User guide](USER_GUIDE.md) · [中文完整指南](../INSTALL_RECOVERY.md)

Use **Node.js 22.x** with npm. The published RC1 baseline was tested with Node 22.23.2 and Pi 0.85.0 on Debian ARM64, Ubuntu 24.04 x86_64, Apple Silicon M2 macOS and Windows 11 x64/NTFS. See [platform validation](../RELEASE_INSTALL_VALIDATION.md) for exact limits. A browser at phone width does not constitute native iPhone/Safari validation.

The examples below install **1.0.0-rc.3**, which includes AI session titles, archives, system prompt editing and managed Pi updates, with Pi 0.85.1. Use matching archives, checksums and version directories together. The platform table above describes the original RC1 baseline; consult the [RC3 release notes](../releases/1.0.0-rc.3.md) and its validation attachment for checks performed on this newer artifact.

## Prerequisites

- Node 22.x and npm in the server process's PATH.
- Bash and ripgrep (`rg`). Windows needs Git for Windows/Git Bash. Linux additionally uses standard tar, gzip, curl, CA certificates and checksum tools in the examples below. On macOS, install ripgrep if needed, for example with `brew install ripgrep`.
- HTTPS access to npm to download locked dependencies on first installation.
- Your own model provider account or compatible model service. A model appearing in the catalog does not provide credentials or credit.

No global Pi installation, frontend build, GPU or installation-time native compilation is required. Keep packaged native source, binaries and manifests together. Do not reuse another OS/CPU's `node_modules`, omit optional dependencies, or use `npm audit fix --force` to change locked dependencies.

Use a personal non-root operating-system user and independent instance directories. These directories prevent accidental reuse of another instance's identity; they do not sandbox tools running as the same system user. Additional project tools, such as Git, compilers or Python, are installed separately as needed.

## Installation scope

For an ordinary deployment, check prerequisites, choose independent data directories and the intended project roots, run `npm ci` once, start the server, and verify read-only status and that the page opens. Full test suites, desktop/mobile regression, packaging and recovery drills belong to development validation. Persistent background service setup is an optional follow-up. Report time to first usable page separately from later validation or troubleshooting.

When given only the GitHub repository URL, prefer the Release archive and checksum. If the user explicitly chooses a Git checkout, record its commit and follow the same instance setup; a source checkout does not require development tests. After switching Node versions, check `node --version` and `node -p 'process.execPath'`. Chain the switch and installation with `&&` so a failed switch cannot silently run installation under the previous Node. Node 22 is the installation baseline, not proof that every other major version is incompatible.

Project roots are separate from data isolation. Ordinary installations default to `/` on Linux/macOS and the available drive roots on Windows, so projects can live anywhere accessible to the server user. Do not add a scope-selection step or silently restrict projects to Documents or the demo directory. Configure a narrower scope only when the user requests it.

## Linux and macOS

Download the archive and its `.sha256` file from [Releases](https://github.com/YogurtJ/pivane/releases) to Downloads and verify the source. In Bash or your macOS terminal:

```bash
ARCHIVE="$HOME/Downloads/pivane-1.0.0-rc.3.tar.gz"
# Linux:
(cd "$(dirname "$ARCHIVE")" && sha256sum -c "$(basename "$ARCHIVE").sha256")
# macOS: use this checksum command instead:
# (cd "$(dirname "$ARCHIVE")" && shasum -a 256 -c "$(basename "$ARCHIVE").sha256")
```

Continue only if verification succeeds. For a new instance, the base directory must not already exist:

```bash
BASE="$HOME/pivane"
test ! -e "$BASE" || { echo "Directory exists; use the update procedure or another BASE"; exit 1; }
umask 077
mkdir -p "$BASE/releases/1.0.0-rc.3" "$BASE/data/agent" "$BASE/data/media" "$BASE/projects/demo" "$BASE/backups"
tar -xzf "$ARCHIVE" -C "$BASE/releases/1.0.0-rc.3" --strip-components=1
cd "$BASE/releases/1.0.0-rc.3"
node --version
rg --version
npm ci
```

Create a fixed instance configuration. The shell expands `BASE` before writing; Pivane's `.env` reader itself does **not** expand variables or `~`.

```bash
cat > "$BASE/instance.env" <<EOF
HOST=127.0.0.1
PORT=3001
PI_WORKSPACE_BASE_URL=http://127.0.0.1:3001
PI_CODING_AGENT_DIR=$BASE/data/agent
PI_MEDIA_CONFIG_DIR=$BASE/data/agent/media-lab
PI_MEDIA_DATA_DIR=$BASE/data/media
PI_WEB_DEFERRED_FILE=$BASE/data/agent/pi5-deferred-messages.json
PI_PROJECT_ROOTS=/
EOF
chmod 600 "$BASE/instance.env"
cp "$BASE/instance.env" .env
env -i PATH="$PATH" HOME="$HOME" USER="$USER" LANG=en_US.UTF-8 npm start
```

The minimal environment avoids inheriting another instance's provider keys and `PI_*` settings. Preserve your own HOME. If your network requires a proxy, explicitly add the required proxy configuration for this instance. With a Node version manager, ensure the chosen Node 22 is actually in PATH; noninteractive SSH and service managers may not load shell startup scripts.

Open **http://127.0.0.1:3001**. Keep the terminal running; Ctrl+C stops the service. On later starts, enter the same release directory and use the same startup environment; `npm ci` is not required every time.

macOS's privacy controls and filesystem permissions still apply. `/tmp` resolving to `/private/tmp` is normal. Finder Trash is not integrated: session deletion tries `gio trash`, then permanently deletes if unavailable. The confirmation and result explain which behavior applies.

## Windows 11 x64

Install Node 22.x x64, Git for Windows and ripgrep, making them available in PATH. Normal installation does not require Visual Studio or WSL. Use a new directory under your own user profile. In PowerShell:

```powershell
$archive = Join-Path $env:USERPROFILE 'Downloads\pivane-1.0.0-rc.3.tar.gz'
$expected = (Get-Content -LiteralPath ($archive + '.sha256') -Raw).Trim().Split()[0]
if ($expected -notmatch '^[a-fA-F0-9]{64}$' -or (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash -ine $expected) { throw 'Archive checksum failed' }
$base = Join-Path $env:USERPROFILE 'Pivane'
if (Test-Path -LiteralPath $base) { throw 'Directory exists; use the update procedure or another base' }
$app = Join-Path $base 'releases\1.0.0-rc.3'
@($app, "$base\data\agent", "$base\data\media", "$base\projects\demo", "$base\backups") | ForEach-Object { New-Item -ItemType Directory -Path $_ -Force | Out-Null }
tar.exe -xzf $archive -C $app --strip-components=1
if ($LASTEXITCODE -ne 0) { throw 'Extraction failed' }
Set-Location -LiteralPath $app
node.exe --version
rg.exe --version
npm.cmd ci
if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed' }
```

Save absolute paths with forward slashes:

```powershell
$dataRoot = $base.Replace('\', '/')
$projectRoots = ([IO.Directory]::GetLogicalDrives() -join ';').Replace('\', '/')
$config = @"
HOST=127.0.0.1
PORT=3001
PI_WORKSPACE_BASE_URL=http://127.0.0.1:3001
PI_CODING_AGENT_DIR=$dataRoot/data/agent
PI_MEDIA_CONFIG_DIR=$dataRoot/data/agent/media-lab
PI_MEDIA_DATA_DIR=$dataRoot/data/media
PI_WEB_DEFERRED_FILE=$dataRoot/data/agent/pi5-deferred-messages.json
PI_PROJECT_ROOTS=$projectRoots
"@
[IO.File]::WriteAllText((Join-Path $base 'instance.env'), $config, [Text.UTF8Encoding]::new($false))
Copy-Item -LiteralPath (Join-Path $base 'instance.env') -Destination (Join-Path $app '.env')
npm.cmd start
```

Open **http://127.0.0.1:3001** and keep the window running. Later, enter the release directory and run `npm.cmd start`. Existing process environment variables override `.env`; clear this process's unneeded inherited provider keys, `PI_*` and `NODE_OPTIONS` before starting, without printing secrets or modifying other applications' system settings.

The Windows example includes all drive roots visible at installation, such as `C:/;D:/`. Update the configuration and restart when adding drives. To restrict the scope on request, use **semicolon-separated** paths such as `C:/Projects;D:/Work`. The directories must exist. Use NTFS-aware backups and verify the restored Agent directory's protected DACL. See the detailed [Windows guide](../WINDOWS.md) for filesystem and platform limits.

## First use and remote access

Open Settings → Providers and models and configure your provider. Tests send small billable requests; saving configuration alone does not test a model. Select an existing project directory, create a thread and choose its model. Send a simple question, then reopen the persistent thread to verify it was saved. Start with a synthetic project, not private production files.

The examples listen only on loopback. `localhost` on a phone means the phone, not the server. To connect from another device, configure the server's listen address, firewall, reachable workspace URL and access authentication. Use trusted HTTPS or a trusted private network for credentials. Change both `PORT` and `PI_WORKSPACE_BASE_URL` if you change the port.

The UI currently cannot change `PI_PROJECT_ROOTS`. If a directory is outside the configured roots, edit the server's actual `.env` or service environment; keep the fixed `instance.env` in sync if you use it. Nonempty process environment values override `.env`. Use absolute paths, not `~` or `$HOME`. Preserve drafts, pause scheduled messages, wait for active operations to finish, and restart through the existing independent management channel. Check the effective `projectRoots` in `/api/pi/status` after authentication. Moving projects or sessions is unnecessary. POSIX roots are colon-separated; Windows roots are semicolon-separated. Server filesystem permissions and macOS privacy controls continue to apply. Project roots are **not a tool sandbox**. For project resources, manage Pi trust through the project menu or `/trust`.

A fresh installation has no executable media service. Configure your own image, video or speech service separately. The lab's planning extension is included in the package and does not require global Package installation; it does require a configured chat model. For planning tools in ordinary Agent conversations, install the bundled `pi-packages/media-workbench` Package explicitly after reviewing its permissions. GPU adapters have additional service-specific prerequisites.

## Backups, upgrades and recovery

Preserve these together:

| Data | Example location |
|---|---|
| Native sessions, model credentials, settings and private backups | Entire `data/agent/` |
| Media connections and keys | `data/agent/media-lab/` plus the Agent credential store |
| Media history, prompts and generated files | Entire `data/media/` |
| Project files, uncommitted work and `.pi` resources | `projects/` and any other configured project roots |
| Startup environment and actual service configuration | `instance.env` and your service-manager configuration |
| Matching application and checksum | Original release archive and checksum |

External Package sources, symlink targets, external credential commands, certificates and remote service tasks may need separate backups. Browser drafts, unsent attachments, temporary sessions, side chats and pending in-memory tickets are not included in a disk backup.

1. Stop submitting new work. Finish Agent, Shell, side-chat, media, settings and import/export tasks. **Pause all scheduled messages in the UI.** Preserve unsent content.
2. Stop the service and any external CLI using the same Pi identity. Wait for exit before copying data. An HTTP activity check cannot prove an external CLI or remote provider task has stopped.
3. Back up the complete data, project and startup configuration directories together, outside those directories and outside public downloads. Keep private permissions and an encrypted copy elsewhere. Verify backup checksums.
4. For an upgrade, extract into a new release directory and run `npm ci`. Copy the fixed `instance.env` into it as `.env`. Keep the same absolute data/project paths. Start only the new service; never run two instances against the same identity or scheduled-message file.
5. Verify thread IDs, history, model authentication, files, search, usage and media downloads. Keep scheduled messages paused until reviewed. Do not automatically replay uncertain requests.

On Linux/macOS, after stopping the service, an example snapshot is:

```bash
BASE="$HOME/pivane"
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
umask 077
tar -czf "$BASE/backups/data-$STAMP.tar.gz" -C "$BASE" instance.env data projects
# Linux:
(cd "$BASE/backups" && sha256sum "data-$STAMP.tar.gz" > "data-$STAMP.tar.gz.sha256")
# macOS: use shasum -a 256 instead of sha256sum.
```

For recovery, stop the target instance, keep a copy of any existing target data and restore a trusted matching backup to the **original absolute paths**. Reinstall the matching application's locked dependencies. Compare file hashes before starting, then verify session semantics and IDs after opening the runtime. If you cannot verify that scheduled messages were paused in the backup, isolate outbound network access on the first recovery start and review the queue before reconnecting.

If an upgrade fails, keep the failed data snapshot. Use old code only if formats remain compatible; otherwise restore the matching complete pre-upgrade backup. Do not mix credentials, sessions and media from different points in time.

Changing project paths is not a full-history migration: native session headers and indexes are not rewritten automatically. Restore original paths or import an exported active JSONL branch into a new project as a new thread. Do not perform text replacement on JSONL to imitate a complete migration. See the [full recovery guide](../INSTALL_RECOVERY.md) for detailed limits.
