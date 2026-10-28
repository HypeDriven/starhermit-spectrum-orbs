// The kinetic sculpture gallery on starhermit:scene, as the browser build's
// js/render.js drew it with three.js r160: the theme's sky and fog, the
// terrazzo floor disc and its accent ring, the curved back wall of panels
// (with HDR light strips between them, a warm pool of light under the row and
// slowly spinning sculpture mobiles when Gallery detail is detailed), and the
// tube row: pedestal, open glass tube, rim and base disc, contact blob and the
// grounded marker ring per tube; the orbs (lacquered spheres with their shape
// glyph as a camera-facing sprite and a back-side halo shell for the
// selection), the lift on selection, the lift–travel–drop arc of a move, the
// legal-target, hint and invalid markers, pooled spark bursts, drifting dust
// motes, the strips' shimmer, the pointer parallax and the event shake; the
// camera fitted by projection into the part of the playfield the HUD leaves
// uncovered (render.js _safeRect / _frameCamera through a view offset), with
// the Default / Close / Wide presets on critically damped springs.
//
// Graphics follow the runtime's quality tier (native/quality.ts: gfx.js's
// presets and budgets): Lambert / standard / physical materials, sphere
// segments, the floor texture size (baked offline: tools/bake-textures.mjs),
// panels, mobiles, sparks, motes, shadows, reflections, AO, bloom, the grade.
//
// From three.js r160 (physically based lights): colours as written, the
// hemisphere and directional lights' intensities ÷ π (the engine takes
// three's legacy units). render.js's `new RoomEnvironment(renderer)` (r160) is
// kept exactly; every lit material carries the environment as its own envMap
// at its envMapIntensity, as r160's scene.environment applied each material's
// intensity. The old composer (RenderPass in half floats → GTAO → UnrealBloom
// 0.5 / 0.4 / 0.88 → the grade + vignette → OutputPass with ACES at exposure
// 1.05 → SMAA / FXAA) is the runtime's renderer.ao / bloom / post / antialias;
// the grade is the old shader in WGSL as renderer.post, which the engine runs
// before bloom (the old one ran after it), on the same linear light.
//
// Gameplay tweens (the selection lift, the move arc, the invalid marker fade)
// advance on the runtime's fixed steps (tick), so a move lands on the same
// step main.ts settles it; ambient motion follows the frame time (update).
import {
  ACESFilmicToneMapping, AdditiveBlending, BackSide, BoxGeometry, BufferAttribute, BufferGeometry, CanvasTexture, CircleGeometry, Color,
  CylinderGeometry, DirectionalLight, DoubleSide, Fog, Group, HemisphereLight, IcosahedronGeometry, InstancedMesh, Matrix4, Mesh,
  MeshBasicMaterial, MeshLambertMaterial, MeshPhysicalMaterial, MeshStandardMaterial, Object3D, PerspectiveCamera, PMREMGenerator, Points,
  PointsMaterial, RepeatWrapping, RingGeometry, RoomEnvironment, SphereGeometry, Sprite, SpriteMaterial, SRGBColorSpace, TextureLoader,
  TorusGeometry, Vector2, Vector3, pointerToNdc, renderer, scene, type Material, type Texture,
} from "starhermit:scene";
import { OffscreenCanvas } from "starhermit:canvas";
import type { Color as OrbColor, RandomStream, RuleEvent, State, Theme } from "./classic.ts";
import { MOTE_MAX, SPARK_MAX, sparkCap, type Look } from "./quality.ts";

export interface Rect { x: number; y: number; width: number; height: number }

/** render.js FRAMING. */
const FRAMING = {
  fov: 34, pitchDeg: 40, heightPerCapacity: 0.34, lookAheadY: 0.55,
  presets: {
    default: { yaw: 0, dist: 1.0, height: 1.0 },
    close: { yaw: 0, dist: 0.82, height: 0.9 },
    wide: { yaw: 0, dist: 1.2, height: 1.12 },
  } as Record<string, { yaw: number; dist: number; height: number }>,
};
const ORB_R = 0.155;
const TUBE_R = 0.21;
const TUBE_SPACING = 0.92;
const ARC_DEPTH = 0.055;

/** render.js GradeShader (S-curve 0.22, saturation 1.1, cool shadows / warm highlights, vignette 0.26) on the clamped linear light. */
const GRADE = {
  pixel: /* wgsl */ `
fn pixel(p: Pixel) -> vec4f {
  let src = scene_color(p.uv);
  var c = clamp(src.rgb, vec3f(0.0), vec3f(1.0));
  var s = mix(c, c * c * (vec3f(3.0) - 2.0 * c), 0.22);
  let l = dot(s, vec3f(0.299, 0.587, 0.114));
  s = mix(vec3f(l), s, 1.1);
  s = s * mix(vec3f(0.97, 0.99, 1.05), vec3f(1.04, 1.0, 0.97), smoothstep(0.15, 0.8, l));
  c = mix(c, s, 1.0);
  let d = length((p.uv - vec2f(0.5)) * vec2f(1.15, 1.0));
  c = c * (1.0 - 0.26 * smoothstep(0.38, 0.9, d));
  return vec4f(c, src.a);
}`,
};

const easeOutCubic = (t: number): number => 1 - Math.pow(1 - t, 3);
const easeInOutQuad = (t: number): number => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);

/** render.js Spring: critically damped, interruptible. */
class Spring {
  v = 0; target: number;
  constructor(public x: number, private s: number) { this.target = x; }
  set(t: number): void { this.target = t; }
  snap(t: number): void { this.x = t; this.v = 0; this.target = t; }
  update(dt: number): number {
    const omega = 2 / this.s;
    const a = -omega * omega * (this.x - this.target) - 2 * omega * this.v;
    this.v += a * dt;
    this.x += this.v * dt;
    return this.x;
  }
}

