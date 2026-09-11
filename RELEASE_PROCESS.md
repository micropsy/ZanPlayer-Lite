# Release Process (Standard Operating Procedure)

Strict checklist for **any AI agent or human developer** preparing a release of **ZanPlayer Lite**.
Follow it exactly. Do not skip steps. Do not guess versions.

## 1. Determine the release type (Semantic Versioning, `MAJOR.MINOR.PATCH`)

| Bump      | When                                                        | Example    |
| --------- | ----------------------------------------------------------- | ---------- |
| `PATCH`   | Bug fixes (e.g. fixing a translation/download edge case)    | `0.1.3 -> 0.1.4` |
| `MINOR`   | New feature, backwards compatible                           | `0.1.3 -> 0.2.0` |
| `MAJOR`   | Breaking change                                             | `0.2.0 -> 1.0.0` |

Only bump the digit that matches the change. Never bump two digits at once.
Always read the current version from `package.json` first — never guess or hardcode it.

## 2. Prerequisites

1. Working tree is clean (`git status` shows no modified/untracked files).
2. You are on `main` and up to date with `origin/main`.
3. The current version is **identical** across these five files:

   - `package.json`
   - `package-lock.json` (root entry + `packages[""]`)
   - `src-tauri/Cargo.toml` (`[package] -> version`)
   - `src-tauri/Cargo.lock` (the `[[package]] name = "zanplayer-lite"` block)
   - `src-tauri/tauri.conf.json` (`version`)

   Tauri requires all of them to match; drift breaks the build and the updater.

## 3. Release (preferred — automated)

From the project root run:

```bash
npm run release -- patch     # or minor, major, or an explicit version like 0.1.2
```

`scripts/release.mjs` will:

1. Verify all five version sources are in sync.
2. Verify the working tree is clean.
3. Bump the version in all five files (regex-preserving formatting).
4. Commit as `chore: release v<NEW_VERSION>`.
5. Create and push tag `v<NEW_VERSION>`.
6. Push `main` and the tag to `origin`.

Preview without side effects:

```bash
npm run release -- patch --dry-run
```

## 4. Manual fallback (only if automation is unavailable)

1. Bump the version in all five files listed in step 2.3 (must match exactly).
2. Stage and commit with the exact message format:

   ```bash
   git add .
   git commit -m "chore: release vX.Y.Z"
   ```

3. Tag and push — the tag **must** be `vX.Y.Z` (lowercase `v`, no prefix/suffix) to trigger CI:

   ```bash
   git tag vX.Y.Z
   git push origin main
   git push origin vX.Y.Z
   ```

## 5. Verify after push

1. GitHub Actions (`.github/workflows/build.yml`) triggers on tags matching `v*`.
2. Confirm a run started in the repo's **Actions** tab and that all matrix jobs pass
   (macOS x64, macOS aarch64, Linux x64, Windows x64).
3. Each runner:
   - Installs frontend deps (`npm ci`),
   - fetches the platform FFmpeg sidecar,
   - runs `tauri-action@v0` with `permissions: contents: write` and explicit release
     metadata (`releaseName`, `releaseBody`, `releaseDraft: false`, `prerelease: false`)
     so it can create the release.
4. On a tag push, `tauri-action` creates a GitHub Release `vX.Y.Z` with updater artifacts
   (`.sig` signatures + `latest.json`), so the app's auto-updater offers the new version.

> **Note:** the workflow is configured to create releases *only* on tag pushes matching `v*`
> (plain pushes to `main` skip release creation). If you need to re-run a failed release,
> delete/retry the run or push the tag again.

## AI agent rules (non-negotiable)

- NEVER hardcode or guess a version — always read `package.json` first.
- NEVER bump a version in only some files — all five must be synced.
- NEVER use a tag that is not exactly `vX.Y.Z`.
- NEVER use a commit message that is not exactly `chore: release vX.Y.Z`.
- NEVER run a release on a dirty tree.
- NEVER release automatically when asked to fix a bug — only release when asked.