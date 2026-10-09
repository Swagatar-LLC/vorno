# Pending release notes

This file collects entries for the next Vorno release. Versioned files belong to the release workflow.

## Features

## Improvements

- Large tool results can retain the parts relevant to the agent's stated purpose instead of summarizing them. This optional decision-layer feature sends the full oversized result in parts, plus the agent's purpose, to the configured decision provider. Previously it sent at most the first 3,000 characters. The saved result file remains available. (from upstream v0.14.1)
- Source tool calls include a one-line purpose for the large-result filter. (from upstream v0.14.1)
- Optional adaptive thinking also considers up to 1,200 characters of the last assistant reply and attachment names, types and sizes, but not attachment contents. This context goes to the configured decision provider when enabled. (from upstream v0.14.1)
- Decision model settings show seven-day usage and failure counts by feature. (from upstream v0.14.1)

## Bug fixes

- Guarded mode prompts when its risk check times out, fails or gives an invalid verdict. It no longer runs the unchecked call as Execute. (from upstream v0.14.1)
- A decision check after 30 seconds without a provider answer uses a longer deadline, up to 2.8 seconds. (from upstream v0.14.1)
- Authentication retries reuse the turn's decision checks rather than running them twice. Background-task notices do not change thinking level. (from upstream v0.14.1)
- Long sidebar labels truncate on one line and show the full name on hover. (from upstream v0.14.1)

## Breaking changes
