"""Regenerates test/fixtures/demo-entity.lm and demo-level.lm with a real Blender.

Both files are authored through the Liminal addon's own operators and written by
its export operator, so what the tests parse is what the addon ships, not what
this package's writer thinks it ships. demo-entities.json is hand-written and is
the manifest both are authored against; this script does not touch it.

    python scripts/gen-demo-fixtures.py                 # Blender from the e2e cache
    python scripts/gen-demo-fixtures.py --blender <exe>

Run from packages/core. Reuses the e2e harness under automation/e2e to install
the addon into a throwaway Blender profile and drive it over its debug server.
"""

import argparse
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
PACKAGE = HERE.parent
REPO_ROOT = PACKAGE.parents[3]
FIXTURES = PACKAGE / "test" / "fixtures"

sys.path.insert(0, str(REPO_ROOT / "automation" / "e2e"))
sys.path.insert(0, str(REPO_ROOT / "automation" / "test"))

from blender_session import BlenderSession  # noqa: E402
from downloader import get_blender  # noqa: E402
import setup  # noqa: E402

DEFAULT_BLENDER = "4.5.0"
BINARY_CACHE = REPO_ROOT / "automation" / "test" / "cache"

CLEAR_SCENE = """
import bpy
for obj in list(bpy.data.objects):
    bpy.data.objects.remove(obj, do_unlink=True)


def add_entity(classname):
    before = {obj.name for obj in bpy.data.objects}
    getattr(bpy.ops.object, "lm_add_" + classname)()
    added = [obj for obj in bpy.data.objects
             if obj.name not in before and obj.get("entity_type") == classname]
    assert len(added) == 1, added
    return added[0]
"""

AUTHOR_DOCK = CLEAR_SCENE + """
bpy.ops.mesh.primitive_cube_add(size=1.0, location=(0.0, 0.0, 0.5))
body = bpy.context.active_object
body.name = "Body"
body.lm_geometry.collision = "BOX"

beacon = add_entity("fx_beacon")
beacon.name = "Beacon"
beacon.location = (0.0, 0.0, 1.5)
beacon["color"] = [1.0, 0.35, 0.3, 1.0]
beacon["size"] = 0.4
"""

AUTHOR_LEVEL = CLEAR_SCENE + """
settings = add_entity("info_zone_settings")
settings.name = "Zone Settings"
settings["title"] = "Demo Zone"
settings["gravity_y"] = -1.0
settings["hazards_enabled"] = True

entry = add_entity("trigger_zone")
entry.name = "Entry Trigger"
entry.location = (0.0, 0.0, 0.0)
entry["targetname"] = "entry"
entry["target"] = "chime"

chime = add_entity("trigger_zone")
chime.name = "Chime Trigger"
chime.location = (10.0, 0.0, 0.0)
chime["targetname"] = "chime"

dock = add_entity("prop_dock")
dock.name = "Dock"
dock.location = (20.0, 0.0, 0.0)
dock["dock_id"] = 1

bpy.ops.mesh.primitive_cube_add(size=1.0, location=(0.0, 0.0, -0.5))
ground = bpy.context.active_object
ground.name = "Ground"
ground.scale = (40.0, 10.0, 1.0)
ground.lm_geometry.collision = "BOX"
ground.lm_geometry.tags = "walkable"
"""


def sync_workspace(workspace: Path, definitions: Path | None) -> None:
    args = ["node", str(HERE / "sync-demo-workspace.ts"), str(workspace)]
    if definitions is not None:
        args.append(str(definitions))
    subprocess.run(args, check=True, cwd=PACKAGE)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--blender", type=Path, help="Blender executable to author with")
    parser.add_argument("--blender-version", default=DEFAULT_BLENDER,
                        help="version to fetch from the e2e cache when --blender is not given")
    args = parser.parse_args()

    blender_exe = args.blender or get_blender(args.blender_version, BINARY_CACHE)
    work_dir = Path(tempfile.mkdtemp(prefix="liminal-fixtures-"))
    workspace = work_dir / "workspace"
    definitions = work_dir / "definitions"
    definitions.mkdir()
    print(f"authoring with {blender_exe}; work dir {work_dir}")

    sync_workspace(workspace, None)
    session = BlenderSession(blender_exe, args.blender_version,
                             work_dir / "blender", work_dir / "blender.log")
    with session:
        blender = session.client
        setup.use_workspace(blender, workspace)

        blender.exec(AUTHOR_DOCK, timeout=60.0)
        entity_file = FIXTURES / "demo-entity.lm"
        blender.call_operator("lm.export_level", timeout=120.0, filepath=str(entity_file))
        print(f"wrote {entity_file}")

        shutil.copyfile(entity_file, definitions / "prop_dock.lm")
        sync_workspace(workspace, definitions)
        blender.call_operator("lm.reload_entities", timeout=60.0)

        blender.exec(AUTHOR_LEVEL, timeout=60.0)
        level_file = FIXTURES / "demo-level.lm"
        blender.call_operator("lm.export_level", timeout=120.0, filepath=str(level_file))
        print(f"wrote {level_file}")

        errors = session.script_errors()
    if errors:
        print("Blender reported errors during authoring:", *errors, sep="\n  ")
        print(f"log: {session.log_path}")
        return 1
    shutil.rmtree(work_dir, ignore_errors=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
