import { toBufferGeometry, toMaterial } from '@liminal-lv/three';
import type { LiminalMesh } from '@liminal-lv/core';
import {
  AmbientLight,
  BoxGeometry,
  BufferGeometry,
  CapsuleGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  DirectionalLight,
  Float32BufferAttribute,
  Group,
  HemisphereLight,
  type IUniform,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  type Material,
  PCFShadowMap,
  PerspectiveCamera,
  Plane,
  PointLight,
  Raycaster,
  Scene,
  SphereGeometry,
  TorusGeometry,
  Vector2,
  Vector3,
  WebGLRenderer,
} from 'three';

import { MONSTER_KINDS, type MonsterKind } from './entities/kinds.ts';
import { MATERIALS } from './materials.ts';
import type { Vec } from './input.ts';

export const CAMERA_OFFSET = { back: 8, up: 11 };

const SEE_THROUGH_RADIUS = 1.7;
const SEE_THROUGH_FADE_RATE = 6;
const SEE_THROUGH_PROBES = [0.35, 0.95];

const seeThroughFragment = /* glsl */ `
uniform vec2 uSeeCenter;
uniform float uSeeRadius;
uniform float uSeeDepth;
uniform float uSeeStrength;
const float SEE_BAYER[16] = float[16](0., 8., 2., 10., 12., 4., 14., 6., 3., 11., 1., 9., 15., 7., 13., 5.);
`;

const seeThroughDiscard = /* glsl */ `
if (uSeeStrength > 0.0 && vViewPosition.z < uSeeDepth) {
  float d = length(gl_FragCoord.xy - uSeeCenter) / uSeeRadius;
  ivec2 cell = ivec2(mod(gl_FragCoord.xy, 4.0));
  float threshold = (SEE_BAYER[cell.x + cell.y * 4] + 0.5) / 16.0;
  if (threshold < uSeeStrength * 0.8 * smoothstep(1.0, 0.55, d)) discard;
}
`;

interface Tracer {
  readonly line: LineSegments;
  life: number;
}

export class View {
  readonly renderer: WebGLRenderer;
  readonly scene = new Scene();
  readonly camera: PerspectiveCamera;
  private readonly levelGroup = new Group();
  private readonly tracers: Tracer[] = [];
  private readonly flashes: { light: PointLight; life: number }[] = [];
  private readonly raycaster = new Raycaster();
  private readonly aimPlane = new Plane(new Vector3(0, 1, 0), -0.8);
  private readonly target = new Vector3();
  private readonly focus = new Vector3();
  private readonly occluders: Mesh[] = [];
  private readonly seeThrough: Record<string, IUniform> = {
    uSeeCenter: { value: new Vector2() },
    uSeeRadius: { value: 1 },
    uSeeDepth: { value: 0 },
    uSeeStrength: { value: 0 },
  };

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = PCFShadowMap;
    this.scene.background = new Color(0x06070b);
    this.camera = new PerspectiveCamera(42, 1, 0.1, 200);
    this.scene.add(this.levelGroup);

    this.scene.add(new HemisphereLight(0x8aa0c0, 0x201810, 0.55));
    this.scene.add(new AmbientLight(0x404050, 0.4));
    const sun = new DirectionalLight(0xfff1dd, 1.6);
    sun.position.set(12, 30, 10);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.camera.left = -30;
    sun.shadow.camera.right = 30;
    sun.shadow.camera.top = 30;
    sun.shadow.camera.bottom = -30;
    sun.shadow.camera.far = 80;
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.06;
    this.scene.add(sun);
    this.scene.add(sun.target);
    this.sun = sun;

