# Requirements Document

## Introduction

This feature defines how **buildings** take damage in combat. Unlike units —
which are destroyed when their health reaches zero and removed from the map —
buildings are **indestructible**: an attack can never remove a building from the
world. Instead, attacks degrade the **components** a building has had added on
(its equipment loadout). Each successful attack strips a single point from one
component attribute.

The two damaging weapon modes behave differently:

- **Splash Fire** damages **every** building in the target hex, removing one
  point from a **randomly chosen** component of each.
- **Direct Fire (kinetic)** damages **only** the single targeted building,
  removing one point from a component the **attacking player chooses**.

Anti-Air Fire only targets drones and therefore never damages buildings.

This reverses the prior assumption (recorded in `COMBAT_RULES.md` §12) that
"buildings are removed when destroyed." Under this feature a building is never
removed; a fully degraded building remains on the map as a plain structure with
no components.

### Relationship to existing systems

- Buildings already carry an optional equipment loadout (`attributes`) mirroring
  unit attributes — `kinetic`, `rangeAttack`, `splashAttack`, `antiAir`,
  `armour`, `defence`, `repair` — defined in `src/world/types.ts` /
  `shared/unitTypes.ts`. These are the "added-on components" this feature
  degrades.
- A building's `defence` component projects an anti-drone EW screen
  (`COMBAT_RULES.md` §12). Degrading that component shrinks or removes the
  screen.
- Damage resolution lives in `src/world/combat.ts` (`resolveAttack`,
  `calculateSplashDamage`, weapon-mode selection). Buildings are not currently
  targetable there; this feature adds them as targets.

## Glossary

- **Building** — an immobile, full-segment occupant of a hex identified by
  `(tileIndex, segment)`, owned by a faction. Defined in `src/world/types.ts`.
- **Component** — one equipment attribute on a building whose value is at least
  1. The seven possible components are `kinetic`, `rangeAttack`, `splashAttack`,
  `antiAir`, `armour`, `defence`, and `repair`. A component with value 0 is
  considered absent (not "added on").
- **Component_Value** — the integer point value (0–5) of a single component.
- **Plain_Building** — a building all of whose component values are 0 (no
  equipment).
- **Combat_System** — the authoritative combat resolution code
  (`src/world/combat.ts`) that resolves attacks and applies damage.
- **Direct_Fire** — the kinetic weapon mode (single-target).
- **Splash_Fire** — the area weapon mode that affects all enemy occupants of the
  target hex.
- **Anti_Air_Fire** — the drone-only weapon mode.
- **Successful_Attack** — a resolved attack of a building-damaging weapon mode
  (Direct_Fire or Splash_Fire) that reaches a building as a valid target.
- **Attacking_Player** — the faction (human or AI) that declared the attack.

## Requirements

### Requirement 1: Buildings are indestructible

**User Story:** As a player, I want my buildings to remain on the map no matter
how much they are attacked, so that my city's footprint is permanent and only
its capabilities degrade under fire.

#### Acceptance Criteria

1. THE Combat_System SHALL retain every building in the world model for the
   entire duration of a game session regardless of the number of attacks the
   building has received, and SHALL NOT provide any mechanism that removes,
   destroys, or despawns a building as a result of attack damage.
2. WHEN a building's Component_Value totals are all reduced to 0, THE
   Combat_System SHALL keep the building on the map as a Plain_Building that
   occupies the same map position it held before its components reached 0.
3. WHEN attack damage is applied to a building, THE Combat_System SHALL apply
   that damage only as reductions to one or more Component_Value attributes.
4. THE Combat_System SHALL NOT assign, track, or evaluate any building-level
   health pool, hit-point total, or equivalent aggregate attribute for any
   building.
5. IF an attack would reduce a building's Component_Value below 0, THEN THE
   Combat_System SHALL clamp that Component_Value to a minimum of 0 and SHALL
   discard any damage in excess of the remaining Component_Value.
6. WHILE a building exists as a Plain_Building, THE Combat_System SHALL retain
   it on the map and SHALL keep all of its Component_Value attributes clamped at
   0.

### Requirement 2: Buildings as attack targets

**User Story:** As a player, I want to be able to attack enemy buildings, so
that I can degrade an enemy city's defences and support capabilities.

#### Acceptance Criteria

1. WHEN an Attacking_Player declares Direct_Fire against an enemy building (a
   building owned by a faction other than the Attacking_Player) whose graph
   distance from the attacker is no greater than the attacker's effective attack
   range, THE Combat_System SHALL treat that building as a valid target.
2. WHEN Splash_Fire resolves in a hex that contains one or more enemy buildings
   (buildings owned by a faction other than the Attacking_Player), THE
   Combat_System SHALL include those buildings among the affected occupants.
3. WHERE the only candidate target is an enemy Plain_Building, THE Combat_System
   SHALL treat Direct_Fire against it as valid but having no degrading effect
   (Requirement 6.3).
