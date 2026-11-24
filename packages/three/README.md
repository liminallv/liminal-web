# @liminal-lv/three

Turn [Liminal Editor](https://liminal.lv) level geometry into Three.js meshes and materials.

```bash
npm install @liminal-lv/three three
```

```ts
import { toMesh } from '@liminal-lv/three';

for (const node of scene.geometry) group.add(toMesh(node, { library: MATERIALS }));
```

`three` is a **peer** dependency, so this package can never be the reason your app ends up
with two copies of Three. A `.lm` is Y-up glTF — Three's own convention — so a world matrix
goes straight into `applyMatrix4` with nothing to convert.

Full documentation is in the
[repository README](https://github.com/liminal-editor/liminal-web#readme). MIT.
