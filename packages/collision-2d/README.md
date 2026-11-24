# @liminal-lv/collision-2d

Turn [Liminal Editor](https://liminal.lv) level geometry into 2D collider shapes.

```bash
npm install @liminal-lv/collision-2d
```

```ts
import { collider2dFrom } from '@liminal-lv/collision-2d';

const collider = collider2dFrom(node.mesh, node.world, node.collision);
if (collider?.box) world.addBox(collider.box);
else if (collider?.trimesh) world.addTrimesh(collider.trimesh);
else if (collider) world.addConvex(collider.points);
```

Produces plain data — points, oriented boxes, triangle soups, circles, capsules — and knows
nothing about Rapier, Matter, Planck or Box2D. Pick your play plane with
`{ plane: 'xy' | 'xz' }`; the box fit is a true minimum-area OBB via rotating calipers, so a
rotated wall does not inflate into a fat square.

Full documentation is in the
[repository README](https://github.com/liminal-editor/liminal-web#readme). MIT.
