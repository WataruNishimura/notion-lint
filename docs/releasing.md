# Releasing notion-lint

Releases are published to npm by [`.github/workflows/release.yml`](../.github/workflows/release.yml)
when a tag `v<version>` is pushed. Publishing needs the maintainer's npm account, so it is not done
from a pull request or by an agent.

## One-time setup

1. Create an npm account and enable two-factor authentication.
2. Create an access token on npmjs.com (Access Tokens). Use a granular token with read and write
   permission for the `notion-lint` package; for the first release, when the package does not exist
   yet, the token needs permission to publish new packages. Set a short expiry.
3. Add it as the repository secret `NPM_TOKEN` (Settings > Secrets and variables > Actions).
4. Optional: once the package exists, switch to npm trusted publishing (package settings on
   npmjs.com, GitHub Actions, repository `WataruNishimura/notion-lint`, workflow `release.yml`) and
   delete `NPM_TOKEN`. The workflow already has `id-token: write`; with a trusted publisher npm
   needs no token, so remove the `NODE_AUTH_TOKEN` line then.

## Each release

1. Make sure `main` is green and contains everything to release.
2. Update the version in `package.json` (for example `0.1.0`). Use [Semantic Versioning](https://semver.org/).
3. In `CHANGELOG.md`, rename `## Unreleased` to `## <version> - <date>`, and add a new empty
   `## Unreleased` above it. The GitHub release text is copied from the section that starts with the
   tag's version.
4. Commit and merge through a pull request.
5. Check the package locally: `pnpm check`, then `npm pack --dry-run` to see the file list.
6. Tag and push the tag from an up-to-date `main`:

   ```sh
   git switch main && git pull
   git tag v0.1.0
   git push origin v0.1.0
   ```

7. Watch the `Release` run in the Actions tab. It runs `pnpm check` and `pnpm build`, verifies that
   the tag equals `v` plus the `package.json` version, runs `npm publish --provenance --access public`,
   and creates the GitHub release.
8. Check `npm view notion-lint version` and try `npx notion-lint@<version> --version`.

## If something goes wrong

- The tag does not match `package.json`: delete the tag (`git push origin :refs/tags/v0.1.0`,
  `git tag -d v0.1.0`), fix the version, and tag again.
- The publish step fails before anything is uploaded (for example a bad token): fix it, then delete
  and push the tag again, or re-run the failed job.
- A published version can never be replaced. Fix forward with a new patch version; use
  `npm deprecate` for a broken one.
