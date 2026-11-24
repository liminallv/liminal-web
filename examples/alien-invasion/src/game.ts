import { lintWiring, spawnLevel } from '@liminal-lv/core';
import { doubleSided, toObject3D } from '@liminal-lv/three';
import { Vector3, type Group, type Mesh, type Object3D } from 'three';

import type { Crate } from './entities/crate.ts';
import type { Door } from './entities/door.ts';
import { REGISTRY, RUNTIMES } from './entities/index.ts';
import { BODY_KINDS, MONSTER_KINDS, type MonsterKind } from './entities/kinds.ts';
import type { Pickup } from './entities/pickup.ts';
import type { Plate } from './entities/plate.ts';
import type { Portal } from './entities/portal.ts';
import type { PatrolStop, Spawner } from './entities/spawner.ts';
import type { Trigger } from './entities/trigger.ts';
import type { Hud } from './hud.ts';
import type { InputState } from './input.ts';
import type { Level, LevelScene } from './level.ts';
import {
  aabbOverlap,
  aabbPolygonOverlap,
  dist,
  normalize,
  planar,
  rayAabb,
  rayCircle,
  rayPolygon,
  resolveCircleAabb,
  resolveCircleCircle,
  resolveCirclePolygon,
  type Aabb,
} from './physics.ts';
import { MATERIALS } from './materials.ts';
import { forwardOf, positionOf } from './placement.ts';
import { monsterMesh, playerMesh, spitMesh, View } from './render.ts';
import { PLAYER_MAX_HP, type Body, type Player, type World } from './world.ts';

interface MonsterStats {
  r: number;
  hp: number;
  speed: number;
  damage: number;
  sight: number;
  ranged: boolean;
}

const STATS: Record<MonsterKind, MonsterStats> = {
  [MONSTER_KINDS.Crawler]: { r: 0.35, hp: 30, speed: 3.4, damage: 10, sight: 10, ranged: false },
  [MONSTER_KINDS.Brute]: { r: 0.6, hp: 130, speed: 1.9, damage: 28, sight: 12, ranged: false },
  [MONSTER_KINDS.Spitter]: { r: 0.4, hp: 45, speed: 2.3, damage: 12, sight: 14, ranged: true },
};

interface Monster {
  kind: MonsterKind;
  stats: MonsterStats;
  pos: Vector3;
  hp: number;
  spawner: Spawner | null;
  patrol: readonly PatrolStop[];
  patrolIndex: number;
  waitTimer: number;
  lastSeen: Vector3 | null;
  memory: number;
  attackCooldown: number;
  mesh: Group;
}

interface Spit {
  pos: Vector3;
  vel: Vector3;
  life: number;
  damage: number;
  mesh: Mesh;
}

const PLAYER_SPEED = 5.2;
const SHOT_PELLETS = 7;
const SHOT_SPREAD = (9 * Math.PI) / 180;
const SHOT_RANGE = 10;
const SHOT_DAMAGE = 9;
const SHOT_COOLDOWN = 0.65;
const CRATE_LEAN_SECONDS = 0.15;
const HURT_GRACE_SECONDS = 0.4;

const spawnAll = (scene: LevelScene, world: World) => spawnLevel(scene, RUNTIMES, world);

export class Game implements World {
  readonly view: View;
  readonly hud: Hud;
  readonly player: Player;
  private readonly level: Level;
  private readonly spawned: ReturnType<typeof spawnAll>;
  private readonly crates: Crate[];
  private readonly doors: Door[];
  private readonly triggers: Trigger[];
  private readonly plates: Plate[];
  private readonly pickups: Pickup[];
  private readonly portals: Portal[];
  private readonly spawners: Spawner[];
  private readonly monsters: Monster[] = [];
  private readonly spits: Spit[] = [];
  private readonly objects: Object3D[] = [];
  private kills = 0;
  private over = false;
  private time = 0;

