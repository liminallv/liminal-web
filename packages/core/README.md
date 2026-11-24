# @liminal-lv/core

Read [Liminal Editor](https://liminal.lv) levels and describe your entities for its Blender
addon. Engine-agnostic and dependency-free: no renderer, no physics engine, no DOM, no Node —
the same module graph runs in a browser bundle and on an authoritative game server, which is
what lets both resolve a level to byte-identical geometry.

```bash
npm install @liminal-lv/core
```

- `parseScene(bytes, registry, options)` — a `.lm` file → placed entities and geometry
- `createRegistry({ … })` / `defineEntity({ … })` — describe what a designer can place
- `createWiring(entities, registry)` / `lintWiring(…)` — the `source`/`destination` signal graph
- `parseGlb` / `flattenScene` / `readMeshPrimitives` — the glTF reader underneath
- `@liminal-lv/core/glb-write` — a minimal glTF writer, for preview models and generated levels

Full documentation, and the companion packages for collision and Three.js, are in the
[repository README](https://github.com/liminal-editor/liminal-web#readme).

MIT.