4. IF an Attacking_Player declares Direct_Fire against a building owned by the
   Attacking_Player, or against a building whose graph distance exceeds the
   attacker's effective attack range, THEN THE Combat_System SHALL reject the
   attack, leave all Component_Values unchanged, and indicate that the target is
   invalid.
5. IF Anti_Air_Fire is declared against a building, THEN THE Combat_System SHALL
   reject the attack, leave all Component_Values unchanged, and indicate that
   buildings cannot be targeted by Anti_Air_Fire.
6. WHEN an Attacking_Player targets an enemy building and the attacker has more
   than one building-damaging weapon mode available (both Direct_Fire and
   Splash_Fire), THE Combat_System SHALL default the auto-selected weapon mode to
   Splash_Fire.

### Requirement 3: Component damage is one point per successful attack

**User Story:** As a player, I want each hit on a building to chip away a single
component point, so that degrading a building is incremental and predictable.

#### Acceptance Criteria

1. WHEN a Successful_Attack reaches a building, THE Combat_System SHALL reduce
   exactly one component whose Component_Value is at least 1 by exactly one
   point, and SHALL leave all other components of that building unchanged.
2. THE Combat_System SHALL reduce a building's component by one point per
   Successful_Attack and SHALL NOT apply the unit health damage formula to
   buildings.
3. THE Combat_System SHALL clamp every Component_Value to the inclusive range of
   0 to that component's original maximum value.
4. IF a building has no component whose Component_Value is at least 1 when a
   Successful_Attack reaches it, THEN THE Combat_System SHALL leave all of that
   building's Component_Values unchanged.
5. THE Combat_System SHALL reduce a building's total Component_Value by at most
   one point per single Successful_Attack.

### Requirement 4: Direct Fire — attacker chooses the component

**User Story:** As a player, I want to choose which component my kinetic attack
damages, so that I can target the enemy capability that matters most to me.

#### Acceptance Criteria

1. WHEN Direct_Fire resolves against a targeted building, THE Combat_System SHALL
   reduce only the single targeted building and SHALL leave every other building
   in the same hex unchanged.
2. WHEN Direct_Fire resolves against a targeted building, THE Combat_System SHALL
   reduce the Component_Value of the one component selected by the
   Attacking_Player by exactly 1 point, to a minimum of 0.
3. THE Combat_System SHALL restrict the Attacking_Player's selectable components
   to those whose Component_Value is at least 1.
4. IF the Attacking_Player does not specify a component for a Direct_Fire attack
   against a building that has at least one component with Component_Value of at
   least 1, THEN THE Combat_System SHALL reject the attack, leave all
   Component_Values unchanged, and indicate that a component selection is
   required.
5. IF the Attacking_Player selects a component whose Component_Value is 0, THEN
   THE Combat_System SHALL reject the attack, leave all Component_Values
   unchanged, and indicate that the selected component cannot be targeted.
6. IF the targeted building has no component with a Component_Value of at least
   1, THEN THE Combat_System SHALL reject the Direct_Fire attack and indicate
   that the building has no targetable component.

### Requirement 5: Splash Fire — one random component per building

**User Story:** As a player, I want splash attacks to scatter damage across
every building in the hex, so that area fire degrades a cluster of structures
without my fine control.

#### Acceptance Criteria

1. WHEN Splash_Fire resolves in a hex, THE Combat_System SHALL reduce exactly one
   eligible component of each enemy building in that hex by one point, where an
   enemy building is any building in the hex not owned by the attacking player
   and an eligible component is one whose Component_Value is at least 1.
2. WHEN Splash_Fire reduces a building, THE Combat_System SHALL select the
   affected component by uniform random choice (each eligible component having
   equal probability) from that building's components whose Component_Value is at
   least 1, and SHALL NOT reduce any selected Component_Value below 0.
3. IF an enemy building in the hex has no component whose Component_Value is at
   least 1, THEN THE Combat_System SHALL leave that building unchanged and
   resolve Splash_Fire for the remaining enemy buildings.
4. IF the hex contains no enemy buildings when Splash_Fire resolves, THEN THE
   Combat_System SHALL complete resolution with no component reductions.
5. THE Combat_System SHALL select each building's random component independently,
   so that two buildings in the same hex may lose different components.
6. THE Combat_System SHALL resolve Splash_Fire random component selection on the
   authoritative server so that all clients observe the same outcome.
7. WHEN the authoritative server result confirms which component was reduced, THE
   client SHALL display the Splash_Fire component reduction, and SHALL NOT
   predict or preview the random selection before that confirmation is received.

### Requirement 6: Depleted and component-less buildings

**User Story:** As a player, I want attacks against an already-stripped building
to behave sensibly, so that the rules stay consistent once a building has no
components left.

#### Acceptance Criteria

1. IF a building has no component with Component_Value of at least 1 when it is
   the subject of a Successful_Attack, THEN THE Combat_System SHALL leave the
   Component_Value of every component of that building unchanged and SHALL remove
   no components from it.