  constructor(level: Level, view: View, hud: Hud) {
    this.level = level;
    this.view = view;
    this.hud = hud;
    const scene = level.scene;
    for (const problem of lintWiring(scene.entities, REGISTRY)) console.warn(problem.message);

    this.spawned = spawnAll(scene, this);
    const occluders: Mesh[] = [];
    const graph = toObject3D(scene, {
      spawned: this.spawned,
      library: MATERIALS,
      configure: doubleSided,
      onMesh: (mesh, geometry) => {
        const floor = geometry.tags.includes('floor');
        mesh.castShadow = !floor;
        mesh.receiveShadow = true;
        if (!floor) occluders.push(mesh);
      },
    });
    for (const door of this.spawned.resultsOf('func_door')) occluders.push(door.slab);
    view.setLevel(graph, occluders);

    const start = this.spawned.resultsOf('info_player_start')[0];
    if (!start) throw new Error('the level has no info_player_start');
    view.camera.fov = start.properties.camera_fov;
    view.camera.updateProjectionMatrix();
    this.player = {
      pos: positionOf(start),
      r: 0.35,
      hp: PLAYER_MAX_HP,
      shells: start.properties.shells,
      facing: forwardOf(start),
      cooldown: 0,
      hurt: 0,
      mesh: this.track(playerMesh()),
    };

    this.crates = this.spawned.resultsOf('prop_crate');
    this.doors = this.spawned.resultsOf('func_door');
    this.triggers = this.spawned.resultsOf('func_trigger');
    this.plates = this.spawned.resultsOf('func_pressure_plate');
    this.pickups = [...this.spawned.resultsOf('item_health'), ...this.spawned.resultsOf('item_ammo')];
    this.portals = this.spawned.resultsOf('func_exit_portal');
    this.spawners = this.spawned.resultsOf('ai_spawner');

    this.syncVisuals();
  }

  teleport(x: number, z: number): void {
    this.player.pos.set(x, this.player.pos.y, z);
  }

  snapshot(): {
    player: Vector3;
    hp: number;
    shells: number;
    kills: number;
    monsters: Vector3[];
    crates: Record<string, Vector3>;
    plates: Record<string, boolean>;
    doors: Record<string, number>;
    portals: Record<string, boolean>;
  } {
    const crates: Record<string, Vector3> = {};
    const plates: Record<string, boolean> = {};
    const doors: Record<string, number> = {};
    const portals: Record<string, boolean> = {};
    for (const entry of this.spawned.entities) {
      const id = entry.placed.id;
      if (entry.classname === 'prop_crate') crates[id] = entry.result.pos.clone();
      else if (entry.classname === 'func_pressure_plate') plates[id] = entry.result.pressed;
      else if (entry.classname === 'func_door') doors[id] = Number(entry.result.open.toFixed(2)) + (entry.result.locked ? 100 : 0);
      else if (entry.classname === 'func_exit_portal') portals[id] = entry.result.enabled;
    }
    return {
      player: this.player.pos.clone(),
      hp: this.player.hp,
      shells: this.player.shells,
      kills: this.kills,
      monsters: this.monsters.map((m) => m.pos.clone()),
      crates,
      plates,
      doors,
      portals,
    };
  }

  dispose(): void {
    this.view.clearLevel();
    for (const object of this.objects) this.view.remove(object);
    for (const monster of this.monsters) this.view.remove(monster.mesh);
    for (const spit of this.spits) this.view.remove(spit.mesh);
  }

  private track<T extends Object3D>(object: T): T {
    this.view.add(object);
    this.objects.push(object);
    return object;
  }

  finish(title: string, text: string, button: string): void {
    this.over = true;
    this.hud.showOverlay(title, text, button);
  }

  bodies(): Body[] {
    return [
      { kind: BODY_KINDS.Player, pos: this.player.pos, r: this.player.r },
      ...this.monsters.map((m) => ({ kind: BODY_KINDS.Monster, pos: m.pos, r: m.stats.r })),
      ...this.crates.map((c) => ({ kind: BODY_KINDS.Crate, pos: c.pos, r: 0.5 })),
    ];
  }

