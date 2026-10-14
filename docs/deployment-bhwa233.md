# renewlet.bhwa233.com

This fork runs Renewlet on Cloudflare Workers at https://renewlet.bhwa233.com.

## Resources

| Resource | Name |
| --- | --- |
| Worker | `renewlet` |
| D1 database | `renewlet` |
| R2 bucket | `renewlet-assets` |
| Icon refresh queue | `renewlet-media-icon-index-refresh` |
| Dead-letter queue | `renewlet-media-icon-index-refresh-dlq` |

`wrangler.jsonc` records this instance's account, database binding and custom domain. Workers.dev and preview URLs are disabled so the application has one public origin. API credentials and application passwords must never be committed.

## Update from a local checkout

Use the Node.js and pnpm versions specified in `package.json`, plus Go's `gofmt` from the toolchain documented in `CONTRIBUTING.md`. Run these commands in Linux, macOS or WSL after reviewing and merging upstream changes:

```bash
pnpm install --frozen-lockfile
pnpm exec wrangler login
pnpm exec wrangler whoami
pnpm check:cloudflare
pnpm build:cloudflare
pnpm deploy
```

The deployment orchestrator uses the D1 REST API as well as Wrangler. For those operations, provide a suitably scoped `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` in the shell environment. Keep the token out of command history and Git. An authenticated local deployment can use its current Wrangler OAuth credential for that run; do not store a short-lived OAuth credential as a GitHub Actions secret.

Use Renewlet's deployment orchestrator rather than deploying directly with Wrangler: it applies migrations, verifies database invariants and handles upgrades that require maintenance mode.

Back up the database and application data before upgrades. Keep this instance's custom domain and resource bindings when resolving upstream configuration changes. For Cloudflare migration recovery, follow [the upstream deployment guide](cloudflare-workers-deploy.zh-CN.md).

## Automatic upstream sync and Cloudflare deployment

This instance uses Cloudflare's Git integration to deploy updates to `main`.
The fork-specific **Auto Sync Upstream** workflow in `.github/workflows/fork-sync.yml`
checks `zhiyingzzhou/renewlet:main` every day at **04:17 Asia/Shanghai** (20:17 UTC).
It can also be started from GitHub Actions with **Run workflow** on `main`.

The workflow merges upstream history, verifies that the custom domain, account,
Worker name, D1/R2 bindings, queue names, observability settings, existing variables
and this deployment document are preserved, then runs deployment script tests,
Cloudflare checks and the Cloudflare build. Only a verified candidate is pushed.
Upstream workflow changes are merged as well; the fork's added workflow is retained.
No upstream updates means no commit, push or deployment. Conflicts and failed checks
stop the workflow without pushing. If `main` changes during validation, publication
stops and a fresh run is needed. Force pushes and automatic conflict resolution are
not used.

The repository-specific write deploy key **Renewlet upstream auto-sync** and its
Actions secret **UPSTREAM_SYNC_SSH_KEY** authenticate the final Git push. The key
is loaded only after validation and grants access only to this repository.
Cloudflare's existing Git integration handles deployment; this workflow does not
require Cloudflare API credentials or perform D1 migrations itself. GitHub sync
success and Cloudflare deployment success are separate results: inspect the
Cloudflare build/deployment logs for the latter.

Select **dry_run** when running manually to validate a merge (or the current `main`
when already up to date) without pushing or triggering deployment. GitHub scheduled
runs may be delayed, and public-repository schedules can be disabled after 60 days
without repository activity. Check the workflow's enabled state if it stops running.

The inherited **Sync Renewlet Upstream** workflow targets Deploy Button-generated
repositories by replacing their file tree. **Do not run it for this fork**: its
configuration preservation does not cover this instance's custom domain and all
deployment settings. Use **Auto Sync Upstream** instead.

The inherited GitHub Actions deployment workflow is an optional alternative that
requires the five secrets listed in the upstream guide. This instance's Cloudflare
Git integration does not require those Actions secrets.

## Initial use

The first administrator is initialized through `/setup`. Once an enabled administrator exists, the server rejects further first-administrator creation requests. Set the user timezone to `Asia/Shanghai`, then configure and test a notification channel in Settings. Deploying the application does not configure email, chat bots or AI providers automatically.
