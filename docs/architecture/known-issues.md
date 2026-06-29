# Known Drift / Issues

[← Architecture Wiki](README.md)

See [`DECISIONS.md`](../../DECISIONS.md) "Known Issues" for the live list. As of
2026-06-10 the open architectural issues are:

- **Movement cost was modelled twice** — FIXED 2026-06-10. Now a single
  segment-step model: `moveUnit` charges the shared `segmentCost`, and the
  distance×terrain code (`segmentMoveCost`, `TERRAIN_MULTIPLIER_*`) is deleted.
  Rotation is a flat once-per-turn `ROTATION_FEE`. (DECISIONS KI-1)
- **Server combat ignores elevation** — FIXED 2026-06-10. `server/combatApi.ts`
  (then named `server/combat.ts`) now carries `elev` through the wire format so
  the elevation multiplier (COMBAT_RULES §13) works on the server path. (DECISIONS KI-2)
- The compact wire format (`TileData`/`UnitData` in `client/worldData.ts`) **was** a
  hand-maintained mirror of `src/world/types.ts`; as of 2026-06-17 this has been
  unified into `shared/wireTypes.ts`. Both sides now import from that single source.
  `TileData` in `client/worldData.ts` extends `WireTile` with a client-only `bridge?`
  flag.
