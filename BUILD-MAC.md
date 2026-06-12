# Building the Mac version (10 minutes, on any Mac)

The app code is cross-platform — only the packaging step must run on macOS
(Apple tooling restriction; it cannot be done from Windows).

## Steps (on the Mac)

1. Install **Node.js LTS**: https://nodejs.org (or `brew install node`).
2. Copy this whole `MilestoneLoadBoard` folder to the Mac (zip it, AirDrop/SharePoint —
   **exclude** `node_modules` and `dist`).
3. In Terminal, inside the folder:
   ```bash
   npm install
   npm run dist-mac
   ```
4. Output: `dist/MilestoneLoadBoard-2.0.0.dmg` — universal (Apple Silicon + Intel).
   Share that .dmg with the Mac users.

## First-open on each Mac (unsigned app)

The app is not Apple-notarized (that needs a $99/yr Apple Developer account), so the
FIRST launch must be: **right-click the app → Open → Open**. After that it opens
normally forever. If macOS still complains:
```bash
xattr -cr /Applications/MilestoneLoadBoard.app
```

## Notes

- Everything works the same as Windows: in-app NewMile login per user, live refresh,
  push, Samsara map/camera, Excel paste (Cmd+V on Mac).
- Sessions/preferences are stored per macOS user (`~/Library/Application Support/Milestone Load Board`).
- To notarize later (no first-open warning): get an Apple Developer ID, set
  `"identity"` in package.json `build.mac` and follow electron-builder's notarize docs.
