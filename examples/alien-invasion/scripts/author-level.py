"""Builds the Outpost level through the Liminal addon in a real Blender.

Writes blender/outpost.blend, the source a designer opens to keep working on the
level, and _blender/levels/outpost.lm, the export the game loads. Syncs the
workspace first so the addon sees the current entity registry.

    python scripts/author-level.py                 # Blender from the e2e cache
    python scripts/author-level.py --blender <exe>

Run from the example directory. Reuses the e2e harness under automation/e2e.
"""

import argparse
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
EXAMPLE = HERE.parent
REPO_ROOT = EXAMPLE.parents[3]
WORKSPACE = EXAMPLE / "_blender"
BLEND = EXAMPLE / "blender" / "outpost.blend"
LEVEL = WORKSPACE / "levels" / "outpost.lm"
CLI = EXAMPLE / "node_modules" / "@liminal-lv" / "cli" / "dist" / "bin.js"

sys.path.insert(0, str(REPO_ROOT / "automation" / "e2e"))
sys.path.insert(0, str(REPO_ROOT / "automation" / "test"))

from blender_session import BlenderSession  # noqa: E402
from downloader import get_blender  # noqa: E402
import setup  # noqa: E402

DEFAULT_BLENDER = "4.5.0"
BINARY_CACHE = REPO_ROOT / "automation" / "test" / "cache"

