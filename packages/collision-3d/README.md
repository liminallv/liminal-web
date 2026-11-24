# @liminal-lv/collision-3d

Turn [Liminal Editor](https://liminal.lv) level geometry into 3D collider shapes.

```bash
npm install @liminal-lv/collision-3d
```

```ts
import { collider3dFrom } from '@liminal-lv/collision-3d';

const collider = collider3dFrom(node.mesh, node.world, node.collision);
// collider.box | .sphere | .segment | .points | .trimesh, plus .transform
```

Produces plain data and knows nothing about Rapier, Cannon, Jolt, Havok or Ammo. Choose
`space: 'world'` to bake the placement into the shape (right for static level geometry) or
`space: 'local'` to keep the shape local and place the body at `collider.transform`.

Full documentation is in the
[repository README](https://github.com/liminal-editor/liminal-web#readme). MIT.
