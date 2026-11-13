# pi-agy-acp

[![CI](https://github.com/fdkevin0/pi-agy-acp/actions/workflows/ci.yml/badge.svg)](https://github.com/fdkevin0/pi-agy-acp/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/pi-agy-acp)](https://www.npmjs.com/package/pi-agy-acp)

Use Google Antigravity in Pi through the official, locally installed `agy` CLI.
This extension registers the `antigravity-acp` provider and lets Pi execute the
model's tool calls. It supports streaming text and reasoning, images, and
parallel tool calls.

## Prerequisites

- Node.js >= 22.19.0.
- Pi (`@earendil-works/pi-coding-agent`) 1.5.x.
- The official `agy` CLI >= 1.4.12, signed in with your Google account.
  Run `agy` in your terminal to complete sign-in before using the extension.

## Install

Install from GitHub (recommended) or npm:

```sh
pi install git:github.com/fdkevin0/pi-agy-acp
# Or:
pi install npm:pi-agy-acp
```

Add `-l` to install only for the current project (`.pi/settings.json`). To try,
update, or remove the extension:

```sh
pi -e git:github.com/fdkevin0/pi-agy-acp
pi update --extensions
pi remove git:github.com/fdkevin0/pi-agy-acp
```

For npm, remove `npm:pi-agy-acp` instead. Add `-l` when removing a project-local
installation. See [development setup](docs/development.md) for local testing.

## Usage

Start `pi`, then use `/model` to select a model under `antigravity-acp`.
Examples include `gemini-4-argon`, `gemini-3.8-flash`, `claude-opus-5-5`,
`claude-sonnet-5-5`, and `gpt-oss-120b-medium`. The available list refreshes
automatically from your account.

| Command | Purpose |
| --- | --- |
| `/agy-acp` or `/agy-acp status` | Show runtime state, account details, models, sessions, and the last turn. |
| `/agy-acp quota` | Show account details, grouped quota bars, and reset countdowns. |
| `/agy-acp reset` | Close ACP sessions; the next request rebuilds the connection. |

After an Antigravity turn settles, the status bar shows remaining quota (for example,
`AGY 80%`) and warns when quota is low; see [quota status](docs/reference.md#quota-status-and-warnings).

Default prices are zero, not a promise of free calls. Pi pricing overrides are
used when configured.

## More information

- [Reference](docs/reference.md): commands, configuration, stored data, model discovery, and limitations.
- [Development](docs/development.md): setup, request flow, source layout, and verification.
- [Changelog](CHANGELOG.md): release history and upcoming changes.
- [Attribution](NOTICE) and [MIT license](LICENSE).

For contributions, see [CONTRIBUTING.md](https://github.com/fdkevin0/pi-agy-acp/blob/main/CONTRIBUTING.md). Report vulnerabilities through the [security policy](https://github.com/fdkevin0/pi-agy-acp/blob/main/SECURITY.md).
