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

The inherited GitHub Actions deployment workflow requires the five secrets listed in the upstream guide. Those CI credentials are separate from local Wrangler login.

## Initial use

The first administrator is initialized through `/setup`. Once an enabled administrator exists, the server rejects further first-administrator creation requests. Set the user timezone to `Asia/Shanghai`, then configure and test a notification channel in Settings. Deploying the application does not configure email, chat bots or AI providers automatically.
