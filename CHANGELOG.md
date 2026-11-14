# Changelog

## 0.8.0

- Detect existing Compose stacks from verified working-directory and config-file labels, including nested configs and custom project names.
- Display their containers and logs immediately without saving or applying settings first; add a detected-stack picker.
- Match profile memberships to the loaded running services, preserving ambiguous multi-profile memberships.
- Keep saved settings and working root configurations authoritative, and require Apply before Compose mutations from a detected draft.
- Retain container visibility when config variables are unresolved, using uninterpolated config metadata where possible.
- Cover automatic detection, workspace isolation, root priority, profile mapping and explicit adoption with regression and real Docker tests.

## 0.7.0

- Select workspace-specific environment files, including files in nested directories.
- Resolve inherited `COMPOSE_PROFILES` through Compose and distinguish automatic, manual and base-only selections.
- Refresh inherited profile choices after dotenv changes while preserving unsaved edits.
- Show effective project-command profiles separately from observed running services and services outside the selection.
- Use the same files, environment and profile set for Up, Restart and Down; pin project identity and mirror Compose exports in terminal actions.
- Preserve native `.env` interpolation, root configs and automatic root overrides; keep application environment values out of profile metadata.
- Verify root/nested dotenv compatibility, inactive-profile isolation and terminal environment consistency against real Docker.

## 0.6.0

- Discover Compose configs in nested project folders, including `.docker` and custom YAML filenames.
- List projects whose configs live only in nested folders.
- Select ordered base/override files and preview/select their Compose profiles before applying settings.
- Preserve manual paths, workspace-specific settings, dotenv behavior and Compose's relative path resolution.
- Cover nested discovery, profile previews, selection races and ordered launch commands with regression tests and a real Docker check.

## 0.5.0

- Search loaded logs without filtering context; highlight matches across ANSI/link spans and navigate with keyboard shortcuts.
- Show progress, recent output and confirmed exit status for Compose/container actions, with terminal access and persisted history.
- Collapse multiline stack traces, highlight project frames, dim known library frames and navigate between error records.
- Record bounded container event timelines across rebuilds and worker reloads; reconnect event streams and jump to logs around an event.
- Combine any selection of services, including replicas, and save workspace-specific views with filters, periods and display settings.
- Add the `terminal:read` capability to monitor only terminals created for tracked Docker operations.
- Cover the new flows with unit, DOM and worker tests plus real Docker integration checks.

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
