# Changelog

## 0.4.0

- Ignore stale project, service and log responses, including polls completing after Clear.
- Verify container ownership and reject ambiguous Compose actions across workspaces sharing a project name.
- Diagnose OOM kills, runtime errors and restart-count changes; add a container diagnostics view.
- Preserve healthy logs when another source fails; show per-source failures and history limits.
- Discover dotenv `COMPOSE_FILE` and allow workspace-specific Compose files and profiles.
- Fetch logs incrementally with nanosecond cursors, bound Docker process concurrency, and reuse unchanged log DOM nodes.
- Add JSON field inspection, correlation-ID filters and repeated error/traceback grouping.
- Include surrounding incident context, fresh diagnostics and Docker target information in Ask agent.
- Display Docker context, copy port addresses and recognize HTTP/HTTPS ports.
- Copy selected log text and resize the services list with pointer or keyboard.
- Add portable strict type checking, DOM/worker regression tests and Linux/macOS CI.