interface Tween { update(dt: number): boolean; finish(): void }

// ---------- state ----------
let look: Look | null = null;
let reducedMotion = false;
let envTex: Texture | null = null;
let theme: Theme | null = null;
let palette: OrbColor[] = [];
let decor: RandomStream = { float: () => 0.5, int: (a: number) => a };
let curState: State | null = null;
let selected = -1;
let hint: { from: number; to: number } | null = null;
let tweens: Tween[] = [];
let shakeAmp = 0;
let elapsed = 0;
let cameraPreset = "default";
const pointer = { x: 0, y: 0 };

const camera = new PerspectiveCamera(FRAMING.fov, 1, 0.1, 100);
const springs = { yaw: new Spring(0, 0.25), dist: new Spring(4.5, 0.3), height: new Spring(1, 0.3), lookY: new Spring(FRAMING.lookAheadY, 0.3) };

let envGroup = new Group();
let boardGroup = new Group();
let ghostGroup = new Group();
const fxGroup = new Group();
scene.add(envGroup, boardGroup, ghostGroup, fxGroup);

let hemi: HemisphereLight | null = null;
let keyLight: DirectionalLight | null = null;
let shimmer: { mat: MeshStandardMaterial | MeshLambertMaterial; base: number; amp: number; speed: number }[] = [];
let spinners: Object3D[] = [];

let orbMeshes: Mesh[][] = [];
let tubeGroups: Group[] = [];
let markers: Mesh[] = [];
let tubeH = 2;

/** Every lit material made (for the environment applied later). */
const litMats = new Set<MeshStandardMaterial>();

