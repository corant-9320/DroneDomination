# Architecture

This document was split into a cross-linked wiki so agents (and humans) load
only the section relevant to their task. Start at the hub:

➡️ **[docs/architecture/README.md](docs/architecture/README.md)**

## Quick Index

| Topic | Page |
|-------|------|
| Where code lives (module map + import rule) | [modules.md](docs/architecture/modules.md) |
| World gen pipeline, hex segments, pathfinding, constants | [world-generation.md](docs/architecture/world-generation.md) |
| Client↔server data flow + `/api/generate` contract | [data-flow-and-api.md](docs/architecture/data-flow-and-api.md) |
| Build/TS config | [configuration.md](docs/architecture/configuration.md) |
| Headless snapshots + `window.gameDebug` instrumentation | [debugging.md](docs/architecture/debugging.md) |
| Architectural drift / fixed-issue history | [known-issues.md](docs/architecture/known-issues.md) |

Tech stack and a one-line summary of every page live in the
[wiki hub](docs/architecture/README.md).
