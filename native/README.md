# Native filesystem boundary

`server/pi-file-descriptor.js` supplies opened-object final paths for file preview, session text search and usage scanning. Linux retains `/proc/self/fd`. The macOS Node-API 8 bundle calls `fcntl(fd, F_GETPATH)`. The Windows x64 Node-API 8 DLL calls Node's exported libuv descriptor conversion API, then Win32 filesystem APIs. No backend substitutes the requested path for a failed descriptor lookup.

All native artifacts ship with source and SHA256 build manifests. Normal installation does not download native code or compile anything. The loaders check binary/source hashes; missing or mismatched modules fail closed. The Windows module is also required for private filesystem writes, so a damaged Windows component can prevent configuration initialization rather than merely disabling file previews.

## macOS

`pi-darwin-fd.node` is a universal arm64/x86_64 bundle. The module only queries an existing fd; it does not open paths or write files. Caller policy, lifetime and before/after checks remain in JavaScript.

```sh
node scripts/build-darwin-fd.cjs
```

The maintainer build uses Apple clang and Node headers (`PI_NODE_HEADERS` can select an explicit directory), records compiler flags and source/binary hashes, and requires Xcode Command Line Tools. Runtime requires macOS 11 or later; actual hardware acceptance is M2/arm64, not Intel.

## Windows

`pi-win32-x64-fd.node` uses `uv_get_osfhandle` and `uv_open_osfhandle` exported by Node itself. It never calls `_get_osfhandle` through a separate CRT table. The DLL has no CRT dependency: its only imports are node.exe, Kernel32 and Advapi32. The native boundary provides:

- `GetFinalPathNameByHandleW` with normalized DOS-volume paths, and complete volume/128-bit file identity;
- non-following final-file opens using `FILE_FLAG_OPEN_REPARSE_POINT`, rejecting reparse points/devices before adopting the HANDLE as a Node fd;
- private file creation with an initial protected DACL, and protection of dedicated configuration/export directories;
- same-filesystem `MoveFileExW` replacement with `WRITE_THROUGH`, after the caller flushes the writable file handle. No copy/delete fallback or directory-fsync suppression on other platforms.

Private ACLs grant the current token's user, SYSTEM and Administrators. The implementation does not enumerate credentials or alter the OS temporary directory. The application protects its dedicated Pi data directory before loading the SDK; individual private writes create protected files. Source and import-library paths never enter user-generated shell commands.

A maintainer can cross-build with verified Zig 0.14.1 and official Node 22.23.2 headers/import library:

```sh
PI_WINDOWS_ZIG=/path/to/zig \
PI_WINDOWS_NODE_HEADERS=/path/to/node-v22.23.2/include/node \
PI_WINDOWS_NODE_LIB=/path/to/win-x64/node.lib \
node scripts/build-win32-fd.cjs
```

The build uses the Windows API headers bundled with the verified compiler distribution, records compiler/header/import-library hashes and flags, and links without a CRT. The compiled result must still pass actual Windows tests. Invalid and closed fd probes run in separate processes, and final-link/ADS/device/case-sensitive-boundary/ACL tests exercise the real OS. Win32 refusal to rename an open object is recorded separately from successful POSIX renames; it is not reported as a successful move.

The verified target is Windows 11 x64 with official Node 22.23.2. ARM64, other Windows versions, network filesystems and other disk formats are not hardware-validated. See docs/WINDOWS.md for deployment and validation scope.

This is project-owned code under the project's ISC license declaration. It does not patch Pi or any node_modules package.
