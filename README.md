# qits-workspaces-frontend

The workspaces UI: the agents working on a project's tickets and epics, and the workspaces they run
in. Served by qits-workspaces itself at the root of its own host (`workspaces.<env>.<domain>/`)
through Quinoa; it ships no image.

Since epic qits-1152 a **workspace** is a slot on a runner: one container, scoped to a project's
wrapper, holding one long-lived clone. An **agent** works on one ticket or epic in its own worktree
inside a workspace. A workspace hosts many agents and runs one at a time; the service makes and
removes workspaces as agents need them.

- **`/`** — a wrapper's agents and workspaces, and the **New agent** form: a ticket or epic (by
  qualified id such as `qits-617`, or UUID), the harness, an optional first instruction and the
  docker-socket (admin) checkbox. The form reads the item from qits-projects and refuses anything
  that is not a ticket or an epic of the wrapper's project, then posts `POST /workspaces/api/agents`
  and opens the agent. There is no free-goal workspace any more (D24).
- **`/repositories/{repositoryId}/workspaces/{id}`** — one workspace: runner, placement, container
  and daemon (Start, Stop, Recreate), admin, the start process while one runs, and its agents with
  state, run state, activity, work item and branches. A workspace that has resolved shows its
  history record and archived agent sessions.
- **`/agents/{agentId}?tab=chat|files|terminal`** — one agent: its work item (linked into
  qits-projects), state, run state, activity, open waits ("Waiting on …", qits-1153, shown when the
  service has them), branches, the worktree's dirty and unpushed flags, and **Discard**. Three tabs;
  with no `?tab`, Terminal, unless the agent's harness is a chat:
  - **Chat** — attaches to the agent's harness command when it is a running chat. An agent in a
    terminal (the default) shows its transcript here, read-only, from
    `GET …/commands/{id}/log?channel=TRANSCRIPT`, read again every 3 s while it runs. Otherwise, and beside that
    transcript, the prompt panel sends the turn through
    `POST /workspaces/api/agent-dispatches/delivery`, which resumes a yielded agent to hear it.
    The prompt draft is the agent's (`/workspaces/api/agents/{id}/prompt-draft`).
  - **Files** — the agent's worktree (`…/agent-worktrees/{agentId}/files`, `/files/content`,
    `/detection`).
  - **Terminal** — the agent's harness and its live screen when it runs interactive (the default),
    the sign-in terminal when nobody has signed the harness in (read from `GET /agents/available` →
    `capabilities`), and the plugin store.
- **`/runners`** — the workspace runners.

Every page also answers under a **scoped** address — `/<projectSlug>/<group>/<repoName>/…` — the
platform-wide URL grammar every SPA here shares. `agents` and `runners` are this app's own first
segments, so no project may be called either.

**Removed with qits-1152:** the Actions tab and the bootstrap chain (D19), the editor page (D11, epic
qits-1150), Integrate and the merge panel, the workspace discard, and the ad-hoc create form.

## What the browser may do

The service owns every agent start, yield, resume and cleanup; it holds each agent's credential.
The browser reads, creates an agent for a work item, sends a turn, discards an agent, and drives a
workspace's container. It never calls the daemon's `POST /agent-worktrees`, `/yield`, `/turn` or
`DELETE`.

**Discard** is plain first. A `409` with `AGENT_HAS_LEFTOVER_WORK` (uncommitted or unpushed work) or
`AGENT_DAEMON_UNREACHABLE` is shown with what it would lose, and only a second, explicit press sends
`{force: true}`.

## Live updates

The workspace page and the agent page each open the workspace's hint channel
(`GET /workspaces/api/workspaces/{id}/events`). It carries payload-free topic names (`agents`,
`agent-activity`, `commands`, `files`, `process`, `prompt-draft`, …); each panel re-reads its own
REST door when its topic ticks. Every connect and reconnect invalidates everything once. A queued
agent has no workspace and so no channel; its page re-reads the agent every 10 seconds until it is
placed.

**The browser talks to the in-container daemon directly**, through the verbatim proxy at
`/workspaces/container/{id}/*`. The proxy rewrites no path and sets the daemon's bearer itself, and
the SPA is same-origin with it. Every per-agent read is below `/agent-worktrees/{agentId}`; the
command list and the chat and terminal sockets (`/chat|terminal/commands/{id}`) need no agent,
because command ids are unique across a workspace's agents. The agent's own command id comes from
`GET /agent-worktrees/{agentId}`.

**Hidden tabs stay mounted**, so a chat socket, a terminal, an open file and every scroll position
survive a tab switch. **The tab is a query parameter** (`?tab=`), so an agent switch remounts the
page and every tab is a link.

`src/app/api/` holds hand-written interfaces mirroring the two services' wire shapes, one injectable
service each, over `HttpClient` on the fetch backend. Nothing is generated, and nothing is shared
with qits-ci-frontend or qits-spa-cd: the duplication is the deliberate alternative to putting transport
into a components library that seven SPAs consume without making a request.

This project was generated using [Angular CLI](https://github.com/angular/angular-cli) version 21.2.19.

## Development server

To start a local development server, run:

```bash
ng serve
```

Once the server is running, open your browser and navigate to `http://localhost:4200/`. The application will automatically reload whenever you modify any of the source files.

`proxy.conf.json` forwards `/workspaces/api` and `/projects/api` to a gateway on `localhost:8080`,
because `ng serve` puts no gateway in front and the screen reads across two services. In a
deployment every call is a same-origin path behind the real gateway, which is what carries the
session cookie.

## Code scaffolding

Angular CLI includes powerful code scaffolding tools. To generate a new component, run:

```bash
ng generate component component-name
```

For a complete list of available schematics (such as `components`, `directives`, or `pipes`), run:

```bash
ng generate --help
```

## Building

To build the project run:

```bash
ng build
```

This will compile your project and store the build artifacts in the `dist/` directory. By default, the production build optimizes your application for performance and speed.

## Running unit tests

To execute unit tests with the [Vitest](https://vitest.dev/) test runner, use the following command:

```bash
ng test
```

## Running end-to-end tests

For end-to-end (e2e) testing, run:

```bash
ng e2e
```

Angular CLI does not come with an end-to-end testing framework by default. You can choose one that suits your needs.

## Additional Resources

For more information on using the Angular CLI, including detailed command references, visit the [Angular CLI Overview and Command Reference](https://angular.dev/tools/cli) page.

Integrated by the release flow (AC live proof, 2026-07-31T21:32:31Z).