  update(dt: number, input: InputState): void {
    if (this.over) return;
    this.time += dt;
    this.updatePlayer(dt, input);
    for (const crate of this.crates) crate.update(dt);
    for (const spawner of this.spawners) spawner.update(dt, this);
    this.updateMonsters(dt);
    this.updateSpits(dt);
    for (const door of this.doors) door.update(dt, this);
    for (const plate of this.plates) plate.update(this);
    for (const trigger of this.triggers) trigger.update(this);
    for (const pickup of this.pickups) pickup.update(dt, this);
    for (const portal of this.portals) portal.update(this, this.kills);
    this.syncVisuals();
    this.hud.status(this.player.hp, PLAYER_MAX_HP, this.player.shells, this.kills);
  }

  private solidDoors(): Door[] {
    return this.doors.filter((d) => d.solid);
  }

  private collide(pos: Vector3, r: number, pushDir: Vector3 | null): Crate | null {
    let leaned: Crate | null = null;
    for (let pass = 0; pass < 2; pass++) {
      for (const wall of this.level.walls) resolveCirclePolygon(pos, r, wall);
      for (const door of this.solidDoors()) resolveCircleAabb(pos, r, door.box);
      for (const crate of this.crates) {
        const n = resolveCircleAabb(pos, r, crate.box());
        if (n && pushDir && pushDir.x * -n.x + pushDir.z * -n.z > 0.6) leaned = crate;
      }
    }
    return leaned;
  }

  private updatePlayer(dt: number, input: InputState): void {
    const p = this.player;
    p.cooldown = Math.max(0, p.cooldown - dt);
    p.hurt = Math.max(0, p.hurt - dt);
    const move = planar(input.move.x, -input.move.y);
    const moving = Math.hypot(move.x, move.z) > 0.05;
    p.pos.x += move.x * PLAYER_SPEED * dt;
    p.pos.z += move.z * PLAYER_SPEED * dt;
    const leaned = this.collide(p.pos, p.r, moving ? normalize(move) : null);
    for (const crate of this.crates) {
      if (crate === leaned && !crate.slide) {
        crate.lean += dt;
        if (crate.lean >= CRATE_LEAN_SECONDS) {
          crate.lean = 0;
          this.pushCrate(crate, normalize(move));
        }
      } else crate.lean = 0;
    }
    for (const m of this.monsters) resolveCircleCircle(p.pos, p.r, m.pos, m.stats.r, 0.3);

    let aim: Vector3 | null = input.stickAim ? planar(input.stickAim.x, -input.stickAim.y) : null;
    if (!aim && input.pointer) {
      const point = this.view.aimPoint(input.pointer);
      if (point) aim = normalize(planar(point.x - p.pos.x, point.z - p.pos.z));
    }
    if (aim && Math.hypot(aim.x, aim.z) > 0.01) p.facing = normalize(aim);
    else if (moving) p.facing = normalize(move);

    if (input.fire && p.cooldown === 0) this.fire();
  }

  private pushCrate(crate: Crate, dir: Vector3): void {
    const axis = Math.abs(dir.x) >= Math.abs(dir.z) ? planar(Math.sign(dir.x), 0) : planar(0, Math.sign(dir.z));
    const to = crate.pos.clone().add(axis);
    const target: Aabb = { cx: to.x, cz: to.z, hx: 0.48, hz: 0.48 };
    if (this.level.walls.some((w) => aabbPolygonOverlap(target, w))) return;
    if (this.solidDoors().some((d) => aabbOverlap(target, d.box))) return;
    if (this.crates.some((c) => c !== crate && aabbOverlap(target, c.box()))) return;
    if (this.monsters.some((m) => Math.abs(m.pos.x - to.x) < 0.5 + m.stats.r && Math.abs(m.pos.z - to.z) < 0.5 + m.stats.r)) return;
    crate.slide = { from: crate.pos.clone(), to, t: 0 };
  }