// ---------- textures ----------
let radialTex: Texture | null = null;
function radialTexture(): Texture {
  if (radialTex) return radialTex;
  const c = new OffscreenCanvas(128, 128);
  const ctx = c.getContext("2d")!;
  const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  g.addColorStop(0, "rgba(255,255,255,1)");
  g.addColorStop(0.45, "rgba(255,255,255,0.45)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 128);
  const tex = new CanvasTexture(c);
  tex.colorSpace = SRGBColorSpace;
  radialTex = tex;
  return tex;
}
const glyphTex = new Map<string, Texture>();
/** render.js _glyphTexture: the colour's shape glyph, white, on a 128 px canvas. */
function glyphTexture(def: OrbColor): Texture {
  const hit = glyphTex.get(def.glyph);
  if (hit) return hit;
  const c = new OffscreenCanvas(128, 128);
  const ctx = c.getContext("2d")!;
  ctx.clearRect(0, 0, 128, 128);
  ctx.fillStyle = "rgba(255,255,255,0.92)";
  ctx.font = "64px sans-serif";
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.fillText(def.glyph, 64, 68);
  const tex = new CanvasTexture(c);
  tex.colorSpace = SRGBColorSpace;
  glyphTex.set(def.glyph, tex);
  return tex;
}
const floorTex = new Map<number, Texture>();
const loader = new TextureLoader();
function floorTexture(n: number): Texture {
  const hit = floorTex.get(n);
  if (hit) return hit;
  const tex = loader.load(`assets/terrazzo-${n}.png`, undefined, undefined, (e: unknown) => console.warn(`floor: ${e instanceof Error ? e.message : String(e)}`));
  tex.wrapS = tex.wrapT = RepeatWrapping;
  tex.repeat.set(6, 6);
  tex.anisotropy = 4;
  tex.colorSpace = SRGBColorSpace;
  floorTex.set(n, tex);
  return tex;
}
function environmentTexture(): Texture | null {
  if (!envTex) {
    try {
      const pmrem = new PMREMGenerator(renderer);
      envTex = pmrem.fromScene(new RoomEnvironment(renderer), 0.04).texture;
    } catch (e) { console.warn(`environment: ${String(e)}`); }
  }
  return envTex;
}
/** r160 scene.environment at each material's envMapIntensity (Reflections on). */
function applyEnv(list: Iterable<MeshStandardMaterial>): void {
  const env = look?.reflections ? environmentTexture() : null;
  for (const m of list) if (m.envMap !== env) m.envMap = env;
}

// ---------- materials (render.js _lit) ----------
type Params = Record<string, unknown>;
/** Physical on High / Ultra, the same without clearcoat / IOR as standard on Balanced, Lambert (colour, maps, transparency, emission) on Low. */
function lit(params: Params): MeshStandardMaterial | MeshLambertMaterial {
  const tier = look?.budget.material ?? "standard";
  if (tier === "physical") { const m = new MeshPhysicalMaterial(params as ConstructorParameters<typeof MeshPhysicalMaterial>[0]); litMats.add(m); applyEnv([m]); return m; }
  const std: Params = {};
  for (const [k, v] of Object.entries(params)) if (!/^(clearcoat|ior|sheen)/.test(k)) std[k] = v;
  if (tier === "standard") { const m = new MeshStandardMaterial(std as ConstructorParameters<typeof MeshStandardMaterial>[0]); litMats.add(m); applyEnv([m]); return m; }
  const lam: Params = {};
  for (const [k, v] of Object.entries(std)) if (!/^(roughness|metalness|envMapIntensity)$/.test(k)) lam[k] = v;
  return new MeshLambertMaterial(lam as ConstructorParameters<typeof MeshLambertMaterial>[0]);
}

function disposeGroup(g: Object3D): void {
  g.traverse((o) => {
    const m = o as Mesh;
    if (m.geometry) m.geometry.dispose();
    const mats = (m as { material?: Material | Material[] }).material;
    if (mats) for (const mm of Array.isArray(mats) ? mats : [mats]) { litMats.delete(mm as MeshStandardMaterial); mm.dispose(); }
  });
}

// ---------- the environment (render.js _buildEnvironment) ----------
function buildEnvironment(): void {
  disposeGroup(envGroup);
  scene.remove(envGroup);
  envGroup = new Group();
  scene.add(envGroup);
  spinners = []; shimmer = [];
  const t = theme!;
  const detailed = !!look?.detailed;
  scene.background = new Color(t.sky);
  scene.fog = new Fog(t.fog, 14, 42);

  hemi = new HemisphereLight(t.hemiSky, t.hemiGround, 0.85 / Math.PI);
  envGroup.add(hemi);
  const key = new DirectionalLight(t.keyLight, t.keyIntensity / Math.PI);
  key.position.set(4.5, 8, 5);
  key.shadow.bias = -0.0004;
  key.shadow.normalBias = 1; // three's 0.02 world units; the engine's normal bias is in texels
  envGroup.add(key, key.target);
  keyLight = key;
  const rim = new DirectionalLight(t.hemiSky, 0.5 / Math.PI);
  rim.position.set(-6, 4, -4);
  envGroup.add(rim);

  const floorMat = lit({ color: t.floor, roughness: 0.85, metalness: 0.05 });
  if (detailed) {
    const tex = floorTexture(look!.budget.floorTex);
    floorMat.map = tex;
    if (floorMat instanceof MeshStandardMaterial) { floorMat.roughnessMap = tex; floorMat.roughness = 0.9; floorMat.envMapIntensity = 0.12; }
    floorMat.color = new Color(t.floor).multiplyScalar(1.12);
  }
  const floor = new Mesh(new CylinderGeometry(16, 16, 0.3, 48), floorMat);
  floor.position.y = -0.15;
  floor.receiveShadow = true;
  envGroup.add(floor);
  const ring = new Mesh(new TorusGeometry(5.2, 0.05, 8, 64), lit({ color: t.floorAccent, roughness: 0.7 }));
  ring.rotation.x = Math.PI / 2; ring.position.y = 0.01;
  envGroup.add(ring);

  const panelCount = detailed ? look!.budget.panels : 5;
  const panels = new InstancedMesh(new BoxGeometry(1.6, 5.5, 0.18), lit({ color: t.wall, roughness: 0.8 }), panelCount);
  const m = new Matrix4();
  const panelAt = (i: number): number => (i / (panelCount - 1) - 0.5) * Math.PI * 0.9;
  for (let i = 0; i < panelCount; i++) {
    const a = panelAt(i);
    m.makeRotationY(-a);
    m.setPosition(Math.sin(a) * 12, 2.6, -Math.cos(a) * 12 - 2);
    panels.setMatrixAt(i, m);
  }
  panels.instanceMatrix.needsUpdate = true;
  envGroup.add(panels);

  if (detailed) {
    const stripMat = lit({ color: 0x000000, emissive: new Color(t.keyLight), emissiveIntensity: 2.2, roughness: 1 });
    const seams: number[] = [];
    for (let i = 0; i < panelCount - 1; i++) {
      const a = (panelAt(i) + panelAt(i + 1)) / 2;
      if (Math.abs(a) > 0.2) seams.push(a);
    }
    const strips = new InstancedMesh(new BoxGeometry(0.06, 2.0, 0.06), stripMat, seams.length);
    seams.forEach((a, i) => {
      m.makeRotationY(-a);
      m.setPosition(Math.sin(a) * 11.9, 4.25, -Math.cos(a) * 11.9 - 2);
      strips.setMatrixAt(i, m);
    });
    strips.instanceMatrix.needsUpdate = true;
    envGroup.add(strips);
    shimmer.push({ mat: stripMat, base: 2.2, amp: 0.35, speed: 0.7 });

    const pool = new Mesh(new CircleGeometry(4.6, 48), new MeshBasicMaterial({
      map: radialTexture(), color: new Color(t.keyLight), transparent: true, opacity: 0.13, depthWrite: false, blending: AdditiveBlending, fog: false,
    }));
    pool.rotation.x = -Math.PI / 2;
    pool.position.y = 0.006;
    pool.renderOrder = -1;
    envGroup.add(pool);

    const count = look!.budget.mobiles;
    for (let i = 0; i < count; i++) {
      const mobile = new Group();
      const arm = new Mesh(new CylinderGeometry(0.015, 0.015, 1.6, 6), lit({ color: t.pedestal, roughness: 0.35, metalness: 0.7 }));
      arm.rotation.z = Math.PI / 2;
      mobile.add(arm);
      for (const side of [-0.8, 0.8]) {
        const drop = new Mesh(new IcosahedronGeometry(0.09 + decor.float() * 0.06, 0),
          lit({ color: new Color(t.keyLight).multiplyScalar(0.9), roughness: 0.22, metalness: 0.85 }));
        drop.position.set(side, -0.45 - decor.float() * 0.25, 0);
        mobile.add(drop);
      }
      mobile.position.set((i - (count - 1) / 2) * 3.4, 4.4 + decor.float() * 0.6, -3.5 - i * 0.7);
      mobile.userData.spinSpeed = 0.12 + decor.float() * 0.15;
      spinners.push(mobile);
      envGroup.add(mobile);
    }
  }
  motes.material.color.set(t.keyLight);
  applyShadows();
  applyReflections();
}

// ---------- the board (render.js _rebuildBoard) ----------
function tubePositions(count: number): Vector3[] {
  const mid = (count - 1) / 2;
  return Array.from({ length: count }, (_, i) => new Vector3((i - mid) * TUBE_SPACING, 0, -Math.abs(i - mid) * ARC_DEPTH));
}
const orbRestY = (j: number): number => 0.55 + ORB_R + j * (ORB_R * 2 + 0.015);

function rebuildBoard(state: State): void {
  curState = state;
  selected = -1;
  finishTweens();
  disposeGroup(boardGroup); disposeGroup(ghostGroup);
  scene.remove(boardGroup, ghostGroup);
  boardGroup = new Group(); ghostGroup = new Group();
  scene.add(boardGroup, ghostGroup);
  orbMeshes = []; tubeGroups = []; markers = [];
  const n = state.tubes.length, cap = state.capacity;
  tubeH = 0.32 + cap * (ORB_R * 2 + 0.015);
  const positions = tubePositions(n);
  const t = theme!;
  const detailed = !!look?.detailed;
  const glass = detailed
    ? lit({ color: 0xdfe8f0, transparent: true, opacity: 0.14, roughness: 0.05, metalness: 0, side: DoubleSide, depthWrite: false, ior: 1.5, envMapIntensity: 0.35 })
    : lit({ color: 0xdfe8f0, transparent: true, opacity: 0.16, roughness: 0.08, metalness: 0, side: DoubleSide, depthWrite: false, envMapIntensity: 0.35 });
  const rimMat = lit({ color: t.pedestal, roughness: 0.3, metalness: 0.6, envMapIntensity: 0.6 });
  const baseMat = detailed
    ? lit({ color: t.pedestal, roughness: 0.45, metalness: 0.3, clearcoat: 0.5, clearcoatRoughness: 0.3, envMapIntensity: 0.4 })
    : lit({ color: t.pedestal, roughness: 0.5, metalness: 0.3, envMapIntensity: 0.4 });
  for (let i = 0; i < n; i++) {
    const g = new Group();
    g.position.copy(positions[i]!);
    const ped = new Mesh(new CylinderGeometry(0.3, 0.36, 0.5, 20), baseMat);
    ped.position.y = 0.25;
    ped.castShadow = true; ped.receiveShadow = true;
    g.add(ped);
    const tube = new Mesh(new CylinderGeometry(TUBE_R, TUBE_R, tubeH, 24, 1, true), glass);
    tube.position.y = 0.5 + tubeH / 2;
    tube.noAO = true;
    g.add(tube);
    const rim = new Mesh(new TorusGeometry(TUBE_R, 0.022, 10, 28), rimMat);
    rim.rotation.x = Math.PI / 2;
    rim.position.y = 0.5 + tubeH;
    g.add(rim);
    const baseDisc = new Mesh(new CylinderGeometry(TUBE_R + 0.02, TUBE_R + 0.05, 0.05, 24), rimMat);
    baseDisc.position.y = 0.52;
    g.add(baseDisc);
    const blob = new Mesh(new CircleGeometry(0.42, 24), new MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.28, depthWrite: false }));
    blob.rotation.x = -Math.PI / 2;
    blob.position.y = 0.012;
    blob.noAO = true;
    g.add(blob);
    const marker = new Mesh(new RingGeometry(0.3, 0.4, 28),
      new MeshBasicMaterial({ color: 0x7dffa8, transparent: true, opacity: 0, side: DoubleSide, depthWrite: false }));
    marker.rotation.x = -Math.PI / 2;
    marker.position.copy(positions[i]!).setY(0.015);
    marker.noAO = true;
    ghostGroup.add(marker);
    markers.push(marker);
    boardGroup.add(g);
    tubeGroups.push(g);
    orbMeshes.push([]);
  }
  applyShadows();
  syncState(state);
}

