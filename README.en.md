# dsh-session-timeline

English | [中文](README.md)

A DSH (DeepSeek Harness) plugin that adds a **Session Timeline** tab to the right sidebar, drawing every session in a workspace onto a fishbone timeline — native handoff lineage, manual drag links, and branch fan-outs in one picture. Double-click any node to jump straight to that session.

## Features

| Capability | Description |
|---|---|
| Fishbone timeline | Central horizontal spine with date ticks; session nodes alternate above/below, each on a rib |
| Lineage visualization | Blue solid = handoff chain (single child), purple solid = branch fan-out (parent shows a `⑂N` badge), dashed orange = manual link |
| Manual links | Drag between nodes to record "this session continued from that one"; semantics merge with native lineage |
| Handoff hints | Purple frame = used the handoff skill, no predecessor (awaiting one); gold frame = any handoff invocation, no successor (awaiting one) |
| Detail pane + turn strip | Click a node for details; a strip of turn bars pages through the full conversation with handoff turns highlighted in gold |
| Workspace switch | Header dropdown switches session buckets; "current session workspace" auto-follows; tab shows the live top-level session count |
| One-click jump | Double-click a node (or the detail button) to open that session, across workspaces |

## Installation

Prerequisite: DSH (DeepSeek Harness) installed and running.

Open the DSH **Plugins page → Add plugin**, then use any of:

1. **npm package name** (recommended, once published): `@dsh-external/session-timeline` — see [Distribution](#distribution)
2. **Release tarball** (works today): download the `.tgz` from [GitHub Releases](https://github.com/columforge/dsh-session-timeline/releases), extract it, and enter the extracted directory as a **local path**
3. **Build from source** (developers):

```bash
git clone https://github.com/columforge/dsh-session-timeline.git
cd dsh-session-timeline
npm run build        # needs DSH_CHECKOUT pointing at a DSH source checkout (see below)
```

Then enter this directory as the local path in "Add plugin".

## Usage

### Time semantics

- **Timeline position / axis ticks / node time = last activity time** (`lastAt`)
- **Creation time = time of the first real user message** (shown in the detail pane only); when the two differ, the pane marks "log created" to flag shell sessions opened long before real use

### Canvas interaction

- **Zoom**: the `− N% +` control, top-left (±10% steps, 10%–300%, anchored at the viewport center; click N% to reset to 100%)
- **Wheel**: native browser scrolling (vertical/horizontal); Ctrl+wheel stays the browser zoom — the panel never hijacks it
- **Pan**: drag on empty canvas (grab → grabbing); dragging on a node creates a manual link

### Ordering and direction

- Sort key dropdown: **by creation time (default) / by last activity**
- Direction: **newest-first (default) / oldest-first**; newest-first puts the spine arrow on the left

### Lineage chains

- **Nodes** = top-level sessions of the workspace (`session-` prefix; subagent sessions excluded)
- **Independent sessions** sit on the fishbone layer; **handoff chain descendants** stack outward in lineage depth rows, branch children fan out beside their parent
- Edges use **orthogonal obstacle-avoiding routing** (A* with congestion cost to spread parallel wires) — never diagonal, never through a node box
- **Lineage = native edges ∪ manual edges**: in/out degrees, `⑂N` badges, branch detection, and detail-pane narrative all compute over the merged chain — a native single-child edge also renders as a purple branch once you add a manual successor
- The "handoff" tag means the session **actually invoked the handoff skill** or was seeded from one (no text matching)
- Manual entries carry an inline "unlink" button; changes apply immediately

### Detail pane

- Selected node shows: title, creation/last-activity times, lineage narrative, link list
- **Turn strip**: one bar per turn (first/last turns larger, handoff turns gold); click to read the full turn (user message + assistant reply, each truncated to 4000 chars); wheel on the detail frame = previous/next turn
- A "switch to this session" button jumps straight in

## Data and privacy

- **Read-only** scan of `~/.dsh/sessions/<bucket>/<sessionId>/session.v4.jsonl.zstd` (header, title, first-user-message time, last-event time, handoff invocation details; zstd multi-frame decode with mtime/size caching)
- **The only write**: manual links go to `~/.dsh/session-timeline/<bucket>.json` (isolated per workspace)
- Nothing is uploaded; session storage is never modified

## API (webserver prefix `/session-timeline/api`)

| Endpoint | Description |
|---|---|
| `GET /workspaces` | Workspace list `{ ok, workspaces: [{bucket, cwd, sessions, newest}] }` |
| `GET /list?workspace=<bucket\|__global__>&session=<id>` | Nodes + native edges + manual links |
| `GET /turns?session=<id>&workspace=<bucket>&turn=N` | Turn details (`&turn=N` fetches a single turn) |
| `POST /link` `{workspace?, session?, from, to}` | Create a manual link (direction normalized by creation time, idempotent) |
| `POST /unlink` `{workspace?, session?, from, to}` | Remove a manual link (matched both ways) |

## Development

```bash
npm run build    # tsc host + tsdown client (uses the DSH checkout toolchain)
npm test         # pretest builds, then runs all unit tests
```

- `src/index.ts`: host — bucket scanning + API routes
- `src/parse.ts`: pure session-log parsing (no plugin dependencies)
- `src/geometry/layout.ts`: pure layout (metrics and coordinates)
- `src/geometry/lineage.ts`: pure merged-lineage semantics
- `src/geometry/routing.ts`: pure orthogonal obstacle-avoiding routing
- `src/client/index.ts`: UI — components, dragging, details, rendering
- `test/*.test.mjs`: unit tests (node:test, importing the built `lib/`)

The build borrows tsc/tsdown from a DSH source checkout: `export DSH_CHECKOUT=<dsh source dir>` (build.sh auto-probes `~/dsh-harness` and other common paths).

When touching the A*/layout geometry, read the "three historical pitfalls" comment atop `src/geometry/*.ts` first; verify with `npm test` before browser DOM sampling (SVG path V/H are single-coordinate commands — parsing them as x,y pairs gives false alarms).

## Distribution

- **GitHub Releases**: every version ships an `npm pack` tgz (with the built `lib/`)
- **npm** (planned): all peer dependencies (`@deepseek-ai/dsh-host-webserver` etc.) are on public npm, so direct publishing is viable
- **Plugin market index**: `market-index.json` provides a format-1 market index; once published on npm, add this repo's raw URL in the DSH Discover tab to browse and install

## License

[BSD-3-Clause](LICENSE)
