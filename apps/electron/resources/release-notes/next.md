# Pending release notes

This file collects entries for the next Vorno release. Versioned files belong to the release workflow.

## Features

- When "Run API sessions in the desktop app" is on, `POST /api/sessions` accepts three optional fields: `name` sets the session's title in the session list, `projectId` puts the session in a project (it inherits the project's working directory), and `llmConnection` pins the session to a connection such as `claude-max`. An unknown project or connection returns 400. The standalone server and the headless pool return 400 for these fields. [#PR](https://github.com/Swagatar-LLC/vorno/pull/PR)

## Improvements

- With "Run API sessions in the desktop app" on, `POST /api/sessions` now returns 400 when `model` is not offered by the session's connection, naming the available models, instead of silently running on the connection's default model. `fast` and `default` are always accepted. [#PR](https://github.com/Swagatar-LLC/vorno/pull/PR)

## Bug fixes

## Breaking changes