const orbGeo = new Map<number, SphereGeometry>();
const haloGeo = new SphereGeometry(ORB_R * 1.18, 20, 14);
function makeOrb(colorIdx: number): Mesh {
  const def = palette[colorIdx];
  const color = new Color(def ? def.hex : "#ffffff");
  const mat = look?.detailed
    ? lit({ color, roughness: 0.3, metalness: 0.08, clearcoat: 1, clearcoatRoughness: 0.08, envMapIntensity: 0.55, emissive: new Color(0, 0, 0) })
    : lit({ color, roughness: 0.32, metalness: 0.12, envMapIntensity: 0.55, emissive: new Color(0, 0, 0) });
  const seg = look?.budget.orbSeg ?? 24;
  let geo = orbGeo.get(seg);
  if (!geo) { geo = new SphereGeometry(ORB_R, seg, Math.round(seg * 0.75)); orbGeo.set(seg, geo); }
  const mesh = new Mesh(geo, mat);
  mesh.castShadow = true;
  if (def) {
    const sprite = new Sprite(new SpriteMaterial({ map: glyphTexture(def), transparent: true, depthWrite: false, opacity: 0.95 }));
    sprite.scale.set(0.16, 0.16, 1);
    sprite.position.set(0, 0.02, ORB_R * 0.72);
    mesh.add(sprite);
  }
  const halo = new Mesh(haloGeo, new MeshBasicMaterial({ color: 0xffffff, side: BackSide, transparent: true, opacity: 0 }));
  halo.noAO = true;
  mesh.add(halo);
  mesh.userData.halo = halo;
  return mesh;
}
function disposeOrb(m: Mesh): void {
  for (const c of [...m.children]) { const cm = c as Mesh; (cm.material as Material).dispose(); }
  litMats.delete(m.material as MeshStandardMaterial);
  (m.material as Material).dispose();
}

