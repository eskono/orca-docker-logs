# Docker Logs

An Orca sidebar panel for the Docker Compose containers of the focused project: state, CPU and
memory over time, ports, start / stop / restart / rebuild, a shell, and a live log with error
highlighting whose stack traces open the code, and that you can hand to your agent in one click.

**Install:** [onorca.dev/plugins/eskono.docker-logs](https://onorca.dev/plugins/eskono.docker-logs?catalog=community).
It runs its own worker (it calls the `docker` CLI, opens terminals and starts agents), so Orca
asks you to approve full access.

![The panel: services with CPU, memory and ports above the api container's log](assets/screenshot-dark.webp)

## What it does

- **Services from the compose files.** The worker asks `docker compose config` in the workspace
  folder, so Compose picks the files the way it does in a terminal (`compose.yaml` /
  `docker-compose.yml`, their `.override`, `COMPOSE_FILE` from `.env`). Services of every
  profile are listed; one that never ran shows its profile and starts with it.
- **State at a glance.** A dot per container (running, starting, unhealthy, crashed), uptime,
  CPU and memory from `docker stats` with a small chart of the last minutes (line: CPU, dashes:
  memory), and the published ports as links that open `http://localhost:<port>`. Hover a row
  for the last health check output, the memory limit and the CPU and memory range.
- **The project follows Orca's focus.** The picker at the top lists every local workspace with a
  compose file, to look at another one.
- **Actions.** Per container: shell (`docker exec -it … bash`, or `sh`), rebuild
  (`compose up -d --build`), restart, stop, start. For the project: Up, Restart and Down (Down
  asks for a second click). Commands that may build or pull (Up, rebuild, creating a container)
  run in a new Orca terminal tab so you see their output.
- **Logs.** One container or **All services** interleaved by time and tagged by container, with
  ANSI colours. Errors and warnings are highlighted in plain, logfmt and JSON logs, stack traces
  included; the level picker shows only them. Periods: the last 1000 lines, 5 or 15 minutes, an
  hour, or since the container started. Filter, timestamps, wrap, and **Save** to a file.
  Programs that print no colours under Docker still get their level word coloured.
- **Stack traces open the code.** Paths in Python, Node, Go, Ruby and PHP traces that belong to
  the project are links: a click opens the file at that line in Orca's editor. Container paths
  map to the project through the service's bind mounts (`./app:/srv/app`), or, for code copied
  into the image, by the longest part of the path that exists in the project; library frames
  stay plain text. Web addresses in the log are links too.
- **Ask agent** starts the agent set in Settings (Claude by default) in the project's workspace
  with the lines you are looking at, and asks it to find the cause.
- **Clear** hides what was logged so far (it remembers the time and asks `docker logs --since`);
  Docker's log is not touched, so **Show all** brings it back.
- **Status bar.** `running/total` for the focused project, red when a container crashed, keeps
  restarting or turns unhealthy, with a desktop notification when that happens (Settings can turn
  notifications off).

## Settings

| Setting                       | Default  | What it does                                               |
| ----------------------------- | -------- | ---------------------------------------------------------- |
| Docker CLI path               | (empty)  | Where `docker` is, when it is not found on its own         |
| Agent for “Ask agent”         | `claude` | Agent Orca starts with the log, such as `codex`            |
| Notify when a container fails | on       | Desktop notifications from the status bar watcher          |

## Notes

- **Docker binary.** Orca opened from the Dock gives plugins a short `PATH`, so the worker also
  looks in `/usr/local/bin`, `/opt/homebrew/bin`, Docker Desktop, OrbStack and Rancher Desktop.
- **The `orca` CLI.** Orca's plugin API gives the focused workspace's name and branch, not its
  folder, opens terminals in the background and opens files without a line. The worker uses the
  `orca` CLI for those: `terminal list` to tell apart workspaces that share a name and branch,
  `terminal switch` to show the terminals it opens, and `file open --line` for stack traces.
- **Local only.** Docker runs on this machine, so workspaces on SSH hosts are not listed.
- **Safety.** The worker acts only in folders Orca lists as local workspaces, checks every
  service name, container id and time it receives, never runs a shell for its own commands, and
  quotes what it types into terminals. Log text is rendered as text.

## Layout

| File                 | What it does                                                               |
| -------------------- | -------------------------------------------------------------------------- |
| `orca-plugin.json`   | Manifest: panel, worker, status bar item, settings, capabilities, images   |
| `src/worker.ts`      | Worker: panel requests, terminals, agent, status bar and notifications     |
| `src/docker.ts`      | Finds and runs docker; parses `compose config`, `inspect`, `stats`, logs   |
| `src/status.ts`      | Status bar summary and which container problems notify                     |
| `src/sources.ts`     | Which project file a stack trace path in a container is                    |
| `src/orca-cli.ts`    | The `orca` CLI calls: terminal lookup and switch, opening a file at a line |
| `src/workspaces.ts`  | Local workspaces with compose files; which one is focused                  |
| `src/protocol.ts`    | Request and answer types shared by the panel and the worker                |
| `panel/index.html`   | Panel markup and styles (Orca theme variables)                             |
| `panel/main.ts`      | Panel logic: project, containers, actions, logs                            |
| `panel/levels.ts`    | Error and warning detection, level words to colour                         |
| `panel/links.ts`     | Web addresses and stack trace locations in log lines                       |
| `panel/sparkline.ts` | `docker stats` numbers and chart points                                    |
| `panel/ansi.ts`      | ANSI colour codes to styled segments                                       |
| `panel/icons.ts`     | The panel's icons                                                          |

## Develop

```sh
orca plugin validate . --json
orca plugin test . --json          # parsers, levels, links, sources, worker over a fake docker and CLI
orca plugin dev watch . --json     # load into Orca (asks for approval), stream logs and reloads
```

`.orca/types` cannot be generated by Orca 1.4.249 (its bundle lacks `orca.d.ts`), so `npx tsc -p .`
has no Orca typings yet; the panel declares the few `orca` calls it uses itself.
