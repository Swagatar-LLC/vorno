# Artifact Roots and Storage

Vorno can treat folders of your files as **artifact roots** — places it indexes so
your agents can find, read, and organize documents, notes, and generated work
across a project. This guide explains what a root is, how to add one, and how to
read the storage panel in Settings.

> **Advanced feature, rolling out.** Artifact roots live behind the **Artifacts**
> surface, which is off by default. Turn it on in **Settings → Workspace →
> Artifacts** before the panel described here appears. Most day-to-day work
> doesn't require it — reach for roots when you want Vorno to treat a whole folder
> as a searchable, organizable corpus.
>
> The storage-management panel described below (kind badge, capability chips,
> health dot, and the **Add root** menu) is the **planned** shape of this surface
> and is landing incrementally — some elements may not yet appear in your build.
> This guide documents the intended experience so it's ready as the panel ships.

---

## What an artifact root is

An **artifact root** is a named folder Vorno knows how to look inside. Each root
has:

- a short **id** (e.g. `roadmap`, `research`) — how agents refer to it,
- a **kind** — how the files are stored (today: a **Local folder** on your Mac),
- a set of **capabilities** — what Vorno is allowed to do with it, and
- a **health** status — whether Vorno can currently reach it.

Files inside a root get stable addresses, so an agent can link a note to the
document it came from, or hand you back "the three files that mention Henderson"
instead of the whole pile.

### The `workspace` root is always there

You never have to configure anything to get started. Every workspace has one
implicit, zero-config root called **`workspace`**, covering the plans and data
your sessions produce. It's reserved — you can't rename or remove it, and you
don't need to add it. It's simply always present.

### Why add more roots

Add a root when you want Vorno to work across a folder that *isn't* inside the
workspace — a research library, a folder of contracts, a synced project
directory. Adding it as a root is what lets agents index and organize those
files instead of you pointing at them one at a time.

---

## Adding a local-folder root

1. Open **Settings → Workspace → Artifacts**.
2. Under **Artifact roots**, click **Add root**.
3. Choose **Local folder…** from the menu.
4. **Pick the folder first** — Vorno asks you to select the folder, then
   suggests an id you can adjust.
5. Save. The new root appears in the list with its kind, capabilities, and a
   health dot.

That's the whole flow for a local folder: pick the folder, name it, done. (The
**Add root** menu will grow other kinds later — see [Coming later](#coming-later)
— but **Local folder…** is the only option today.)

---

## Reading the storage panel

Each root in the list shows a few at-a-glance indicators:

### Kind badge

A small badge naming how the root is stored. Right now every root is a **Local
folder** (`filesystem`). The badge exists so that when other storage kinds
arrive, you can tell them apart without opening anything.

### Capability chips

Short chips showing what Vorno can do with the root — for example **Read** and
**List**. **Today all roots are read-only**: Vorno indexes and reads your files,
but the artifact plane does not write, delete, or modify them. If you don't see a
**Write** chip, that's expected and intended — your files are safe from
artifact-side changes.

### Health dot

A colored dot for whether Vorno can reach the root right now:

| Dot | Meaning |
|-----|---------|
| 🟢 **OK** | The root is reachable and readable. |
| 🟠 **Missing / Unreadable** | The folder moved, was deleted, or Vorno lacks permission to read it. Fix the path or permissions. |
| 🟠 **Truncated** | The root is very large and Vorno indexed up to its limit — some files past the cap aren't listed (they're still readable if you address them directly). |

Hover the dot for the specific reason.

---

## Your files stay put — and stay yours

Two guarantees worth knowing:

- **Read-only.** The artifact plane reads and indexes; it does not write to,
  delete, or reorganize the files in your roots. Any change to your files comes
  from a tool you explicitly asked to run, never silently from indexing.
- **Paths stay local.** When you access a workspace remotely (for example, the
  WebUI), Vorno shows a remote client the root's id, kind, capabilities, and
  health — **never the absolute folder path** on your machine. Local paths don't
  leave the device that hosts them.

---

## Coming later

- **Object-storage roots** (e.g. cloud buckets) arrive with **hosted
  workspaces**. When they do, the **Add root** menu gains an **Object storage…**
  option, and roots may show additional capabilities.
- **Credentials via the vault.** Any root that needs a secret (like cloud
  credentials) will pull it from Vorno's encrypted vault. You will **never paste
  a secret into a root's configuration** — that path is closed by design.

Until then, **Local folder** is the one kind, and it's read-only.

---

*Feedback on this guide → [open an issue](https://github.com/Swagatar-LLC/craft-agents-oss/issues).*