/** Exact placement from the rules state (also the skip path). */
export function syncState(state: State): void {
  curState = state;
  for (let i = 0; i < state.tubes.length; i++) {
    const stack = state.tubes[i]!;
    const meshes = orbMeshes[i]!;
    while (meshes.length > stack.length) { const m = meshes.pop()!; m.parent?.remove(m); disposeOrb(m); }
    while (meshes.length < stack.length) { const m = makeOrb(stack[meshes.length]!); tubeGroups[i]!.add(m); meshes.push(m); }
    for (let j = 0; j < meshes.length; j++) { meshes[j]!.position.set(0, orbRestY(j), 0); meshes[j]!.scale.setScalar(1); }
  }
  applySelection();
}

// ---------- selection, markers, moves ----------
function tween(obj: Record<string, number>, props: Record<string, number>, dur: number, ease: (k: number) => number, onDone?: () => void): void {
  if (reducedMotion || dur <= 0) { Object.assign(obj, props); onDone?.(); return; }
  const from: Record<string, number> = {};
  for (const k of Object.keys(props)) from[k] = obj[k]!;
  let t = 0;
  tweens.push({
    update: (dt) => {
      t += dt / dur;
      const k = ease(Math.min(1, t));
      for (const key of Object.keys(props)) obj[key] = from[key]! + (props[key]! - from[key]!) * k;
      if (t >= 1) { onDone?.(); return false; }
      return true;
    },
    finish: () => { Object.assign(obj, props); onDone?.(); },
  });
}
function finishTweens(): void { const p = tweens; tweens = []; for (const tw of p) tw.finish(); }

function applySelection(): void {
  for (let i = 0; i < orbMeshes.length; i++) {
    const meshes = orbMeshes[i]!;
    if (!meshes.length) continue;
    const top = meshes[meshes.length - 1]!;
    const isSel = i === selected;
    tween(top.position as unknown as Record<string, number>, { y: orbRestY(meshes.length - 1) + (isSel ? 0.34 : 0) }, 0.18, easeOutCubic);
    ((top.userData.halo as Mesh).material as MeshBasicMaterial).opacity = isSel ? 0.85 : 0;
    const mat = top.material as MeshStandardMaterial;
    mat.emissive = mat.color.clone().multiplyScalar(isSel ? 0.45 : 0);
  }
}
export function select(i: number): void { selected = i; applySelection(); }
/** render.js previewTargets: the legal targets of a lifted tube glow green (null clears). */
export function previewTargets(actions: { from: number; to: number }[] | null, fromTube = -1): void {
  for (const m of markers) { const mm = m.material as MeshBasicMaterial; mm.opacity = 0; mm.color.set(0x7dffa8); }
  if (!actions) return;
  for (const a of actions) if (a.from === fromTube && markers[a.to]) (markers[a.to]!.material as MeshBasicMaterial).opacity = 0.55;
}
export function setHint(h: { from: number; to: number } | null): void {
  hint = h;
  for (const m of markers) (m.material as MeshBasicMaterial).opacity = 0;
  if (h) for (const idx of [h.from, h.to]) {
    const mm = markers[idx]?.material as MeshBasicMaterial | undefined;
    if (mm) { mm.color.set(0x8ecfff); mm.opacity = 0.7; }
  }
}
/** Red flash on the tube's marker + a low shake. */
export function invalidFeedback(i: number): void {
  const marker = markers[i];
  if (!marker) return;
  const mm = marker.material as MeshBasicMaterial;
  mm.color.set(0xff6a5e);
  mm.opacity = 0.8;
  tween(mm as unknown as Record<string, number>, { opacity: 0 }, 0.5, easeOutCubic, () => mm.color.set(0x7dffa8));
  if (!reducedMotion) shakeAmp = Math.max(shakeAmp, 0.012);
}
/** The lift → travel → drop arc of a committed move (0.42 s; the move is the rules state's at once). */
export function animateMove(evt: RuleEvent): void {
  const fromMeshes = orbMeshes[evt.from!], toMeshes = orbMeshes[evt.to!];
  if (!fromMeshes || !toMeshes) return;
  const orb = fromMeshes.pop();
  if (!orb) return;
  toMeshes.push(orb);
  const fromG = tubeGroups[evt.from!]!, toG = tubeGroups[evt.to!]!;
  const startW = new Vector3(fromG.position.x, orb.position.y, fromG.position.z);
  fromG.remove(orb);
  toG.add(orb);
  const target = toMeshes.length - 1;
  const rest = (): void => { orb.position.set(0, orbRestY(target), 0); };
  if (reducedMotion) { rest(); return; }
  const liftY = tubeH + 0.95, dur = 0.42;
  const endW = new Vector3(toG.position.x, orbRestY(target), toG.position.z);
  const top0 = new Vector3(fromG.position.x, liftY, fromG.position.z), top1 = new Vector3(toG.position.x, liftY, toG.position.z);
  let t = 0;
  const w = new Vector3();
  tweens.push({
    update: (dt) => {
      t += dt / dur;
      const k = Math.min(1, t);
      if (k < 0.35) { const u = easeOutCubic(k / 0.35); w.copy(startW); w.y += (liftY - startW.y) * u; }
      else if (k < 0.8) w.copy(top0).lerp(top1, easeInOutQuad((k - 0.35) / 0.45));
      else w.copy(top1).lerp(endW, easeInOutQuad((k - 0.8) / 0.2));
      orb.position.set(w.x - toG.position.x, w.y, w.z - toG.position.z);
      if (k >= 1) { rest(); return false; }
      return true;
    },
    finish: rest,
  });
}

