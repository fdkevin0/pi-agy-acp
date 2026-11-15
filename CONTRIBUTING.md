# Contributing

Bug reports, documentation improvements, and focused pull requests are welcome.
For larger changes, open an issue first to agree on the problem and scope.

## Development

Follow the [development guide](docs/development.md) for setup and architecture.
Before opening a pull request, run:

```sh
npm run check
npm test
npm pack --dry-run
```

Tests use a local scripted CLI; real account credentials are not needed.
Add a regression test for behavior changes and update relevant documentation.
Keep documentation in English. Do not include tokens, account details, or private
conversation content in reports, logs, or fixtures.

## Pull requests

Create a branch from `main` and keep each pull request focused on one change.
Explain the problem, resulting behavior, and validation performed.
All changes to `main` go through a pull request with passing CI and resolved
review discussions. A second person's approval is not required for this
single-maintainer project. Pull requests are squash merged.

Report security vulnerabilities using the [security policy](SECURITY.md).
