# Changelog

## [0.1.3]

- Default quota display to `used` across the status bar, quota panel, and warnings, with `/agy-acp quota [used|remaining]` persistence in `settings.json` and `PI_AGY_QUOTA_DISPLAY` startup override.
- Harden MCP HTTP request boundaries, runtime disposal, conversation turn ownership, and tool continuation/cancellation handling.
- Correct the minimum Node.js version to 22.19.0 to match Pi 1.5.x requirements.
- Add contribution and security policies, issue templates, dependency updates, and CI coverage for Node.js 22.19.0 and 24.

## [0.1.2]

- Fix model refresh self-cancellation and support forced or cancelled refreshes.
- Keep ACP running during compaction and tree navigation while clearing conversation sessions.
- Report context overflow and exhausted quota in the format Pi uses for recovery and retry decisions.
- Handle fragmented tool arguments and skip empty system updates.
- Show cached quota in the status bar and check quota after settled Antigravity runs, with deduplicated low-quota warnings.
- Stop automatic prompt-cache warming and keep runtime warnings out of the TUI.
- Report the package version in ACP and MCP handshakes.

## [0.1.1]

- Add CI and release workflows, with tag validation and safe release retries.
- Deduplicate model discovery and clean up temporary ACP session files and rotated logs.

## [0.1.0]

- Add the Antigravity ACP provider for Pi, including streaming, images, and parallel tool calls.
- Discover account models and reasoning levels through ACP.
- Add status and quota panels with account details, remaining-quota bars, and reset countdowns.