// ---------- sparks and motes ----------
interface Spark { alive: boolean; i: number; pos: Vector3; vel: Vector3; life: number; maxLife: number; color: Color }
const pPos = new Float32Array(SPARK_MAX * 3), pCol = new Float32Array(SPARK_MAX * 3);
const sparkGeo = new BufferGeometry();
sparkGeo.setAttribute("position", new BufferAttribute(pPos, 3));
sparkGeo.setAttribute("color", new BufferAttribute(pCol, 3));
const sparks = new Points(sparkGeo, new PointsMaterial({
  size: 0.07, vertexColors: true, transparent: true, opacity: 0.95, depthWrite: false, map: radialTexture(), blending: AdditiveBlending,
}));
sparks.frustumCulled = false;
fxGroup.add(sparks);
const pool: Spark[] = [];
for (let i = 0; i < SPARK_MAX; i++) {
  pool.push({ alive: false, i, pos: new Vector3(), vel: new Vector3(), life: 0, maxLife: 1, color: new Color() });
  pPos[i * 3 + 1] = -100;
}
let fxRand = 0x5eed;
/** The bursts' scatter (render.js used Math.random: cosmetic only; a fixed stream keeps checks repeatable). */
function rnd(): number { fxRand = (fxRand * 16807) % 2147483647; return fxRand / 2147483647; }
/** render.js burst: pooled sparks from a tube's mouth (bounded by the tier). */
export function burst(tube: number, hex: string, count: number, big: boolean): void {
  if (!look) return;
  const budget = sparkCap(look);
  if (reducedMotion || budget === 0) return;
  const pos = tubeGroups[tube]?.position ?? new Vector3();
  const alive = pool.filter((p) => p.alive).length;
  const n = Math.min(look.particles === "high" ? count : Math.ceil(count / 2), budget - alive);
  const color = new Color(hex);
  for (let k = 0; k < n; k++) {
    const p = pool.find((q) => !q.alive && q.i < budget);
    if (!p) break;
    p.alive = true;
    p.pos.set(pos.x, tubeH + 0.4, pos.z);
    const a = rnd() * Math.PI * 2;
    const sp = (big ? 2.2 : 1.2) * (0.5 + rnd());
    p.vel.set(Math.cos(a) * sp * 0.5, 1.2 + rnd() * (big ? 2.4 : 1.2), Math.sin(a) * sp * 0.5);
    p.life = p.maxLife = big ? 1.4 : 0.8;
    p.color.copy(color);
  }
}
function updateSparks(dt: number): void {
  let any = false;
  for (const p of pool) {
    if (!p.alive) continue;
    any = true;
    p.life -= dt;
    if (p.life <= 0) { p.alive = false; pPos[p.i * 3 + 1] = -100; continue; }
    p.vel.y -= 4.5 * dt;
    p.pos.addScaledVector(p.vel, dt);
    pPos[p.i * 3] = p.pos.x; pPos[p.i * 3 + 1] = p.pos.y; pPos[p.i * 3 + 2] = p.pos.z;
    const k = (p.life / p.maxLife) * 1.5;
    pCol[p.i * 3] = p.color.r * k; pCol[p.i * 3 + 1] = p.color.g * k; pCol[p.i * 3 + 2] = p.color.b * k;
  }
  if (any) { (sparkGeo.attributes.position as BufferAttribute).needsUpdate = true; (sparkGeo.attributes.color as BufferAttribute).needsUpdate = true; }
}
/** render.js celebrate: a burst from every tube and a settle shake. */
export function celebrate(): void {
  for (let i = 0; i < tubeGroups.length; i++) {
    const tube = curState?.tubes[i];
    const top = tube && tube.length ? tube[tube.length - 1]! : 0;
    burst(i, palette[top]?.hex ?? "#ffffff", 40, true);
  }
  if (!reducedMotion) shakeAmp = Math.max(shakeAmp, 0.03);
}
export function clearSparks(): void {
  for (const p of pool) if (p.alive) { p.alive = false; pPos[p.i * 3 + 1] = -100; }
  (sparkGeo.attributes.position as BufferAttribute).needsUpdate = true;
}

const motePos = new Float32Array(MOTE_MAX * 3);
{
  let seed = 7;
  const r = (): number => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  for (let i = 0; i < MOTE_MAX; i++) { motePos[i * 3] = (r() - 0.5) * 9; motePos[i * 3 + 1] = r() * 5; motePos[i * 3 + 2] = (r() - 0.5) * 5 - 0.8; }
}
const moteGeo = new BufferGeometry();
moteGeo.setAttribute("position", new BufferAttribute(motePos, 3));
const motes = new Points(moteGeo, new PointsMaterial({
  size: 0.035, map: radialTexture(), color: 0xffe0b8, transparent: true, opacity: 0.35, depthWrite: false, blending: AdditiveBlending,
}));
motes.frustumCulled = false;
motes.visible = false;
fxGroup.add(motes);
function updateMotes(dt: number): void {
  if (!motes.visible || !look) return;
  const live = Math.min(MOTE_MAX, look.budget.motes) * 3;
  for (let i = 0; i < live; i += 3) {
    motePos[i + 1] = motePos[i + 1]! + dt * (0.05 + (i % 7) * 0.008);
    motePos[i] = motePos[i]! + Math.sin(elapsed * 0.3 + i) * dt * 0.03;
    if (motePos[i + 1]! > 5) motePos[i + 1] = 0;
  }
  (moteGeo.attributes.position as BufferAttribute).needsUpdate = true;
}

