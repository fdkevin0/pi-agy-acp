# Changelog

## [0.2.0](https://github.com/fdkevin0/pi-agy-acp/compare/pi-agy-acp-v0.1.3...pi-agy-acp-v0.2.0) (2026-11-14)


### Features

* default quota display to used and remember mode selection ([#17](https://github.com/fdkevin0/pi-agy-acp/issues/17)) ([8f74297](https://github.com/fdkevin0/pi-agy-acp/commit/8f74297e21abfdc15cecadeb51f5f734effbeb1d))
* initial release of pi-agy-acp ([2fd8cba](https://github.com/fdkevin0/pi-agy-acp/commit/2fd8cbaa6e0638190bcc6f4fc7ffc30500b69842))


### Bug Fixes

* Batch 2 execution correctness ([#6](https://github.com/fdkevin0/pi-agy-acp/issues/6), [#7](https://github.com/fdkevin0/pi-agy-acp/issues/7), [#8](https://github.com/fdkevin0/pi-agy-acp/issues/8)) ([#18](https://github.com/fdkevin0/pi-agy-acp/issues/18)) ([d64a548](https://github.com/fdkevin0/pi-agy-acp/commit/d64a548c1d45abcd57440578328afaea17fb0684))
* harden MCP HTTP boundary, runtime disposal, and turn ownership ([#3](https://github.com/fdkevin0/pi-agy-acp/issues/3), [#4](https://github.com/fdkevin0/pi-agy-acp/issues/4), [#5](https://github.com/fdkevin0/pi-agy-acp/issues/5)) ([#11](https://github.com/fdkevin0/pi-agy-acp/issues/11)) ([dedeeb7](https://github.com/fdkevin0/pi-agy-acp/commit/dedeeb788d34cb0433b7717b67ee876dcf138409))


### Performance Improvements

* deduplicate warmup sessions and clean closed ACP session artifacts ([54893a7](https://github.com/fdkevin0/pi-agy-acp/commit/54893a733392d5347846046c56f43acaa01202c3))

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