2. WHEN a Successful_Attack targets a building that has at least one component
   with Component_Value of at least 1, THE Combat_System SHALL reduce the total
   Component_Value of that building by at least 1 point.
3. WHEN Direct_Fire is the type of a Successful_Attack targeting a
   Plain_Building, THE Combat_System SHALL resolve the attack while leaving the
   Component_Value of that Plain_Building unchanged.
4. WHEN a Successful_Attack resolves against a building whose Component_Value
   cannot be reduced, THE Combat_System SHALL produce an attack-resolution result
   indicating that no component damage was applied.

### Requirement 7: Combat contributions update with component damage

**User Story:** As a player, I want a degraded building to lose the capability of
the component that was damaged, so that wearing down a building has a real
tactical effect.

#### Acceptance Criteria

1. WHEN a building's `defence` component value is reduced by combat damage, THE
   Combat_System SHALL recompute that building's anti-drone EW screen radius
   (`COMBAT_RULES.md` §12) using the reduced `defence` value within the same
   combat-resolution step, before any subsequent combat calculation references
   that building.
2. WHEN any building component value is reduced by combat damage, THE
   Combat_System SHALL use the reduced component value, rather than the
   pre-damage value, in every combat calculation involving that building that
   resolves after the reduction is applied.
3. IF a building component value reaches 0, THEN THE Combat_System SHALL treat
   that component's capability as fully disabled and SHALL contribute 0 from that
   component to every combat calculation that depends on it.
4. IF combat damage would reduce a building component value below 0, THEN THE
   Combat_System SHALL clamp the reduced value to 0 and SHALL NOT apply a
   negative component value to any combat calculation.

### Requirement 8: Persistence and wire format

**User Story:** As a player, I want a building's accumulated damage to survive
save/load and the client/server round-trip, so that degradation is not undone by
reloading.

#### Acceptance Criteria

1. WHEN the Combat_System reduces a building's Component_Values as a result of
   damage, THE Combat_System SHALL store the reduced Component_Values on that
   building in the authoritative world model.
2. WHEN a world is saved and subsequently reloaded, THE Combat_System SHALL
   restore each building's post-damage Component_Values to exactly the values
   held at the time of saving, with no rounding or loss of precision.
3. WHEN the server serializes the world to the compact wire format, THE compact
   wire format SHALL carry each building's current post-damage Component_Values
   without requiring the client to import server-only modules.
4. WHEN the client deserializes a building from the compact wire format, THE
   client SHALL render and reason about that building using Component_Values
   equal to the server's authoritative post-damage values.
5. IF a building's persisted Component_Values are missing or fall outside the
   range of 0 to that building's original maximum Component_Values during load,
   THEN THE Combat_System SHALL reject the load with an error indicating the
   building data is invalid and SHALL preserve the existing in-memory world state
   unchanged.

### Requirement 9: Player feedback

**User Story:** As a player, I want to see which building component was damaged
by an attack, so that I understand the result of combat against buildings.

#### Acceptance Criteria

1. WHEN a Successful_Attack reduces a building component, THE Combat_System SHALL
   include the affected building identifier, the affected component identifier,
   and the resulting Component_Value (clamped to a minimum of 0) in the combat
   result.
2. IF a Successful_Attack reduces a building component's Component_Value to 0,
   THEN THE Combat_System SHALL report that component as destroyed in the combat
   result.
3. WHEN the authoritative server combat result is received by the client, THE
   client SHALL display the reported building component reduction within 500 ms.
4. IF an authoritative server combat result for an attack has not yet been
   received, THEN THE client SHALL NOT display any building component reduction
   for that attack.
5. WHEN a building's components change, THE rendering layer SHALL rebuild the
   building's procedural model (`client/buildingModel.ts`) from the building's
   current attributes to reflect its current equipment loadout within 500 ms.

## Resolved Decisions

The following questions were raised during drafting and have been confirmed by
the product owner:

- **O1 — A building-damaging attack also damages units in the same hex:**
  **Confirmed.** Existing unit damage rules are unchanged. Splash_Fire applies HP
  damage to enemy units in the hex per `COMBAT_RULES.md` §9 AND applies one
  random component point of damage to each enemy building. Direct_Fire damages
  either a unit (HP) or a building (one component), per the declared target.
- **O2 — A "successful" attack on a building is a flat one-point loss:**
  **Confirmed.** Any resolved Direct_Fire or Splash_Fire that reaches a building
  counts as one successful attack and removes one component point. Buildings have
  no armour mitigation step and no min-damage formula — it is a flat one point.
- **O3 — Buildings can be targeted while friendly units share the hex:**
  **Confirmed.** Targeting follows existing range/validity rules; only enemy
  buildings are damaged.
- **O4 — Weapon-mode auto-selection defaults to Splash_Fire against buildings:**
  **Confirmed.** When an attacker targeting an enemy building has both Direct_Fire
  and Splash_Fire available, auto-selection defaults to Splash_Fire (see
  Requirement 2, criterion 6).