AUTHOR = r'''
import bpy

for obj in list(bpy.data.objects):
    bpy.data.objects.remove(obj, do_unlink=True)

WALL_H = 2.6
T = 0.5


def add_entity(classname, name, location=(0, 0, 0), **props):
    before = {obj.name for obj in bpy.data.objects}
    getattr(bpy.ops.object, "lm_add_" + classname)()
    added = [obj for obj in bpy.data.objects
             if obj.name not in before and obj.get("entity_type") == classname]
    assert len(added) == 1, (classname, added)
    obj = added[0]
    obj.name = name
    obj.location = location
    for key, value in props.items():
        obj[key] = value
    return obj


def material(name, rgba):
    mat = bpy.data.materials.get(name)
    if mat is None:
        mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    if bsdf is not None:
        bsdf.inputs["Base Color"].default_value = rgba
    mat.diffuse_color = rgba
    return mat


concrete = material("wall_concrete", (0.42, 0.43, 0.45, 1))
panel = material("wall_panel", (0.28, 0.33, 0.42, 1))
hazard = material("wall_hazard", (0.9, 0.65, 0.1, 1))
deck = material("floor_plate", (0.16, 0.17, 0.2, 1))
arena_deck = material("floor_arena", (0.24, 0.12, 0.12, 1))
glow = material("glow_cyan", (0.1, 0.6, 0.7, 1))


def box(name, cx, cy, sx, sy, sz, z=None, mat=None, collision="BOX", tag="wall"):
    bpy.ops.mesh.primitive_cube_add(size=1.0, location=(cx, cy, sz / 2 if z is None else z))
    obj = bpy.context.active_object
    obj.name = name
    obj.scale = (sx, sy, sz)
    obj.lm_geometry.collision = collision
    obj.lm_geometry.tags = tag
    if mat is not None:
        obj.data.materials.append(mat)
    return obj


def wall(name, x0, y0, x1, y1, mat=concrete):
    if x0 == x1:
        return box(name, x0, (y0 + y1) / 2, T, abs(y1 - y0) + T, WALL_H, mat=mat)
    return box(name, (x0 + x1) / 2, y0, abs(x1 - x0) + T, T, WALL_H, mat=mat)


def floor(name, x0, y0, x1, y1, mat=deck):
    return box(name, (x0 + x1) / 2, (y0 + y1) / 2, x1 - x0, y1 - y0, 0.2,
               z=-0.1, mat=mat, collision="NONE", tag="floor")


def volume(obj, cx, cy, sx, sy, sz, mat=None):
    obj.location = (cx, cy, sz / 2)
    obj.scale = (sx / 2, sy / 2, sz / 2)
    if mat is not None:
        obj.data.materials.append(mat)
    return obj


# ── Room A: the airlock, a crate puzzle ──────────────────────────────────────
floor("Floor A", 0, 0, 10, 10)
wall("A South", 0, 0, 10, 0)
wall("A West", 0, 0, 0, 10)
wall("A East", 10, 0, 10, 10)
wall("A North L", 0, 10, 4, 10)
wall("A North R", 7, 10, 10, 10)

add_entity("info_player_start", "Player Start", (5, 2, 0), shells=16)
add_entity("prop_crate", "Crate A", (3, 6, 0))
add_entity("func_pressure_plate", "Plate A", (8, 8, 0), target="d1", accepts="Player,Crate")
add_entity("item_ammo", "Ammo A", (1.5, 8.5, 0), shells=6)

# ── Corridor A→B with the first door ─────────────────────────────────────────
floor("Floor AB", 4, 10, 7, 18, mat=deck)
wall("AB West", 4, 10, 4, 18, mat=panel)
wall("AB East", 7, 10, 7, 18, mat=panel)
volume(add_entity("func_door", "Door 1", targetname="d1", required=1),
       5.5, 11.5, 3, 0.4, 2.5, mat=hazard)

# ── Room B: patrol, two-signal door ──────────────────────────────────────────
floor("Floor B", 0, 18, 14, 30)
wall("B South L", 0, 18, 4, 18)
wall("B South R", 7, 18, 14, 18)
wall("B West", 0, 18, 0, 30)
wall("B North", 0, 30, 14, 30)
wall("B East S", 14, 18, 14, 22)
wall("B East N", 14, 25, 14, 30)
box("B Console", 7, 29, 3, 1, 1.2, mat=panel, tag="cover")

patrol = add_entity("ai_spawner", "Spawner B", (7, 24, 0), monster="Crawler", count=2, waves=1,
                    radius=1, auto_start=True)
for i, (x, y) in enumerate([(2.5, 20), (11.5, 20), (11.5, 28), (2.5, 28)], start=1):
    wp = add_entity("info_waypoint", f"B Route {i}", (x, y, 0), wait=1.0)
    wp.parent = patrol
    wp.matrix_parent_inverse = patrol.matrix_world.inverted()

add_entity("prop_crate", "Crate B", (7, 21, 0))
add_entity("func_pressure_plate", "Plate B Crate", (12, 20, 0), target="d2", accepts="Player,Crate")
add_entity("func_pressure_plate", "Plate B Switch", (1.5, 28.5, 0), target="d2", accepts="Player", latch=True)
add_entity("item_health", "Health B", (1.5, 19.5, 0), amount=25)
add_entity("item_ammo", "Ammo B", (12.5, 28.5, 0), shells=8)

# ── Corridor B→C ─────────────────────────────────────────────────────────────
floor("Floor BC", 14, 22, 22, 25, mat=deck)
wall("BC South", 14, 22, 22, 22, mat=panel)
wall("BC North", 14, 25, 22, 25, mat=panel)
volume(add_entity("func_door", "Door 2", targetname="d2", required=2),
       15.5, 23.5, 0.4, 3, 2.5, mat=hazard)

# ── Room C: the arena ────────────────────────────────────────────────────────
floor("Floor C", 22, 16, 40, 32, mat=arena_deck)
wall("C West S", 22, 16, 22, 22)
wall("C West N", 22, 25, 22, 32)
wall("C South", 22, 16, 40, 16)
wall("C East", 40, 16, 40, 32)
wall("C North L", 22, 32, 29, 32)
wall("C North R", 32, 32, 40, 32)
for i, (x, y) in enumerate([(27, 20), (27, 28), (35, 20), (35, 28)], start=1):
    box(f"Pillar {i}", x, y, 1.5, 1.5, WALL_H, mat=panel, tag="cover")

volume(add_entity("func_door", "Door 3", lock_name="arena_start", unlock_name="arena_clear"),
       23.2, 23.5, 0.4, 3, 2.5, mat=hazard)
volume(add_entity("func_door", "Door 4", lock_name="arena_start", unlock_name="arena_clear"),
       30.5, 32.8, 3, 0.4, 2.5, mat=hazard)
volume(add_entity("func_trigger", "Arena Trigger", on_enter="arena_start", accepts="Player", once=True),
       25.5, 23.5, 3, 3, 2)

add_entity("ai_spawner", "Spawner C1", (26, 18, 0), targetname="arena_start", monster="Crawler",
           count=3, waves=2, interval=6, radius=1.5, on_kill="arena_kills")
add_entity("ai_spawner", "Spawner C2", (37.5, 29.5, 0), targetname="arena_start", monster="Brute",
           count=1, waves=2, interval=10, radius=1, on_kill="arena_kills")
add_entity("ai_spawner", "Spawner C3", (37.5, 18.5, 0), targetname="arena_start", monster="Spitter",
           count=2, waves=1, interval=4, radius=1.5, on_kill="arena_kills")
add_entity("func_counter", "Arena Counter", (31, 24, 0), targetname="arena_kills", count=10,
           on_complete="arena_clear")
add_entity("item_health", "Health C1", (23.5, 30.5, 0), amount=25, respawn=30)
add_entity("item_ammo", "Ammo C1", (38.5, 17.5, 0), shells=12, respawn=15)
add_entity("item_ammo", "Ammo C2", (31, 30.5, 0), shells=12, respawn=15)

# ── Corridor C→E and the exit ────────────────────────────────────────────────
floor("Floor CE", 29, 32, 32, 40, mat=deck)
wall("CE West", 29, 32, 29, 40, mat=panel)
wall("CE East", 32, 32, 32, 40, mat=panel)

floor("Floor E", 24, 40, 37, 48)
wall("E South L", 24, 40, 29, 40)
wall("E South R", 32, 40, 37, 40)
wall("E West", 24, 40, 24, 48)
wall("E East", 37, 40, 37, 48)
wall("E North", 24, 48, 37, 48)
box("E Trim W", 24.4, 44, 0.3, 7, 0.3, z=0.15, mat=glow, collision="NONE", tag="floor")
box("E Trim E", 36.6, 44, 0.3, 7, 0.3, z=0.15, mat=glow, collision="NONE", tag="floor")

add_entity("func_exit_portal", "Exit", (30.5, 45, 0), targetname="arena_clear", enabled=False, radius=1)
add_entity("item_health", "Health E", (26, 46, 0), amount=50)

bpy.context.view_layer.update()
'''


