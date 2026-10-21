# Pending release notes

This file collects entries for the next Vorno release. Versioned files belong to the release workflow.

## Features

- Settings → Remote Access has a new option, "Run API sessions in the desktop app" (off by default). When it is on, a session created through the REST API runs as a normal desktop session in the requested workspace: it appears in the session list labelled with the API key's name and can use the browser tool, the workspace's skills and the sources you enable. The key's permission limit, workspace access and session limit still apply. Permission requests the key's policy does not allow automatically are not approved: the API client can see and deny them (`GET /api/sessions/:id/pending`, `POST /api/sessions/:id/permissions`), only the desktop user can approve them, and unanswered requests are denied after 5 minutes. With the option off, and on the standalone server, API sessions behave as before.

## Improvements

## Bug fixes

- An API key can no longer read, message, abort or delete a session created by another key through `/api/sessions/:id/*`. The list endpoint already filtered by key; the per-session routes now match it, as the documentation described.

## Breaking changes