  private fire(): void {
    const p = this.player;
    if (p.shells <= 0) {
      this.hud.say('Out of shells', 1);
      p.cooldown = 0.3;
      return;
    }
    p.shells--;
    p.cooldown = SHOT_COOLDOWN;
    const origin = planar(p.pos.x + p.facing.x * 0.5, p.pos.z + p.facing.z * 0.5);
    this.view.flash(origin);
    const base = Math.atan2(p.facing.z, p.facing.x);
    const damaged = new Set<Monster>();
    for (let i = 0; i < SHOT_PELLETS; i++) {
      const angle = base + (Math.random() * 2 - 1) * SHOT_SPREAD;
      const dir = planar(Math.cos(angle), Math.sin(angle));
      let t = this.occlusion(origin, dir, SHOT_RANGE);
      let hit: Monster | null = null;
      for (const m of this.monsters) {
        const tm = rayCircle(origin, dir, m.pos, m.stats.r);
        if (tm !== null && tm < t) {
          t = tm;
          hit = m;
        }
      }
      this.view.tracer(origin, origin.clone().addScaledVector(dir, t), 0.8);
      if (hit) {
        hit.hp -= SHOT_DAMAGE;
        damaged.add(hit);
      }
    }
    for (const m of damaged) {
      if (m.hp <= 0) this.killMonster(m);
      else m.lastSeen = p.pos.clone();
    }
  }

  private occlusion(origin: Vector3, dir: Vector3, max: number): number {
    let t = max;
    for (const wall of this.level.walls) {
      const tw = rayPolygon(origin, dir, wall);
      if (tw !== null && tw < t) t = tw;
    }
    for (const door of this.solidDoors()) {
      const td = rayAabb(origin, dir, door.box);
      if (td !== null && td < t) t = td;
    }
    for (const crate of this.crates) {
      const tc = rayAabb(origin, dir, crate.box());
      if (tc !== null && tc < t) t = tc;
    }
    return t;
  }

  private canSee(from: Vector3, to: Vector3): boolean {
    const d = dist(from, to);
    if (d < 1e-6) return true;
    const dir = planar((to.x - from.x) / d, (to.z - from.z) / d);
    return this.occlusion(from, dir, d) >= d - 1e-6;
  }

  private killMonster(m: Monster): void {
    const index = this.monsters.indexOf(m);
    if (index < 0) return;
    this.monsters.splice(index, 1);
    this.view.remove(m.mesh);
    this.view.flash(m.pos, 0x80ff80, 6);
    this.kills++;
    m.spawner?.monsterKilled();
  }

  spawnMonster(s: Spawner): void {
    const stats = STATS[s.kind];
    let pos = s.pos.clone();
    for (let attempt = 0; attempt < 12; attempt++) {
      const a = Math.random() * Math.PI * 2;
      const r = Math.sqrt(Math.random()) * s.radius;
      const candidate = new Vector3(s.pos.x + Math.cos(a) * r, s.pos.y, s.pos.z + Math.sin(a) * r);
      const probe = candidate.clone();
      this.collide(probe, stats.r, null);
      if (dist(probe, candidate) < 1e-3 && dist(candidate, this.player.pos) > 2) {
        pos = candidate;
        break;
      }
    }
    const monster: Monster = {
      kind: s.kind,
      stats,
      pos,
      hp: stats.hp,
      spawner: s,
      patrol: s.patrol,
      patrolIndex: 0,
      waitTimer: 0,
      lastSeen: null,
      memory: 0,
      attackCooldown: 1,
      mesh: monsterMesh(s.kind),
    };
    this.view.add(monster.mesh);
    this.view.flash(pos, 0xff6060, 5);
    this.monsters.push(monster);
    s.alive++;
  }

