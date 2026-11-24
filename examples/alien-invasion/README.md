# Alien Invasion

A top-down 2.5D shooter that exists to exercise the Liminal Web SDK end to end: entities
described in TypeScript, levels built in Blender with the Liminal addon, and a Three.js game
that reads the export back. Shotgun, aliens, doors, crates, pressure plates, an arena.

```bash
pnpm install          # from integrations/web
pnpm build            # the SDK packages the example links against
cd examples/alien-invasion
pnpm dev              # http://localhost:5173
```

WASD moves, the mouse aims, left click or Space fires. On a touch screen the two on-screen
sticks move and aim; pushing the right stick far enough fires.

## What is where

| Path | Role |
|---|---|
| `src/entities/` | One file per entity: its definition, which `liminal sync` publishes to Blender, and its runtime, which spawns it and handles its signals. `index.ts` holds the registry and the runtime list. |
| `src/materials.ts` | The material library. |
| `src/world.ts` | What every entity runtime can reach in the game: the player, bodies, signals, the view. |
| `liminal.config.ts` | What `liminal sync` reads to write the Blender workspace. |
| `_blender/` | The workspace the addon is pointed at. Generated, except `levels/`, which the designer owns. |
| `blender/outpost.blend` | The level source. Open it in Blender with the addon installed. |
| `assets/gizmos/` | Icons the viewport gizmos use, drawn by `pnpm icons`. |
| `scripts/author-level.py` | Rebuilds the level from a script through a real Blender. |
| `src/game.ts` | Spawns the level with `spawnLevel`, builds its Three.js scene graph with `toObject3D`, runs the player, the monsters and the shared collision, and steps every entity. |
| `src/physics.ts` | Planar collision on the world XZ plane, over `Vector3`. No physics engine. |
| `src/render.ts` | Three.js view, camera, lights, and the meshes each entity draws as. |

## The entities

| Classname | What it does | Gizmos it shows off |
|---|---|---|
| `info_player_start` | Spawn point. Local +Y is the facing. | arrow, textured billboard, frustum bound to `camera_fov`, text |
| `ai_spawner` | Waves of monsters inside a radius. Child `info_waypoint`s are the patrol route. | sphere bound to `radius`, billboard, path through children, text with `{{tokens}}` |
| `info_waypoint` | One patrol stop. | solid sphere, text |
| `item_health`, `item_ammo` | Pickups, optionally respawning. | textured billboards, wire sphere |
| `func_door` | A brush slab. Proximity door at `required` 0, puzzle door above it. Locks on `lock_name`, releases on `unlock_name`. | textured volume fill, arrow, text |
| `func_trigger` | A brush region signalling `on_enter` and `on_exit`. | textured volume fill, text |
| `func_exit_portal` | Ends the level. Can start dormant. | solid cone, sphere bound to `radius`, billboard, text |
| `func_counter` | Counts activations, fires `on_complete`. | billboard, solid box, text |
| `func_pressure_plate` | Holds `target` active while something it accepts rests on it. `latch` turns it into a switch. | flat solid box with per-axis half-extents, text |
| `prop_crate` | Pushed one metre at a time along the four cardinal directions. | solid box with colour bound to `tint`, four arrows |

## Signals

Every `source` prop is a name an entity answers to; every `destination` prop is a name it
sends to. `spawnLevel` from `@liminal-lv/core` routes a signal to the receiving runtime's handler
for the `source` prop that answers to it, so a Blender arrow and a runtime signal are the same thing. Two payloads exist, on and off, carried as
`LIMINAL_SIGNALS.ACTIVATE` and `DEACTIVATE`.

| Sender | Sends |
|---|---|
| `func_pressure_plate.target` | on while pressed, off when released, unless latched |
| `func_trigger.on_enter` | on at first entry, off when the region empties, unless `once` |
| `func_trigger.on_exit` | on when the region empties |
| `ai_spawner.on_kill` | on per kill |
| `ai_spawner.on_cleared` | on when every wave is dead |
| `func_counter.on_count`, `on_complete` | on |

| Receiver | Reacts |
|---|---|
| `func_door.targetname` | counts distinct senders currently on; opens at `required` |
| `func_door.lock_name`, `unlock_name` | on locks, on unlocks |
| `ai_spawner.targetname` | on starts the waves |
| `func_counter.targetname` | on counts one |
| `func_exit_portal.targetname` | on enables, off disables |

The shipped level wires both scenarios the game was built for:

- **Puzzle doors.** Door 1 needs one signal, from a plate the player or a crate can press. The
  door closes before the player reaches it, so the crate has to hold it. Door 2 needs two: a
  latching player plate acting as a switch, plus a second plate held by the player or a crate.
- **Arena.** A trigger inside the arena sends `arena_start`, which locks both arena doors and
  starts three spawners. Their `on_kill` feeds a counter. At ten kills it sends `arena_clear`,
  which unlocks the doors and switches the exit portal on.

`pnpm wiring` prints the whole graph; `pnpm verify` parses the level and lints it.

## Editing the level

1. `pnpm sync` writes `_blender/` from the registry.
2. Open `blender/outpost.blend`, add a Liminal configuration pointing at `_blender`, and reload.
3. Build walls as plain meshes with a collision kind and the `wall` tag; floors are `NONE` with
   the `floor` tag. Add entities from the Liminal menu and wire them by name.
4. Export. The addon writes `_blender/levels/outpost.lm` and the dev server reloads it.

`scripts/author-level.py` rebuilds the level from scratch through the e2e harness and a cached
Blender, which is how the committed `.blend` and `.lm` were produced.

## Coordinates

The play plane is Blender XY, which is glTF XZ with Z negated. `@liminal-lv/collision-2d` with
`plane: 'xz'` produces exactly that, so a position in the game equals the one the designer sees
in Blender's top view. Heights are glTF Y.
