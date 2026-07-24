---
inclusion: fileMatch
fileMatchPattern: "{client/**/*Model*.ts,client/**/*Renderer*.ts,client/firstPerson*.ts,client/main.ts,artifacts/**/*.glb,artifacts/**/*.gltf}"
---

# External GLB/GLTF Models

**Applies when:** importing, cloning, normalizing, attaching, rendering, or disposing external Three.js models in the scoped client/model files. Do not load this for unrelated UI or game-rule work.

## Before import

- Verify asset provenance and license.
- Inspect the loaded `Object3D` hierarchy. Apparently static GLB/GLTF assets may contain `SkinnedMesh`, bones, armatures, animations, and nested transforms; never assume Mesh-only content.

## Loading, cloning, and ownership

- Preload asynchronous assets before synchronous model builders or sprite baking. Loading failure must leave a safe procedural or absent-model fallback.
- Never use `Object3D.clone(true)` for imported templates: a hierarchy containing `SkinnedMesh` can leave cloned meshes bound to the original bones. Use Three.js `SkeletonUtils.clone()` defensively for every imported model template. In the splash-bomb bug, the bomb root moved while rendered vertices stayed at `y=0` because of this stale binding.
- `SkeletonUtils.clone()` reuses geometry and material references. If instance cleanup disposes them, or an instance mutates them, explicitly clone the affected geometries/materials after the skeleton-aware clone.

## Normalize and measure

- Put the imported scene under a dedicated normalization root. Orient it, measure a `Box3`, center from the measured center, and normalize by the longest dimension.
- `Box3.setFromObject()` uses world transforms. Call `updateMatrixWorld(true)` / `updateWorldMatrix(...)` as appropriate before every consequential measurement, then measure actual post-transform bounds rather than deriving them from intended scale alone.
- For attachment debugging, compare the attachment root transform with precise rendered bounds. A moved root plus unmoved bounds strongly indicates stale skin/bone binding, not placement arithmetic.

## Placement and scaling

- Derive placement from measured dimensions. Distinguish full extent from half extent explicitly; do not treat a diameter/clearance budget as half-height (the splash-bomb secondary bug).
- Clamp non-uniform axes independently when clearance and desired length/width differ.
- Put chassis, pylon/connector, and payload beneath the same final scaling parent so unit size/health scaling preserves contact.

## Validation and cleanup

- Validate every supported attribute-scale × unit-size combination numerically. Check payload-to-connector gap, connector-to-chassis contact, and ground clearance; visual inspection alone is insufficient.
- Remove temporary globals and diagnostic logging after the cause is confirmed.

## Current examples

- `client/splashBombModel.ts`: preload/fallback, normalization, `SkeletonUtils.clone()`, and geometry ownership.
- `client/unitModelAddons.ts`: measured dimensions, independent-axis scaling, half-extents, and payload attachment.