def sync_workspace() -> None:
    subprocess.run(["node", str(CLI), "sync"], check=True, cwd=EXAMPLE)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--blender", type=Path, help="Blender executable to author with")
    parser.add_argument("--blender-version", default=DEFAULT_BLENDER,
                        help="version to fetch from the e2e cache when --blender is not given")
    args = parser.parse_args()

    blender_exe = args.blender or get_blender(args.blender_version, BINARY_CACHE)
    sync_workspace()
    work_dir = Path(tempfile.mkdtemp(prefix="liminal-outpost-"))
    BLEND.parent.mkdir(parents=True, exist_ok=True)
    print(f"authoring with {blender_exe}; work dir {work_dir}")

    session = BlenderSession(blender_exe, args.blender_version, work_dir / "blender", work_dir / "blender.log")
    with session:
        blender = session.client
        setup.use_workspace(blender, WORKSPACE, name="alien-invasion")
        blender.exec(AUTHOR, timeout=120.0)
        blender.exec(f"import bpy\nbpy.ops.wm.save_as_mainfile(filepath={str(BLEND)!r})", timeout=60.0)
        print(f"wrote {BLEND}")
        blender.call_operator("lm.export_level", timeout=120.0, filepath=str(LEVEL))
        print(f"wrote {LEVEL}")
        errors = session.script_errors()
    if errors:
        print("Blender reported errors during authoring:", *errors, sep="\n  ")
        print(f"log: {session.log_path}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
