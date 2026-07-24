/**
 * First-person view tuning constants — world scale, camera limits, model
 * fractions and combat-animation timings.
 *
 * Extracted verbatim from `firstPersonView.ts` so the scene, overlay, effects
 * and input modules can share them without importing the view shell (which
 * would create an import cycle). Values are unchanged.
 */

/**
 * How many hex rings around the unit to render as the visible environment.
 * The 20v20 battle spans ~8 BFS layers seed-to-seed, so this is sized to keep
 * both armies in view from either end of the field.
 */
export const VIEW_RADIUS = 17;

/** Target on-screen radius (world units) for a hex — drives the projection scale. */
export const HEX_WORLD_RADIUS = 6;

/**
 * World-space vertical scale for terrain elevation. The shared elevation height
 * scale (see terrainContext.elevationHeight) runs 0 (flat) → 1 (mountain), so a
 * mountain rises ELEV_WORLD_SCALE world units above flat ground.
 * Vertically exaggerated (~2x real proportion) so mountains read as mountains
 * rather than gentle hills in the perspective view.
 */
export const ELEV_WORLD_SCALE = HEX_WORLD_RADIUS * 4.4;

/** Camera eye height above the ground plane (world units). */
export const EYE_HEIGHT = 2.4;

/** Look sensitivity (radians per pixel of mouse drag). */
export const LOOK_SPEED = 0.005;

/** Pitch clamp so the camera can't flip over the poles. */
export const MAX_PITCH = (85 * Math.PI) / 180;

/** World-space half-extent of the rendered field. */
export const FIELD_EXTENT = HEX_WORLD_RADIUS * VIEW_RADIUS;

/**
 * Max camera altitude / pull-back distance (world units). Lets the eye lift well
 * above the field for a full battlefield overview.
 */
export const BOOM_MAX = FIELD_EXTENT * 3.0;

/**
 * Zoom sensitivity: step = camY * BOOM_STEP_FACTOR, clamped to [BOOM_STEP_MIN, BOOM_STEP_MAX].
 * This gives fine control near the ground and fast travel when high up.
 */
export const BOOM_STEP_FACTOR = 0.12;
export const BOOM_STEP_MIN = 0.15;
export const BOOM_STEP_MAX = BOOM_MAX / 8;

/**
 * Closest the boom zoom will dolly toward a unit's shoulder — small so the
 * camera can come right up to the model without clipping through it.
 */
export const SHOULDER_STANDOFF = HEX_WORLD_RADIUS * 0.05;

/** Hard floor for the camera eye when zooming right up to a unit. */
export const CAM_MIN_HEIGHT = 0.3;

/**
 * Pan distance per pixel of drag, per world unit of altitude. Scaling by height
 * keeps panning slow and precise at ground level yet fast enough to cross the
 * field when zoomed out for an overview.
 */
export const PAN_FACTOR = 0.0016;

/** Hover altitude (world units) for drone models — they float above the terrain. */
export const DRONE_AIR_HEIGHT = HEX_WORLD_RADIUS * 0.5;

/**
 * Forest scenery: how many trees to scatter across each forested hex in view.
 * Trees are static decoration (the 3D echo of the 2D map's forest tree icons),
 * instanced for performance.
 */
export const TREES_PER_HEX = 22;

/** Base tree height as a fraction of a hex radius (canopy tip above ground). */
export const TREE_HEX_FRACTION = 0.15;

/**
 * Unit model footprint as a fraction of a hex radius. Units are deliberately
 * tiny relative to the terrain (a tank is a handful of metres; a hex now reads
 * as a swathe of ground hundreds of metres across, with a formation spread out
 * inside it). Bump this to make units larger.
 */
export const UNIT_HEX_FRACTION = 0.0825;

/**
 * Building model footprint as a fraction of a hex radius. Buildings are large
 * static structures — far bigger than the tiny unit models — so a clustered
 * city reads as a city from across the field. Sized so a full segment's worth
 * of structure sits comfortably inside the hex.
 */
export const BUILDING_HEX_FRACTION = 0.315;

/** Radius (world units) of the selection ring under the player's own unit.
 *  Decoupled from unit size so the (now small) selected unit stays findable. */
export const SELECT_RING_RADIUS = HEX_WORLD_RADIUS * 0.4;

/** Radius (world units) of the faction-colour ring drawn on the ground under
 *  every unit, so the (tiny) models are easy to spot and tell apart by side.
 *  Slightly smaller than the white selection ring so both stay distinct. */
export const FACTION_RING_RADIUS = HEX_WORLD_RADIUS * 0.075;

/** Combat animation timings (ms) — kept in lockstep with the 2D map
 *  (combatAnimations.ts) so first-person and map attacks feel identical. */
export const MISSILE_DURATION = 520;
export const EXPLOSION_DURATION = 680;
/** How many recent missile positions to keep for the glowing contrail. */
export const MISSILE_TRAIL_POINTS = 16;
