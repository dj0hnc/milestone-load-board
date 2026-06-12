# Rebuilding the portable .exe

The app builds with standard Electron tooling, but this machine needed three things to get a
clean single-file portable build. They're baked into `build.cmd`.

## Prereqs
- **Node.js** (portable is fine — no admin). A copy lives under
  `_milestone_work/toolchain/node-v24.16.0-win-x64`.
- Network access to GitHub (electron-builder downloads Electron + NSIS the first time).

## Three gotchas (already handled)
1. **Build from a path with no spaces and no `&`.** The working folder
   `TX AI Planning & Dispatch tool` breaks electron-builder's subprocess spawning.
   `build.cmd` copies the source to `%USERPROFILE%\milestone-build` first.
2. **`signAndEditExecutable: false`** in `package.json` → electron-builder skips the
   `winCodeSign` helper. That helper extracts macOS symlinks, which Windows blocks without
   admin / Developer Mode. We don't sign the portable exe, so skipping it is correct here.
3. Run `electron-builder` via its local `.bin` cmd, not bare `npx`.

## Build
```
build.cmd
```
Output: `dist\MilestoneLoadBoard-2.0.0-portable.exe`, copied back next to this file.

## Manual steps (equivalent)
```bat
set PATH=<node-dir>;%PATH%
robocopy "<source>" "%USERPROFILE%\milestone-build" /E /XD node_modules dist dist-pkg
cd /d "%USERPROFILE%\milestone-build"
npm install
node_modules\.bin\electron-builder.cmd --win portable --x64
```

## To sign it later (optional, on an admin/Developer-Mode machine)
Set `signAndEditExecutable: true`, provide a code-signing cert via `CSC_LINK` / `CSC_KEY_PASSWORD`,
and rebuild. Signing removes the SmartScreen "unknown publisher" prompt.