    this.resize();
    addEventListener('resize', () => this.resize());
  }

  private readonly sun: DirectionalLight;

  resize(): void {
    const w = innerWidth;
    const h = innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  setLevel(level: Object3D, occluders: readonly Mesh[]): void {
    this.levelGroup.clear();
    this.occluders.length = 0;
    this.levelGroup.add(level);
    this.levelGroup.updateMatrixWorld(true);
    for (const mesh of occluders) this.addOccluder(mesh);
  }

  clearLevel(): void {
    this.levelGroup.clear();
    this.occluders.length = 0;
  }

  add(object: Object3D): void {
    this.scene.add(object);
  }

  remove(object: Object3D): void {
    this.scene.remove(object);
    const index = this.occluders.indexOf(object as Mesh);
    if (index >= 0) this.occluders.splice(index, 1);
  }

  addOccluder(mesh: Mesh): void {
    this.occluders.push(mesh);
    const material = mesh.material as Material;
    material.customProgramCacheKey = () => 'see-through';
    material.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, this.seeThrough);
      shader.fragmentShader = shader.fragmentShader
        .replace('void main() {', `${seeThroughFragment}
void main() {`)
        .replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>
${seeThroughDiscard}`);
    };
    material.needsUpdate = true;
  }

  follow(p: Vector3): void {
    this.target.set(p.x, 0, p.z);
    this.camera.position.set(p.x, CAMERA_OFFSET.up, p.z + CAMERA_OFFSET.back);
    this.camera.lookAt(this.target);
    this.camera.updateMatrixWorld();
    this.focus.set(p.x, 0, p.z);
    this.sun.position.set(p.x + 12, 30, p.z + 10);
    this.sun.target.position.copy(this.target);
  }

  aimPoint(ndc: Vec): Vector3 | null {
    this.raycaster.setFromCamera(new Vector2(ndc.x, ndc.y), this.camera);
    return this.raycaster.ray.intersectPlane(this.aimPlane, new Vector3());
  }

  tracer(from: Vector3, to: Vector3, height: number): void {
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new Float32BufferAttribute([from.x, height, from.z, to.x, height, to.z], 3));
    const line = new LineSegments(geometry, new LineBasicMaterial({ color: 0xfff2b0, transparent: true, opacity: 0.9 }));
    this.scene.add(line);
    this.tracers.push({ line, life: 0.12 });
  }

  flash(p: Vector3, color = 0xffd080, intensity = 12): void {
    const light = new PointLight(color, intensity, 7, 2);
    light.position.set(p.x, 1.2, p.z);
    this.scene.add(light);
    this.flashes.push({ light, life: 0.08 });
  }

  private updateSeeThrough(dt: number): void {
    const camera = this.camera;
    const occluded = SEE_THROUGH_PROBES.some((height) => {
      const probe = this.focus.clone().setY(height);
      const toProbe = probe.clone().sub(camera.position);
      const distance = toProbe.length();
      this.raycaster.set(camera.position, toProbe.normalize());
      this.raycaster.far = distance - 0.05;
      return this.raycaster.intersectObjects(this.occluders, false).length > 0;
    });
    this.raycaster.far = Infinity;
    const u = this.seeThrough;
    const step = SEE_THROUGH_FADE_RATE * dt;
    u.uSeeStrength!.value = Math.min(1, Math.max(0, u.uSeeStrength!.value + (occluded ? step : -step)));

    const size = this.renderer.getDrawingBufferSize(new Vector2());
    const center = this.focus.clone().setY(0.8);
    const edge = center.clone().add(new Vector3(SEE_THROUGH_RADIUS, 0, 0));
    const toPixels = (v: Vector3) => {
      const ndc = v.clone().project(camera);
      return new Vector2((ndc.x * 0.5 + 0.5) * size.x, (ndc.y * 0.5 + 0.5) * size.y);
    };
    const c = toPixels(center);
    u.uSeeCenter!.value.copy(c);
    u.uSeeRadius!.value = Math.max(1, toPixels(edge).distanceTo(c));
    u.uSeeDepth!.value = -center.applyMatrix4(camera.matrixWorldInverse).z - 0.3;
  }

  tick(dt: number): void {
    this.updateSeeThrough(dt);
    for (let i = this.tracers.length - 1; i >= 0; i--) {
      const t = this.tracers[i]!;
      t.life -= dt;
      (t.line.material as LineBasicMaterial).opacity = Math.max(0, t.life / 0.12);
      if (t.life <= 0) {
        this.scene.remove(t.line);
        t.line.geometry.dispose();
        this.tracers.splice(i, 1);
      }
    }
    for (let i = this.flashes.length - 1; i >= 0; i--) {
      const f = this.flashes[i]!;
      f.life -= dt;
      if (f.life <= 0) {
        this.scene.remove(f.light);
        this.flashes.splice(i, 1);
      }
    }
  }

  render(): void {
    this.renderer.render(this.scene, this.camera);
  }
}

const standard = (color: number, extra: Partial<MeshStandardMaterial> = {}) =>
  new MeshStandardMaterial({ color, roughness: 0.6, metalness: 0.1, ...extra });

export function playerMesh(): Group {
  const group = new Group();
  const body = new Mesh(new CapsuleGeometry(0.3, 0.6, 6, 12), standard(0x4ade80));
  body.position.y = 0.65;
  body.castShadow = true;
  const visor = new Mesh(new BoxGeometry(0.34, 0.14, 0.1), standard(0x111827, { emissive: new Color(0x22d3ee), emissiveIntensity: 0.6 }));
  visor.position.set(0, 0.95, -0.28);
  const gun = new Mesh(new BoxGeometry(0.12, 0.12, 0.8), standard(0x374151, { metalness: 0.7, roughness: 0.4 }));
  gun.position.set(0.22, 0.7, -0.5);
  group.add(body, visor, gun);
  return group;
}

export function monsterMesh(kind: MonsterKind): Group {
  const group = new Group();
  if (kind === MONSTER_KINDS.Crawler) {
    const body = new Mesh(new SphereGeometry(0.35, 14, 10), standard(0x3fd16a, { emissive: new Color(0x0a4020), emissiveIntensity: 0.5 }));
    body.position.y = 0.35;
    body.scale.y = 0.7;
    body.castShadow = true;
    group.add(body);
    for (const side of [-1, 1]) {
      const eye = new Mesh(new SphereGeometry(0.08, 8, 6), standard(0x111111, { emissive: new Color(0xffee88), emissiveIntensity: 1.5 }));
      eye.position.set(side * 0.14, 0.42, -0.28);
      group.add(eye);
    }
  } else if (kind === MONSTER_KINDS.Brute) {
    const body = new Mesh(new BoxGeometry(1.0, 1.3, 0.9), standard(0xb91c1c, { roughness: 0.8 }));
    body.position.y = 0.65;
    body.castShadow = true;
    const head = new Mesh(new SphereGeometry(0.32, 12, 8), standard(0x7f1d1d));
    head.position.set(0, 1.45, -0.1);
    const eye = new Mesh(new SphereGeometry(0.1, 8, 6), standard(0x111111, { emissive: new Color(0xff4040), emissiveIntensity: 2 }));
    eye.position.set(0, 1.5, -0.4);
    group.add(body, head, eye);
  } else {
    const body = new Mesh(new ConeGeometry(0.4, 1.2, 10), standard(0x8b5cf6, { emissive: new Color(0x2e1065), emissiveIntensity: 0.6 }));
    body.position.y = 0.6;
    body.castShadow = true;
    const maw = new Mesh(new SphereGeometry(0.16, 8, 6), standard(0x111111, { emissive: new Color(0xd8b4fe), emissiveIntensity: 1.5 }));
    maw.position.set(0, 0.5, -0.32);
    group.add(body, maw);
  }
  return group;
}

export function crateMesh(tint: readonly [number, number, number]): Mesh {
  const mesh = new Mesh(new BoxGeometry(0.98, 0.98, 0.98), standard(new Color(...tint).getHex(), { roughness: 0.85 }));
  mesh.position.y = 0.49;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

export function doorMesh(mesh: LiminalMesh): Mesh {
  const geometry = toBufferGeometry(mesh);
  const material = toMaterial(mesh.material, { library: MATERIALS, fallbackColor: 0xe0a020 });
  material.emissive = new Color(0x402800);
  material.emissiveIntensity = 0.4;
  const object = new Mesh(geometry, material);
  object.castShadow = true;
  object.receiveShadow = true;
  return object;
}

export function plateMesh(): Mesh {
  const mesh = new Mesh(new BoxGeometry(0.96, 0.08, 0.96), standard(0x60a5fa, { emissive: new Color(0x1d4ed8), emissiveIntensity: 0.3 }));
  mesh.position.y = 0.04;
  mesh.receiveShadow = true;
  return mesh;
}

export function pickupMesh(kind: 'health' | 'ammo'): Group {
  const group = new Group();
  if (kind === 'health') {
    const base = new Mesh(new BoxGeometry(0.5, 0.5, 0.5), standard(0xf8fafc));
    const barV = new Mesh(new BoxGeometry(0.14, 0.36, 0.52), standard(0xef4444, { emissive: new Color(0x7f1d1d), emissiveIntensity: 0.6 }));
    const barH = new Mesh(new BoxGeometry(0.36, 0.14, 0.52), standard(0xef4444, { emissive: new Color(0x7f1d1d), emissiveIntensity: 0.6 }));
    group.add(base, barV, barH);
  } else {
    for (const x of [-0.16, 0, 0.16]) {
      const shell = new Mesh(new CylinderGeometry(0.07, 0.07, 0.42, 8), standard(0xdc2626));
      shell.position.x = x;
      const cap = new Mesh(new CylinderGeometry(0.075, 0.075, 0.1, 8), standard(0xfbbf24, { metalness: 0.8, roughness: 0.3 }));
      cap.position.set(x, -0.2, 0);
      group.add(shell, cap);
    }
  }
  group.children.forEach((c) => (c.castShadow = true));
  return group;
}

export function portalMesh(): Group {
  const group = new Group();
  const ring = new Mesh(new TorusGeometry(0.9, 0.08, 10, 40), standard(0x22d3ee, { emissive: new Color(0x22d3ee), emissiveIntensity: 1.2 }));
  ring.rotation.x = Math.PI / 2;
  ring.position.y = 0.08;
  const beam = new Mesh(
    new CylinderGeometry(0.1, 0.7, 3.5, 16, 1, true),
    new MeshStandardMaterial({ color: 0x22d3ee, emissive: new Color(0x22d3ee), emissiveIntensity: 0.8, transparent: true, opacity: 0.25, depthWrite: false }),
  );
  beam.position.y = 1.75;
  const light = new PointLight(0x22d3ee, 6, 10, 2);
  light.position.y = 1.2;
  group.add(ring, beam, light);
  return group;
}

export function spitMesh(): Mesh {
  const mesh = new Mesh(new SphereGeometry(0.16, 8, 6), standard(0xd8b4fe, { emissive: new Color(0xa855f7), emissiveIntensity: 2 }));
  return mesh;
}

export function waypointMarker(): Mesh {
  const mesh = new Mesh(new SphereGeometry(0.08, 6, 4), standard(0xa78bfa, { emissive: new Color(0x7c3aed), emissiveIntensity: 0.6 }));
  mesh.position.y = 0.1;
  return mesh;
}
