# GitHub Release Distribution Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Publish Relay as self-contained, versioned GitHub Release archives so users can install it without npm or a preinstalled Node runtime.

**Architecture:** A release workflow builds Relay, installs production dependencies, copies a platform-matched Node runtime into each archive, and emits SHA-256 checksums. A small launcher resolves its bundled Node executable and runs Relay's CLI. GitHub Actions uploads the archives and checksum file to a `v0.4.0-beta.1` prerelease after a manually selected release tag passes tests.

**Tech Stack:** Node 20, TypeScript, GitHub Actions, Bash, GitHub Releases, SHA-256.

---

### Task 1: Add a release bundle contract test

**Files:**
- Create: `scripts/release-bundle.test.mjs`
- Create: `scripts/release-bundle.mjs`

**Step 1: Write the failing test**

Assert that a generated dry-run manifest names the expected platform archives, includes the Relay launcher, Node runtime, `dist/`, production dependencies, and checksums.

**Step 2: Run the test to verify it fails**

Run: `node --test scripts/release-bundle.test.mjs`

Expected: FAIL because the bundle script does not exist.

**Step 3: Implement the minimal bundle script**

Create a script that receives a platform and architecture, prepares a staging directory, writes the launcher and manifest, and supports a dry-run manifest mode for test coverage.

**Step 4: Run the test to verify it passes**

Run: `node --test scripts/release-bundle.test.mjs`

Expected: PASS.

**Step 5: Commit**

```bash
git add scripts/release-bundle.mjs scripts/release-bundle.test.mjs
git commit -m "feat(release): add portable bundle builder"
```

### Task 2: Build archives and checksums in CI

**Files:**
- Create: `.github/workflows/release.yml`
- Modify: `package.json`

**Step 1: Write the failing workflow contract test**

Extend `scripts/release-bundle.test.mjs` to assert that the release workflow has a manual tag input, macOS arm64, macOS x64, and Linux x64 build targets, checksum generation, and prerelease publication.

**Step 2: Run the test to verify it fails**

Run: `node --test scripts/release-bundle.test.mjs`

Expected: FAIL because the workflow is absent.

**Step 3: Implement the workflow**

Add a workflow dispatch release workflow. It validates that the tag equals `package.json` version, builds on each target runner, uploads artifacts, generates a checksum manifest, and creates a prerelease through the GitHub CLI action.

**Step 4: Run the test to verify it passes**

Run: `node --test scripts/release-bundle.test.mjs`

Expected: PASS.

**Step 5: Commit**

```bash
git add .github/workflows/release.yml package.json scripts/release-bundle.test.mjs
git commit -m "feat(release): publish GitHub release bundles"
```

### Task 3: Set the release version and document installation

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `README.md`
- Modify: `docs/install.md`
- Modify: `docs/quickstart.md`
- Modify: `docs/troubleshooting.md`
- Modify: `CHANGELOG.md`

**Step 1: Write a failing documentation contract test**

Assert that public install documentation names `v0.4.0-beta.1`, links to the tag release, gives a checksum verification command, and does not recommend npm or use an em dash.

**Step 2: Run the test to verify it fails**

Run: `node --test scripts/release-bundle.test.mjs`

Expected: FAIL because the release version, concrete commands, and artifact name are missing.

**Step 3: Implement the version and docs**

Set `package.json` and lockfile to `0.4.0-beta.1`. Document direct archive download, SHA-256 verification, extraction, PATH setup, `relay setup --everything`, and upgrade steps. Use plain, specific language without em dashes.

**Step 4: Run tests to verify they pass**

Run: `node --test scripts/release-bundle.test.mjs && npm run build && RELAY_ALLOWED_ROOTS= npm test`

Expected: PASS.

**Step 5: Commit**

```bash
git add package.json package-lock.json README.md docs/install.md docs/quickstart.md docs/troubleshooting.md CHANGELOG.md scripts/release-bundle.test.mjs
git commit -m "docs(release): document v0.4.0-beta.1 installation"
```

### Task 4: Publish the prerelease

**Files:**
- No local source changes.

**Step 1: Create and push the version tag**

Run: `git tag v0.4.0-beta.1 && git push origin v0.4.0-beta.1`

**Step 2: Dispatch the release workflow**

Run: `gh workflow run release.yml --ref main -f tag=v0.4.0-beta.1`

**Step 3: Verify the published release**

Run: `gh release view v0.4.0-beta.1 --repo ghanavati/relay`

Expected: prerelease is published with three archives and `SHA256SUMS.txt`.