  private updateMonsters(dt: number): void {
    const player = this.player;
    for (const m of this.monsters) {
      m.attackCooldown = Math.max(0, m.attackCooldown - dt);
      const toPlayer = dist(m.pos, player.pos);
      const sees = toPlayer < m.stats.sight && this.canSee(m.pos, player.pos);
      if (sees) {
        m.lastSeen = player.pos.clone();
        m.memory = 3;
      } else {
        m.memory = Math.max(0, m.memory - dt);
        if (m.memory === 0) m.lastSeen = null;
      }

      let goal: Vector3 | null = m.lastSeen;
      let speed = m.stats.speed;
      if (sees && m.stats.ranged) {
        if (toPlayer < 5) goal = planar(m.pos.x - (player.pos.x - m.pos.x), m.pos.z - (player.pos.z - m.pos.z));
        else if (toPlayer < 7) goal = null;
        if (m.attackCooldown === 0) {
          m.attackCooldown = 2;
          this.spit(m);
        }
      }
      if (!goal && !(sees && m.stats.ranged)) {
        if (m.patrol.length > 0) {
          const stop = m.patrol[m.patrolIndex % m.patrol.length]!;
          if (dist(m.pos, stop.pos) < 0.4) {
            m.waitTimer += dt;
            if (m.waitTimer >= stop.wait) {
              m.waitTimer = 0;
              m.patrolIndex = (m.patrolIndex + 1) % m.patrol.length;
            }
          } else goal = stop.pos;
          speed = m.stats.speed * 0.5;
        } else {
          goal = player.pos;
          speed = m.stats.speed * 0.7;
        }
      }

      if (goal) {
        const dir = normalize(planar(goal.x - m.pos.x, goal.z - m.pos.z));
        if (dist(m.pos, goal) > 0.2) {
          m.pos.x += dir.x * speed * dt;
          m.pos.z += dir.z * speed * dt;
          m.mesh.rotation.y = Math.atan2(-dir.x, -dir.z);
        }
      } else if (sees) {
        const dir = normalize(planar(player.pos.x - m.pos.x, player.pos.z - m.pos.z));
        m.mesh.rotation.y = Math.atan2(-dir.x, -dir.z);
      }

      this.collide(m.pos, m.stats.r, null);
      for (const other of this.monsters) {
        if (other !== m) resolveCircleCircle(m.pos, m.stats.r, other.pos, other.stats.r);
      }

      if (!m.stats.ranged && toPlayer < m.stats.r + player.r + 0.25 && m.attackCooldown === 0) {
        m.attackCooldown = 1;
        this.hurtPlayer(m.stats.damage);
      }
    }
  }

  private spit(m: Monster): void {
    const dir = normalize(planar(this.player.pos.x - m.pos.x, this.player.pos.z - m.pos.z));
    const mesh = spitMesh();
    this.view.add(mesh);
    this.spits.push({
      pos: planar(m.pos.x + dir.x * m.stats.r, m.pos.z + dir.z * m.stats.r),
      vel: dir.clone().multiplyScalar(7),
      life: 3,
      damage: m.stats.damage,
      mesh,
    });
  }

  private updateSpits(dt: number): void {
    for (let i = this.spits.length - 1; i >= 0; i--) {
      const s = this.spits[i]!;
      s.life -= dt;
      const step = s.vel.clone().multiplyScalar(dt);
      const stepLen = Math.hypot(step.x, step.z);
      const blocked = this.occlusion(s.pos, normalize(step), stepLen) < stepLen;
      s.pos.add(step);
      const hitPlayer = dist(s.pos, this.player.pos) < this.player.r + 0.16;
      if (hitPlayer) this.hurtPlayer(s.damage);
      if (blocked || hitPlayer || s.life <= 0) {
        this.view.remove(s.mesh);
        this.spits.splice(i, 1);
        continue;
      }
      s.mesh.position.set(s.pos.x, 0.7, s.pos.z);
    }
  }

  private hurtPlayer(amount: number): void {
    if (this.over || this.player.hurt > 0) return;
    this.player.hp -= amount;
    this.player.hurt = HURT_GRACE_SECONDS;
    this.view.flash(this.player.pos, 0xff3030, 4);
    if (this.player.hp <= 0) {
      this.player.hp = 0;
      this.finish('YOU DIED', `${this.kills} kills. The outpost is lost.`, 'Try again');
    }
  }

  private syncVisuals(): void {
    const p = this.player;
    p.mesh.position.copy(p.pos);
    p.mesh.rotation.y = Math.atan2(-p.facing.x, -p.facing.z);
    p.mesh.visible = !(p.hurt > 0 && Math.floor(this.time * 30) % 2 === 0);
    this.view.follow(p.pos);
    for (const m of this.monsters) m.mesh.position.copy(m.pos);
    for (const pickup of this.pickups) pickup.animate(this.time);
    for (const portal of this.portals) portal.animate(this.time);
  }
}
