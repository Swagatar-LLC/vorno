# Web UI — Bind Address (Remote Access)

The desktop app can serve its browser-based Web UI from an embedded HTTP listener,
supervised independently of the [HTTP trigger server](./http-trigger-server.md).
This document covers the listener's **bind address** (`webui.host`): what it does,
the two options exposed in settings, the security caveat, and the advanced
hand-edit pattern for binding to a specific network interface.

The Web UI listener is configured under **Settings → Remote Access → Web UI**. Its
config is persisted in `~/.craft-agent/server-config.json` under the `webui` block,
separate from the trigger server's own `host`/`port`.

## What `webui.host` does

`webui.host` is the address the Web UI HTTP listener binds to. It controls which
network interfaces can reach the Web UI:

- `127.0.0.1` — loopback only. The Web UI is reachable **only from this machine**.
  This is the default.
- `0.0.0.0` — all interfaces. The Web UI is reachable from **any device on your
  local network** (subject to the login password and your firewall).

Changing the host requires a **restart of the Web UI listener** to rebind. The
settings page shows a "restart to apply" note after a change while the listener is
running; the change is persisted immediately but does not take effect until you
stop and start the Web UI (or relaunch the app).

## Settings options

The **Host** dropdown offers two managed values:

| Option | Value | Reach |
|--------|-------|-------|
| `127.0.0.1 (localhost only)` | `127.0.0.1` | This machine only |
| `0.0.0.0 (all interfaces)` | `0.0.0.0` | Whole local network |

Selecting `0.0.0.0` surfaces an amber warning:

> Warning: Binding to 0.0.0.0 exposes the app to your local network.

This is the same warning the trigger server host dropdown uses. Even bound to
`0.0.0.0`, the "open in browser" URL stays `http://127.0.0.1:<port>` because the
local machine always reaches the listener on loopback — this avoids leaking an
interface IP into a clickable link.

## Security caveat

Binding to `0.0.0.0` makes the Web UI reachable by any device that can route to
this machine. Access is still gated by the generated login password, but you are
now depending on:

- the strength/secrecy of the login password (regenerate it from settings if in
  doubt), and
- your network's trust boundary (a shared office/coffee-shop LAN is not trusted).

Prefer `127.0.0.1` unless you specifically need remote browser access, and only
bind to a broader interface on a network you control.

## Advanced: binding to a specific interface IP

Binding to a single interface IP (rather than all interfaces) is **not exposed in
the UI** — it is an advanced, hand-edit pattern. Edit
`~/.craft-agent/server-config.json` and set the `webui.host` value to the desired
interface address, for example:

```json
{
  "webui": {
    "enabled": true,
    "port": 3848,
    "host": "192.168.1.5",
    "password": "…"
  }
}
```

Then **restart the app** (or stop/start the Web UI) so the listener rebinds.

Because a hand-edited IP is neither `127.0.0.1` nor `0.0.0.0`, the settings Host
dropdown renders it as an additional **custom** option (e.g. `192.168.1.5
(custom)`) so the UI reflects the on-disk value truthfully and never silently
clobbers it. Selecting one of the two managed options replaces the custom value;
the custom entry exists only to mirror disk state.

The same security caveat applies: any device that can route to that interface can
reach the Web UI, subject to the login password and your firewall.