// ---------- shadows, reflections, graphics ----------
function applyShadows(): void {
  const size = look?.shadows ?? 0;
  renderer.shadowMap.enabled = size > 0;
  if (keyLight) {
    keyLight.castShadow = size > 0;
    if (size > 0) keyLight.shadow.mapSize = size;
  }
}
function applyReflections(): void {
  const on = !!look?.reflections;
  applyEnv(litMats);
  // with image-based lighting the hemisphere fill is partly redundant
  if (hemi) hemi.intensity = (on && envTex ? 0.45 : 0.85) / Math.PI;
}
const assetsKey = (l: Look | null): string => (l ? [l.detailed, l.budget.material, l.budget.orbSeg, l.budget.floorTex, l.budget.panels, l.budget.mobiles].join("|") : "");
/** The runtime's quality tier applied live (render.js setGraphics). */
export function applyLook(next: Look): void {
  if (look && JSON.stringify(look) === JSON.stringify(next)) return;
  const prev = assetsKey(look);
  look = next;
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  const hi = next.ao === "high";
  renderer.ao = next.ao === "off" ? null : {
    blendIntensity: 0.75, radius: 0.35, distanceExponent: 1.4, thickness: 1.2, scale: 1, samples: hi ? 16 : 8, resolution: next.budget.aoRes,
    denoise: { lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: hi ? 6 : 4, rings: 2, samples: hi ? 16 : 8 },
  };
  // UnrealBloomPass(0.5, 0.4, 0.88): only emissive strips, the selection glow and specular highlights bloom
  renderer.bloom = next.bloom ? { strength: 0.5, radius: 0.4, threshold: 0.88, resolution: next.budget.bloomRes } : null;
  renderer.post = next.grade ? GRADE : null;
  renderer.grade = null;
  renderer.antialias = next.antialias;
  motes.visible = next.animated;
  moteGeo.setDrawRange(0, next.budget.motes);
  sparkGeo.setDrawRange(0, sparkCap(next));
  applyShadows();
  if (theme && assetsKey(next) !== prev) {
    buildEnvironment();
    if (curState) { const sel = selected, h = hint; rebuildBoard(curState); select(sel); if (h) setHint(h); }
  } else applyReflections();
}
export function setReducedMotion(v: boolean): void { reducedMotion = v; if (v) skipAnimations(); }
export function skipAnimations(): void { finishTweens(); if (curState) syncState(curState); shakeAmp = 0; }
export function setPointer(x: number, y: number): void { pointer.x = x; pointer.y = y; }

/** render.js build: the scene for a level (theme, palette, the decoration stream). */
export function build(state: State, th: Theme, pal: OrbColor[], decorRng: RandomStream): void {
  theme = th; palette = pal; decor = decorRng;
  hint = null;
  clearSparks();
  buildEnvironment();
  rebuildBoard(state);
  frameCamera(true);
}
/** A palette change rebuilds the orbs on the current board. */
export function setPalette(pal: OrbColor[]): void {
  palette = pal;
  if (curState && theme) { const sel = selected, h = hint; rebuildBoard(curState); select(sel); if (h) setHint(h); }
}
export function setActive(on: boolean): void { renderer.camera = on ? camera : null; }

// ---------- camera ----------
export function setCameraPreset(name: string): void {
  if (FRAMING.presets[name]) { cameraPreset = name; frameCamera(false); }
}
export function resetCamera(): void { frameCamera(false); }
let win = { w: 1, h: 1 };
let view: Rect = { x: 0, y: 0, width: 1, height: 1 };
let frameKey = "";
let uiScale = 1;
function applyViewOffset(): void {
  const pad = 6 * uiScale;
  const sw = Math.max(1, view.width - pad * 2), sh = Math.max(1, view.height - pad * 2);
  camera.aspect = sw / sh;
  camera.setViewOffset(sw, sh, -(view.x + pad), -(view.y + pad), win.w, win.h);
  camera.updateProjectionMatrix();
}
const probe = new PerspectiveCamera(FRAMING.fov, 1, 0.1, 100);
function frameCamera(snap: boolean): void {
  const p = FRAMING.presets[cameraPreset] ?? FRAMING.presets.default!;
  const n = curState ? curState.tubes.length : 8;
  const cap = curState ? curState.capacity : 4;
  applyViewOffset();
  const halfW = ((n - 1) / 2) * TUBE_SPACING + 0.9;
  const th = 0.32 + cap * (ORB_R * 2 + 0.015);
  const pitch = (FRAMING.pitchDeg * Math.PI) / 180;
  const h = (2.6 + cap * FRAMING.heightPerCapacity) * p.height;
  const lookY = FRAMING.lookAheadY + th * 0.28;
  probe.aspect = camera.aspect || 1;
  probe.updateProjectionMatrix();
  const pts: Vector3[] = [];
  for (const x of [-halfW, halfW]) for (const y of [0, th + 1.35]) for (const z of [-0.6, 0.6]) pts.push(new Vector3(x, y, z));
  const v = new Vector3();
  let dist = 4.5 * p.dist;
  for (let i = 0; i < 14; i++) {
    probe.position.set(Math.sin(p.yaw) * dist * Math.cos(pitch), h, Math.cos(p.yaw) * dist * Math.cos(pitch));
    probe.lookAt(0, lookY, 0);
    probe.updateMatrixWorld();
    let over = 0;
    for (const q of pts) { v.copy(q).project(probe); over = Math.max(over, Math.abs(v.x) / 0.94, Math.abs(v.y) / 0.9); }
    if (over <= 1) break;
    dist *= Math.min(1.6, over + 0.02);
  }
  springs.dist.set(dist); springs.yaw.set(p.yaw); springs.height.set(p.height);
  if (snap) { springs.dist.snap(dist); springs.yaw.snap(p.yaw); springs.height.snap(p.height); }
  if (keyLight) keyLight.shadow.distance = dist + 10;
}
function updateCamera(dt: number): void {
  const dist = springs.dist.update(dt), yaw = springs.yaw.update(dt), hMul = springs.height.update(dt);
  const cap = curState ? curState.capacity : 4;
  const h = (2.6 + cap * FRAMING.heightPerCapacity) * hMul;
  const pitch = (FRAMING.pitchDeg * Math.PI) / 180;
  let x = Math.sin(yaw) * dist * Math.cos(pitch), y = h;
  const z = Math.cos(yaw) * dist * Math.cos(pitch);
  if (!reducedMotion) { x += pointer.x * 0.35; y += pointer.y * 0.15; }
  if (shakeAmp > 0.0005 && !reducedMotion) {
    x += (rnd() - 0.5) * shakeAmp * 2;
    y += (rnd() - 0.5) * shakeAmp * 2;
    shakeAmp *= Math.pow(0.001, dt);
  } else shakeAmp = 0;
  camera.position.set(x, y, z);
  camera.lookAt(0, springs.lookY.update(dt) + tubeH * 0.28, 0);
}

