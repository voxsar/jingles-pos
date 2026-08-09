# Desktop update system

Jingles Inventory, Jingles POS, and Jingles Legacy Sync use `electron-updater` with the existing Windows NSIS packages. After a user installs the NSIS edition once, later versions download and install without running setup manually.

## User choices

Each app exposes **Updates > Update Preferences** in its application or tray menu:

- **Automatic** checks after startup and every six hours, then downloads in the background.
- **Ask before downloading** checks automatically but asks before transferring an update. This is the default.
- **Manual only** checks only through **Check for Updates**.

Users may skip one version. A downloaded update can restart immediately or install automatically when the app is closed. Update state is also exposed through the `updater:*` IPC handlers for a future in-page settings screen.

The Legacy Sync portable EXE remains available for diagnostics, but intentionally does not self-update because a running portable executable cannot be replaced reliably. Use its NSIS edition for automatic updates.

## Release a new version

Use a separate HTTPS directory for every app. Do not point multiple apps at the same `latest.yml`.

1. Increment the root and desktop package versions consistently. Versions must increase according to semantic versioning.
2. Build a signed release with the appropriate feed URL:

```powershell
cd quantum-shelf
$env:JINGLES_INVENTORY_UPDATE_URL='https://updates.example.com/inventory'
$env:JINGLES_WINDOWS_PUBLISHER='Exact certificate Common Name'
$env:CSC_LINK='C:\secure\jingles-signing.pfx'
$env:CSC_KEY_PASSWORD='read-from-your-secret-store'
npm run release:update:inventory

$env:JINGLES_LEGACY_SYNC_UPDATE_URL='https://updates.example.com/legacy-sync'
npm run release:update:legacy-sync

cd ..\federation-commerce
$env:JINGLES_POS_UPDATE_URL='https://updates.example.com/pos'
npm run release:update:pos
```

The URL is embedded in that release's `app-update.yml`. `JINGLES_UPDATE_CHANNEL` may be set to a channel such as `beta`; it defaults to `latest`.

3. Upload the generated NSIS `.exe` and `.exe.blockmap` first. Upload the generated channel YAML (normally `latest.yml`) last so clients never see metadata for an incomplete release.
4. Keep at least the current and previous installers/blockmaps available. Differential downloads may request the previous blockmap.
5. Test with one machine on the previous signed version before broad rollout.

Release outputs are:

- Inventory: `quantum-shelf/packages/electron/release`
- Legacy Sync: `quantum-shelf/packages/legacy-sync-app/release`
- POS: `federation-commerce/release/electron`

The static host must support HTTPS, byte-range requests, and ordinary `GET`/`HEAD` requests. Serve YAML with a short/no-cache policy and versioned installers/blockmaps with immutable caching.

## Signing and feed security

Production releases should be Authenticode-signed with the same publisher identity. `electron-updater` verifies Windows update signatures by default; never disable that verification. Keep signing keys and feed deployment credentials in CI secrets, not in either repository.

The update release scripts require `JINGLES_WINDOWS_PUBLISHER` plus `CSC_LINK` and fail before packaging when either is absent. For a localhost-only test build, `JINGLES_ALLOW_UNSIGNED_UPDATES=1` is an explicit escape hatch; never use it for a production feed.

For an emergency feed override, launch an installed app with its app-specific environment variable shown above, or place this file at `<resources>/update-config.json`:

```json
{
  "url": "https://updates.example.com/inventory",
  "channel": "latest"
}
```

Only HTTPS feeds are accepted, except localhost feeds used for development. To roll back a faulty release, publish a fixed build with a higher version; do not replace an artifact in place after clients may have cached it.

