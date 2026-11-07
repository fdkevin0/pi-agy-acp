# pi-agy-acp

Use Google Antigravity in Pi through the official, locally installed `agy` CLI.
This extension registers the `antigravity-acp` provider and lets Pi execute the
model's tool calls. It supports streaming text and reasoning, images, and
parallel tool calls.

## Prerequisites

- Node.js >= 22.18.0.
- Pi (`@earendil-works/pi-coding-agent`) 1.5.x.
- The official `agy` CLI >= 1.4.12, signed in with your Google account.
  Run `agy` in your terminal to complete sign-in before using the extension.

## Install

From GitHub (recommended):

```sh
pi install git:github.com/fdkevin0/pi-agy-acp
```

From npm:

```sh
pi install npm:pi-agy-acp
```

To install only for the current project, writing to `.pi/settings.json`:

```sh
pi install -l git:github.com/fdkevin0/pi-agy-acp
```

To try it for one invocation without saving an installation to settings:

```sh
pi -e git:github.com/fdkevin0/pi-agy-acp
```

To install a local clone for development:

```sh
git clone https://github.com/fdkevin0/pi-agy-acp.git
pi install ./pi-agy-acp
```

See [development setup](docs/development.md) for dependencies and local testing.

## Usage

Start `pi`, then use `/model` to select a model under `antigravity-acp`.
Examples include `gemini-4-argon`, `gemini-3.8-flash`, `claude-opus-5-5`,
`claude-sonnet-5-5`, and `gpt-oss-120b-medium`. The available list refreshes
automatically from your account.

| Command | Purpose |
| --- | --- |
| `/agy-acp` or `/agy-acp status` | Show runtime state, account details, models, sessions, and the last turn. |
| `/agy-acp quota` | Show a loading animation in the TUI, then account email, subscription plan, grouped 5h/weekly quota bars, and reset countdowns when available. |
| `/agy-acp reset` | Close ACP sessions; the next request rebuilds the connection. |

Update installed extensions:

```sh
pi update --extensions
```

Remove a GitHub installation:

```sh
pi remove git:github.com/fdkevin0/pi-agy-acp
```

For an npm installation, use `pi remove npm:pi-agy-acp`. Add `-l` when removing
a project-local installation.

Default prices are zero, not a promise of free calls. Pi pricing overrides are
used when configured.

## More information

- [Reference](docs/reference.md): commands, configuration, stored data, model discovery, and limitations.
- [Development](docs/development.md): setup, request flow, source layout, and verification.
- [Attribution](NOTICE) and [MIT license](LICENSE).