// ---------- picking and anchors ----------
const ndc = new Vector2();
/** render.js pick: the tube whose interaction cylinder (r 0.4, the pedestal to above the rim) a window point's ray meets first. */
export function pickTube(x: number, y: number): number | null {
  if (!curState) return null;
  pointerToNdc(x, y, ndc);
  const o = camera.position.clone();
  const d = new Vector3(ndc.x, ndc.y, 0.5).unproject(camera).sub(o).normalize();
  const y0 = -0.05, y1 = tubeH + 1.05, r = 0.4;
  let best: number | null = null, bestT = Infinity;
  tubeGroups.forEach((g, i) => {
    const ox = o.x - g.position.x, oz = o.z - g.position.z;
    const a = d.x * d.x + d.z * d.z, b = 2 * (ox * d.x + oz * d.z), c = ox * ox + oz * oz - r * r;
    let lo: number, hi: number;
    if (a < 1e-9) { if (c > 0) return; lo = -Infinity; hi = Infinity; }
    else {
      const disc = b * b - 4 * a * c;
      if (disc < 0) return;
      const s = Math.sqrt(disc);
      lo = (-b - s) / (2 * a); hi = (-b + s) / (2 * a);
    }
    // the y slab
    if (Math.abs(d.y) < 1e-9) { if (o.y < y0 || o.y > y1) return; }
    else {
      let t0 = (y0 - o.y) / d.y, t1 = (y1 - o.y) / d.y;
      if (t0 > t1) [t0, t1] = [t1, t0];
      lo = Math.max(lo, t0); hi = Math.min(hi, t1);
    }
    if (hi < Math.max(lo, 0)) return;
    const t = Math.max(lo, 0);
    if (t < bestT) { bestT = t; best = i; }
  });
  return best;
}
/** render.js tubeScreenPositions: each tube's label anchor (above the rim) in window pixels. */
export function tubeAnchors(): { x: number; y: number }[] {
  const v = new Vector3();
  return tubeGroups.map((g) => {
    v.set(g.position.x, tubeH + 0.9, g.position.z).project(camera);
    return { x: ((v.x + 1) / 2) * win.w, y: ((1 - v.y) / 2) * win.h };
  });
}
/** A tube's screen box (pedestal to rim) in window pixels, for its named target. */
export function tubeRect(i: number): Rect | null {
  const g = tubeGroups[i];
  if (!g) return null;
  const pts = [[-0.36, 0], [0.36, 0], [-0.3, tubeH + 0.55], [0.3, tubeH + 0.55]].map(([dx, yy]) => {
    const v = new Vector3(g.position.x + dx!, yy!, g.position.z).project(camera);
    return { x: ((v.x + 1) / 2) * win.w, y: ((1 - v.y) / 2) * win.h };
  });
  const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
  return { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
}

// ---------- the loop ----------
/** One fixed step of the gameplay tweens. */
export function tick(dt: number): void {
  if (tweens.length) tweens = tweens.filter((tw) => tw.update(dt));
}
export function isBusy(): boolean { return tweens.length > 0; }
/** Each frame: the framing to the uncovered rectangle, ambient motion, sparks, the camera. */
export function update(dt: number, w: number, h: number, rect: Rect, scale: number): void {
  dt = Math.min(0.05, dt);
  elapsed += dt;
  const fk = `${w}x${h}:${Math.round(rect.x)}:${Math.round(rect.y)}:${Math.round(rect.width)}:${Math.round(rect.height)}:${scale}`;
  if (w > 0 && h > 0 && rect.width > 0 && rect.height > 0 && fk !== frameKey) {
    const first = frameKey === "";
    frameKey = fk;
    win = { w, h }; view = { ...rect }; uiScale = scale;
    frameCamera(first);
  }
  if (look?.animated && !reducedMotion) {
    for (const m of spinners) m.rotation.y += (m.userData.spinSpeed as number) * dt;
    for (const s of shimmer) s.mat.emissiveIntensity = s.base + Math.sin(elapsed * s.speed) * s.amp;
    updateMotes(dt);
  }
  const pulse = 0.45 + Math.sin(elapsed * 4) * 0.15;
  for (const m of markers) { const mm = m.material as MeshBasicMaterial; if (mm.opacity > 0.05) mm.opacity = Math.min(mm.opacity, pulse + 0.2); }
  updateSparks(dt);
  updateCamera(dt);
}
