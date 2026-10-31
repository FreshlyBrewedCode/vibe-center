# Releasing

Modelled on Canvas's pipeline. For now a release is a git tag plus a GitHub release; the npm
package (one-command `bunx vibe-center`) is still being designed and plugs in later.

## Workflows

| file | runs on | does |
|---|---|---|
| `.github/workflows/ci.yml` | PRs, pushes to main | `check` (biome, tsc, bun test, web build), `voice` (ruff + pytest via `services/voice/run.sh check`), `e2e` (Playwright, without the voice call) |
| `.github/workflows/pr-title.yml` | PRs | the title must be a Conventional Commit |
| `.github/workflows/release.yml` | pushes to main, manual dispatch | semantic-release (`.releaserc.json`) |

## Versions

PRs are squash-merged with the PR title as the commit message, so the titles decide versions:

- `feat` → minor, `fix`/`perf` → patch, a breaking change (`feat!:` or `BREAKING CHANGE:`) → minor
  while on 0.x. `docs`, `ci`, `chore`, `test`, `refactor`, `build`, `style` release nothing.
- Every releasable merge to main publishes a pre-release `X.Y.Z-next.N` (tag `vX.Y.Z-next.N`,
  GitHub pre-release with notes).
- A stable `X.Y.Z`: Actions → release → Run workflow (on main). It computes the version from the
  last stable tag, not from the pre-releases.
- `v0.1.0` is the floor: history before it never decides a version.

## One-time setup

`scripts/bootstrap-release.sh` (idempotent) sets main as the default branch, squash-only merges
with the PR title as the message, the `release` environment, branch protection requiring the CI
checks and the title check, the `stable` branch `.releaserc.json` needs, and the `v0.1.0` tag. Run
it once the PR adding the workflows has merged, so GitHub knows the check names.
