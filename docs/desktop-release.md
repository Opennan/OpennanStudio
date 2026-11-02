# Studio downloads and updates

Studio release binaries and update feeds are hosted on Cloudflare R2 at
`https://cdn.opennan.com/programs/studio/`. Existing Voice hosting is unchanged.
The public website reads `latest.json` and offers Apple Silicon, Intel Mac and
Windows x64 installers. Browsers can identify macOS but cannot reliably identify
the Mac chip, so visitors retain an explicit Intel choice.
Electron 44 requires macOS 13 or newer; the installer and website state that
minimum. See [Electron 44](https://www.electronjs.org/blog/electron-44-0).

## Configure before the first release

The `studio-release` GitHub environment needs:

- `MAC_CSC_LINK`, `MAC_CSC_KEY_PASSWORD`: Apple Developer ID Application certificate.
- `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`: Apple notarization credentials.
- `WIN_CSC_LINK`, `WIN_CSC_KEY_PASSWORD`: a Windows Authenticode signing certificate supported by electron-builder. If the certificate requires a hardware/cloud signing service, configure that signer before using this workflow; do not export a non-exportable key.
- `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_ENDPOINT`, `R2_BUCKET`: bucket-scoped release publishing credentials. Endpoint format: `https://<account-id>.r2.cloudflarestorage.com`.

Connect `cdn.opennan.com` to that bucket and ensure its cache policy respects
the objects' Cache-Control headers. Do not use this workflow to migrate Voice
or existing assets. Store secrets in the environment, never in this repository.

Use a strictly increasing stable version in `apps/desktop/package.json`. Run
**Signed Studio release** manually from `main` after local workflow verification
and release authorization. A missing signer, missing scanner, failed scan,
failed notarization, test failure or missing platform stops publication.

## Release checks

Each host builds its own native modules and bundled media tools, runs desktop
tests, packages, verifies OS signatures, runs a packaged launch and browser
regressions, and scans the output, including extracted ASAR contents so bundled
JavaScript and dependencies are visible to the scanner. macOS uses fresh ClamAV signatures and Apple
notarization; Windows uses current Microsoft Defender signatures. Do not bypass
these gates when a hosted runner cannot run the scanner.

The publisher validates hashes for all three platforms before uploading.
Versioned binary keys cannot be overwritten. It checks the actual CDN bytes
before switching any platform's update feed, then writes the website manifest
last. An interrupted upload can be retried with the same byte-identical build
artifacts. Rebuilding a failed version can change signing timestamps: use a new
version if immutable files were already uploaded. Old binaries remain available
for installed apps whose update downloads are still in flight.

Feeds are separate for `darwin-arm64`, `darwin-x64` and `win32-x64` to avoid Mac
metadata collisions. Signed release builds check at launch and every six hours,
download in the background and install on normal app quit. They never force a
restart during editing. Prereleases and downgrades are disabled. Development and
ordinary CI builds do not auto-update; `OPENNAN_DISABLE_UPDATES=1` also disables it.

## What the checks mean

A successful scan is evidence about that file with that scanner's current
definitions, not a guarantee against every threat. A new signed Windows release
can still show a SmartScreen reputation warning. Signing and notarization do not
justify advertising “zero warnings” or asking users to turn off security tools.
See [Apple notarization](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution)
and [Microsoft SmartScreen reputation](https://learn.microsoft.com/windows/apps/package-and-deploy/smartscreen-reputation).

No signed release or malware scan is implied by checking in this workflow.
Before claiming availability, run it successfully, verify installation and an
update from a previous signed build on both operating systems, and verify the
public download page and CDN files.
