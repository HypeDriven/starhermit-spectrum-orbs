/**
 * render.js — Three.js presentation: kinetic sculpture gallery.
 *
 * Design contract (spec §4):
 *  - authored camera, procedural geometry, deterministic visual seed
 *  - readable no-post baseline: hierarchy/selection legible with effects off
 *  - separate layers: environment / gameplay / selection-ghosts / FX / UI anchors
 *  - selection = lift + rim outline + grounded marker (never bloom alone)
 *  - quality tiers control shadows/env/particles/scale — never rules
 *  - reduced motion removes swoops, shake, parallax, particles
 *  - explicit disposal on scene change; WebGL context-loss recovery
 *
 * The renderer consumes immutable snapshots; it never touches rules state.
 */
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { FXAAShader } from 'three/addons/shaders/FXAAShader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { detectPreset, describe, resolve, SHADOW_MAP, PARTICLE_BUDGET } from './gfx.js';

const LAYER_ENV = 0;
const LAYER_PICK = 1;   // raycast-only interaction layer
const LAYER_GHOST = 2;  // selection markers, previews
const LAYER_FX = 3;     // particles (never raycast)

/** Authored framing constants — no magic offsets scattered in code. */
const FRAMING = {
  fov: 34,
  pitchDeg: 40,          // camera elevation
  distPerTube: 0.92,     // camera distance per tube in the row
  distBase: 5.4,
  heightPerCapacity: 0.34,
  lookAheadY: 0.55,
  presets: {
    default: { yaw: 0, dist: 1.0, height: 1.0 },
    close: { yaw: 0, dist: 0.82, height: 0.9 },
    wide: { yaw: 0, dist: 1.2, height: 1.12 },
  },
};

const ORB_R = 0.155;
const TUBE_R = 0.21;
const TUBE_SPACING = 0.92;
const ARC_DEPTH = 0.055; // gentle arc so outer tubes recede

/** Colour grade + vignette (display-space in, display-space out). */
const GradeShader = {
  uniforms: { tDiffuse: { value: null }, uAmount: { value: 1.0 }, uVignette: { value: 0.26 } },
  vertexShader: `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: `
    uniform sampler2D tDiffuse; uniform float uAmount; uniform float uVignette;
    varying vec2 vUv;
    void main() {
      vec4 src = texture2D(tDiffuse, vUv);
      vec3 c = clamp(src.rgb, 0.0, 1.0);
      // Gentle S-curve, a touch more saturation, cool shadows / warm highlights.
      vec3 s = mix(c, c * c * (3.0 - 2.0 * c), 0.22);
      float l = dot(s, vec3(0.299, 0.587, 0.114));
      s = mix(vec3(l), s, 1.1);
      s *= mix(vec3(0.97, 0.99, 1.05), vec3(1.04, 1.0, 0.97), smoothstep(0.15, 0.8, l));
      c = mix(c, s, uAmount);
      float d = length((vUv - 0.5) * vec2(1.15, 1.0));
      c *= 1.0 - uVignette * smoothstep(0.38, 0.9, d);
      gl_FragColor = vec4(c, src.a);
    }`,
};

/** Deterministic value noise for procedural surface textures. */
function hash2(x, y) {
  const h = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return h - Math.floor(h);
}

function easeOutCubic(t) { return 1 - Math.pow(1 - t, 3); }
function easeInOutQuad(t) { return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2; }

/** Critically damped spring (spec: no cumulative per-frame lerp). */
class Spring {
  constructor(value, smoothing) { this.x = value; this.v = 0; this.target = value; this.s = smoothing || 0.18; }
  set(t) { this.target = t; }
  snap(t) { this.x = t; this.v = 0; this.target = t; }
  /** Semi-implicit Euler critically damped spring; stable and interruptible. */
  update(dt) {
    const omega = 2 / this.s;
    const a = -omega * omega * (this.x - this.target) - 2 * omega * this.v;
    this.v += a * dt;
    this.x += this.v * dt;
    return this.x;
  }
}

export class GalleryRenderer {
  /**
   * container: HTMLElement. hooks: { onPick(tubeIndex|null) }.
   */
  constructor(container, hooks) {
    this.container = container;
    this.hooks = hooks || {};
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'gl-canvas';
    this.canvas.setAttribute('aria-hidden', 'true'); // semantics live in the DOM mirror
    container.appendChild(this.canvas);

    this.renderer = null;
    this.webglOk = true;
    this.reducedMotion = false;
    this.q = resolve({}, 'balanced');
    this.tierName = this.q.preset;
    this.gpu = '';
    this.detected = 'balanced';
    this.composer = null;
    this.postFailed = false;
    this.postKey = null;
    this.adaptiveScale = 1;
    this.fps = 0;
    this._frames = [];
    this._lastFrameAt = 0;
    this._size = [0, 0];
    this.pixelRatio = 1;
    this._shimmer = [];
    this.palette = [];
    this.theme = null;
    this.cameraPreset = 'default';

    this._tweens = [];
    this._orbMeshes = [];      // per tube: array of meshes bottom->top
    this._tubeGroups = [];
    this._pickMeshes = [];
    this._markers = [];        // ground markers per tube
    this._selected = -1;
    this._hint = null;
    this._state = null;
    this._decorSpinners = [];
    this._shakeAmp = 0;
    this._running = false;
    this._disposed = false;
    this._clock = new THREE.Clock();
    this._pointer = { x: 0, y: 0 };
    this._camSpring = { yaw: new Spring(0, 0.25), dist: new Spring(1, 0.3), height: new Spring(1, 0.3), lookY: new Spring(FRAMING.lookAheadY, 0.3) };
    this._elapsed = 0;

    try {
      this.renderer = new THREE.WebGLRenderer({
        canvas: this.canvas, antialias: true, powerPreference: 'high-performance',
      });
    } catch (e) {
      this.webglOk = false;
      return;
    }
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.shadowMap.enabled = false;
    this.gpu = GalleryRenderer._gpuName(this.renderer);
    const mobile = (navigator.maxTouchPoints || 0) > 0 && /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent)
      || (window.matchMedia && window.matchMedia('(pointer: coarse)').matches);
    this.detected = detectPreset(this.gpu, mobile);
    this.q = resolve({}, this.detected);
    this.tierName = this.q.preset;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(FRAMING.fov, 1, 0.1, 100);
    this.camera.layers.enable(LAYER_GHOST);
    this.camera.layers.enable(LAYER_FX);

    this.raycaster = new THREE.Raycaster();
    this.raycaster.layers.set(LAYER_PICK);

    this._envGroup = new THREE.Group();
    this._boardGroup = new THREE.Group();
    this._ghostGroup = new THREE.Group();
    this._fxGroup = new THREE.Group();
    this.scene.add(this._envGroup, this._boardGroup, this._ghostGroup, this._fxGroup);

    this._initParticles();
    this._initMotes();
    this._bindPointer();
    this._bindContextLoss();
    this.resize();
  }

  static _gpuName(r) {
    try {
      const gl = r.getContext();
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      return String(gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER) || '');
    } catch (e) {
      return '';
    }
  }

  // ------------------------------------------------------------ lifecycle --

  _bindContextLoss() {
    this.canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      this._contextLost = true;
      this.stop();
    });
    this.canvas.addEventListener('webglcontextrestored', () => {
      // Rebuild GPU resources from retained CPU descriptors (spec §5).
      this._contextLost = false;
      this.renderer.compile(this.scene, this.camera);
      if (this._envTex) { this._envTex.dispose(); this._envTex = null; this._applyReflections(); }
      this.postKey = null;
      if (this._state) this._rebuildBoard(this._state);
      this.start();
    });
  }

  dispose() {
    this._disposed = true;
    this.stop();
    this._deepDispose(this.scene);
    if (this.composer) this.composer.dispose();
    if (this._envTex) this._envTex.dispose();
    if (this.renderer) this.renderer.dispose();
    if (this.canvas.parentNode) this.canvas.parentNode.removeChild(this.canvas);
  }

  _deepDispose(obj) {
    obj.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) {
        for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
          for (const k of ['map', 'emissiveMap', 'normalMap', 'roughnessMap']) if (m[k] && !m[k].userData.shared) m[k].dispose();
          m.dispose();
        }
      }
    });
  }

  // -------------------------------------------------------------- build --

  /**
   * Build (or rebuild) the whole scene for a level.
   * state: rules snapshot. theme: theme record. palette: color defs.
   * decorRng: deterministic decoration stream (never touches rules).
   */
  build(state, theme, palette, decorRng) {
    this._state = state;
    this.theme = theme;
    this.palette = palette;
    this._decorRng = decorRng || { float: () => 0.5, int: (a) => a, pick: (a) => a[0] };
    this._buildEnvironment();
    this._rebuildBoard(state);
    // Prewarm shader variants before play starts (spec §4: no compile hitch).
    this.renderer.compile(this.scene, this.camera);
    this._frameCamera(true);
  }

  _buildEnvironment() {
    this._deepDispose(this._envGroup);
    this.scene.remove(this._envGroup);
    this._envGroup = new THREE.Group();
    this.scene.add(this._envGroup);
    this._decorSpinners = [];
    this._shimmer = [];
    const t = this.theme;
    const detailed = this.q.detail === 'detailed';

    this.scene.background = new THREE.Color(t.sky);
    this.scene.fog = new THREE.Fog(t.fog, 14, 42);

    // Lighting: one dominant key, soft environment fill, cool rim.
    const hemi = new THREE.HemisphereLight(t.hemiSky, t.hemiGround, 0.85);
    this._envGroup.add(hemi);
    this._hemi = hemi;
    const key = new THREE.DirectionalLight(t.keyLight, t.keyIntensity);
    key.position.set(4.5, 8, 5);
    key.shadow.bias = -0.0004;
    key.shadow.normalBias = 0.02;
    this._envGroup.add(key, key.target);
    this._keyLight = key;
    const rim = new THREE.DirectionalLight(t.hemiSky, 0.5);
    rim.position.set(-6, 4, -4);
    this._envGroup.add(rim);

    // Floor: broad disc; detailed = polished terrazzo with roughness variation.
    const floorMat = new THREE.MeshStandardMaterial({ color: t.floor, roughness: 0.85, metalness: 0.05 });
    if (detailed) {
      const tex = this._floorTexture();
      floorMat.map = tex;
      floorMat.roughnessMap = tex;
      floorMat.roughness = 0.9;
      floorMat.color = new THREE.Color(t.floor).multiplyScalar(1.12);
      floorMat.envMapIntensity = 0.12;
    }
    const floor = new THREE.Mesh(new THREE.CylinderGeometry(16, 16, 0.3, 48), floorMat);
    floor.position.y = -0.15;
    floor.receiveShadow = true;
    this._envGroup.add(floor);
    const ringMat = new THREE.MeshStandardMaterial({ color: t.floorAccent, roughness: 0.7 });
    const ring = new THREE.Mesh(new THREE.TorusGeometry(5.2, 0.05, 8, 64), ringMat);
    ring.rotation.x = Math.PI / 2; ring.position.y = 0.01;
    this._envGroup.add(ring);

    // Back wall panels (instanced — repeated environment modules).
    const panelCount = detailed ? 11 : 5; // odd: a panel always sits behind the board
    const panelGeo = new THREE.BoxGeometry(1.6, 5.5, 0.18);
    const panelMat = new THREE.MeshStandardMaterial({ color: t.wall, roughness: 0.8 });
    const panels = new THREE.InstancedMesh(panelGeo, panelMat, panelCount);
    const m = new THREE.Matrix4();
    const panelAt = (i) => (i / (panelCount - 1) - 0.5) * Math.PI * 0.9;
    for (let i = 0; i < panelCount; i++) {
      const a = panelAt(i);
      m.makeRotationY(-a);
      m.setPosition(Math.sin(a) * 12, 2.6, -Math.cos(a) * 12 - 2);
      panels.setMatrixAt(i, m);
    }
    panels.instanceMatrix.needsUpdate = true;
    this._envGroup.add(panels);

    if (detailed) {
      // Gallery light strips between the panels: HDR emissive so bloom catches them.
      const stripMat = new THREE.MeshStandardMaterial({
        color: 0x000000, emissive: new THREE.Color(t.keyLight), emissiveIntensity: 2.2, roughness: 1,
      });
      // Skip the seam straight behind the board so no strip cuts through the play area.
      const seams = [];
      for (let i = 0; i < panelCount - 1; i++) {
        const a = (panelAt(i) + panelAt(i + 1)) / 2;
        if (Math.abs(a) > 0.2) seams.push(a);
      }
      const strips = new THREE.InstancedMesh(new THREE.BoxGeometry(0.06, 2.0, 0.06), stripMat, seams.length);
      for (let i = 0; i < seams.length; i++) {
        const a = seams[i];
        m.makeRotationY(-a);
        m.setPosition(Math.sin(a) * 11.9, 4.25, -Math.cos(a) * 11.9 - 2); // high on the wall, clear of the board
        strips.setMatrixAt(i, m);
      }
      strips.instanceMatrix.needsUpdate = true;
      this._envGroup.add(strips);
      this._shimmer.push({ mat: stripMat, base: 2.2, amp: 0.35, speed: 0.7 });

      // Warm pool of gallery light under the sculpture row.
      const pool = new THREE.Mesh(
        new THREE.CircleGeometry(4.6, 48),
        new THREE.MeshBasicMaterial({
          map: this._radialTexture(), color: new THREE.Color(t.keyLight), transparent: true,
          opacity: 0.13, depthWrite: false, blending: THREE.AdditiveBlending, fog: false,
        })
      );
      pool.rotation.x = -Math.PI / 2;
      pool.position.y = 0.006;
      pool.renderOrder = -1;
      this._envGroup.add(pool);

      // Kinetic sculpture mobiles: slow deterministic spin (paused when hidden).
      const count = 3;
      for (let i = 0; i < count; i++) {
        const mobile = new THREE.Group();
        const armMat = new THREE.MeshStandardMaterial({ color: t.pedestal, roughness: 0.35, metalness: 0.7 });
        const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.015, 1.6, 6), armMat);
        arm.rotation.z = Math.PI / 2;
        mobile.add(arm);
        for (const side of [-0.8, 0.8]) {
          const dropGeo = new THREE.IcosahedronGeometry(0.09 + this._decorRng.float() * 0.06, 0);
          const dropMat = new THREE.MeshStandardMaterial({
            color: new THREE.Color(t.keyLight).multiplyScalar(0.9), roughness: 0.22, metalness: 0.85,
          });
          const drop = new THREE.Mesh(dropGeo, dropMat);
          drop.position.set(side, -0.45 - this._decorRng.float() * 0.25, 0);
          mobile.add(drop);
        }
        mobile.position.set((i - (count - 1) / 2) * 3.4, 4.4 + this._decorRng.float() * 0.6, -3.5 - i * 0.7);
        mobile.userData.spinSpeed = 0.12 + this._decorRng.float() * 0.15;
        this._decorSpinners.push(mobile);
        this._envGroup.add(mobile);
      }
    }
    if (this._motes) this._motes.material.color.set(t.keyLight);
    this._applyShadows();
  }

  /** Grayscale terrazzo speckle (≈1.0 so the theme colour is preserved). */
  _floorTexture() {
    if (this._floorTex) return this._floorTex;
    const N = 256;
    const c = document.createElement('canvas');
    c.width = c.height = N;
    const ctx = c.getContext('2d');
    const img = ctx.createImageData(N, N);
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        // Two octaves of smooth noise + sparse chips.
        const n1 = this._vnoise(x / 32, y / 32, 8), n2 = this._vnoise(x / 8, y / 8, 32);
        let v = 0.86 + n1 * 0.08 + n2 * 0.04;
        const chip = hash2(x, y);
        if (chip > 0.985) v += 0.12; else if (chip < 0.012) v -= 0.1;
        const b = Math.max(0, Math.min(255, Math.round(v * 255)));
        const k = (y * N + x) * 4;
        img.data[k] = img.data[k + 1] = img.data[k + 2] = b; img.data[k + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    const tex = new THREE.CanvasTexture(c);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(6, 6);
    tex.anisotropy = Math.min(4, this.renderer.capabilities.getMaxAnisotropy());
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.userData.shared = true;
    this._floorTex = tex;
    return tex;
  }

  /** Smooth value noise, tileable with period W. */
  _vnoise(x, y, W) {
    const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
    const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
    const h = (p, q) => hash2(((p % W) + W) % W, ((q % W) + W) % W);
    const a = h(xi, yi), b = h(xi + 1, yi), c = h(xi, yi + 1), d = h(xi + 1, yi + 1);
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v - 0.5;
  }

  _radialTexture() {
    if (this._radialTex) return this._radialTex;
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const ctx = c.getContext('2d');
    const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.45, 'rgba(255,255,255,0.45)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 128, 128);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.userData.shared = true;
    this._radialTex = tex;
    return tex;
  }

  _tubePositions(count) {
    const out = [];
    const mid = (count - 1) / 2;
    for (let i = 0; i < count; i++) {
      const dx = (i - mid) * TUBE_SPACING;
      out.push(new THREE.Vector3(dx, 0, Math.abs(i - mid) * ARC_DEPTH * -1));
    }
    return out;
  }

  _rebuildBoard(state) {
    this._state = state;
    this._selected = -1;
    this._finishTweens(); // settle (and resolve) in-flight moves before the meshes go away
    this._deepDispose(this._boardGroup);
    this._deepDispose(this._ghostGroup);
    this.scene.remove(this._boardGroup, this._ghostGroup);
    this._boardGroup = new THREE.Group();
    this._ghostGroup = new THREE.Group();
    this.scene.add(this._boardGroup, this._ghostGroup);
    this._orbMeshes = [];
    this._tubeGroups = [];
    this._pickMeshes = [];
    this._markers = [];

    const n = state.tubes.length;
    const cap = state.capacity;
    const tubeH = 0.32 + cap * (ORB_R * 2 + 0.015);
    const positions = this._tubePositions(n);
    const t = this.theme;

    // Detailed: physical glass / lacquered pedestals (reflections come from
    // scene.environment). Plain keeps the cheaper standard materials.
    const detailed = this.q.detail === 'detailed';
    const tubeGlass = detailed ? new THREE.MeshPhysicalMaterial({
      color: 0xdfe8f0, transparent: true, opacity: 0.14, roughness: 0.05,
      metalness: 0, side: THREE.DoubleSide, depthWrite: false,
      ior: 1.5, envMapIntensity: 0.35,
    }) : new THREE.MeshPhysicalMaterial({
      color: 0xdfe8f0, transparent: true, opacity: 0.16, roughness: 0.08,
      metalness: 0, side: THREE.DoubleSide, depthWrite: false, envMapIntensity: 0.35,
    });
    const rimMat = new THREE.MeshStandardMaterial({ color: t.pedestal, roughness: 0.3, metalness: 0.6, envMapIntensity: 0.6 });
    const baseMat = detailed ? new THREE.MeshPhysicalMaterial({
      color: t.pedestal, roughness: 0.45, metalness: 0.3, clearcoat: 0.5, clearcoatRoughness: 0.3, envMapIntensity: 0.4,
    }) : new THREE.MeshStandardMaterial({ color: t.pedestal, roughness: 0.5, metalness: 0.3, envMapIntensity: 0.4 });

    for (let i = 0; i < n; i++) {
      const g = new THREE.Group();
      g.position.copy(positions[i]);

      // Pedestal — grounding the sculpture.
      const ped = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.36, 0.5, 20), baseMat);
      ped.position.y = 0.25;
      ped.castShadow = true; ped.receiveShadow = true;
      g.add(ped);

      // Glass tube: open-ended cylinder + rim torus.
      const glass = new THREE.Mesh(new THREE.CylinderGeometry(TUBE_R, TUBE_R, tubeH, 24, 1, true), tubeGlass);
      glass.position.y = 0.5 + tubeH / 2;
      glass.userData.noAO = true;
      g.add(glass);
      const rim = new THREE.Mesh(new THREE.TorusGeometry(TUBE_R, 0.022, 10, 28), rimMat);
      rim.rotation.x = Math.PI / 2;
      rim.position.y = 0.5 + tubeH;
      g.add(rim);
      const baseDisc = new THREE.Mesh(new THREE.CylinderGeometry(TUBE_R + 0.02, TUBE_R + 0.05, 0.05, 24), rimMat);
      baseDisc.position.y = 0.52;
      g.add(baseDisc);

      // Contact shadow blob (works even with shadow maps off).
      const blob = new THREE.Mesh(
        new THREE.CircleGeometry(0.42, 24),
        new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.28, depthWrite: false })
      );
      blob.rotation.x = -Math.PI / 2;
      blob.position.y = 0.012;
      g.add(blob);

      // Grounded selection/legality marker (ghost layer).
      const marker = new THREE.Mesh(
        new THREE.RingGeometry(0.3, 0.4, 28),
        new THREE.MeshBasicMaterial({ color: 0x7dffa8, transparent: true, opacity: 0, side: THREE.DoubleSide, depthWrite: false })
      );
      marker.rotation.x = -Math.PI / 2;
      marker.position.copy(positions[i]).setY(0.015);
      marker.layers.set(LAYER_GHOST);
      this._ghostGroup.add(marker);
      this._markers.push(marker);

      // Invisible raycast proxy on the interaction layer.
      const pick = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.4, tubeH + 1.1, 8), new THREE.MeshBasicMaterial({ visible: false }));
      pick.position.y = 0.5 + tubeH / 2;
      pick.userData.tubeIndex = i;
      pick.layers.set(LAYER_PICK);
      g.add(pick);
      this._pickMeshes.push(pick);

      this._boardGroup.add(g);
      this._tubeGroups.push(g);
      this._orbMeshes.push([]);
    }
    this._tubeH = tubeH;
    this._boardHalfW = ((n - 1) / 2) * TUBE_SPACING + 0.6;
    this._applyShadows();
    this.syncState(state);
  }

  _orbRestY(stackIndex) { return 0.55 + ORB_R + stackIndex * (ORB_R * 2 + 0.015); }

  _glyphTexture(colorDef) {
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const ctx = c.getContext('2d');
    ctx.clearRect(0, 0, 128, 128);
    ctx.fillStyle = 'rgba(255,255,255,0.92)';
    ctx.font = '64px system-ui, sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(colorDef.glyph, 64, 68);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }

  _makeOrb(colorIdx) {
    const def = this.palette[colorIdx];
    const color = new THREE.Color(def ? def.hex : '#ffffff');
    // Lacquered orb: clearcoat catches crisp highlights from the environment.
    const detailed = this.q.detail === 'detailed';
    const mat = detailed ? new THREE.MeshPhysicalMaterial({
      color, roughness: 0.3, metalness: 0.08,
      clearcoat: 1, clearcoatRoughness: 0.08, envMapIntensity: 0.55,
      emissive: color.clone().multiplyScalar(0.0),
    }) : new THREE.MeshStandardMaterial({
      color, roughness: 0.32, metalness: 0.12, envMapIntensity: 0.55,
      emissive: color.clone().multiplyScalar(0.0),
    });
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(ORB_R, detailed ? 32 : 24, detailed ? 24 : 18), mat);
    mesh.castShadow = true;
    // Shape glyph reinforces color (accessibility): camera-facing sprite.
    if (def) {
      const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
        map: this._glyphTexture(def), transparent: true, depthWrite: false, opacity: 0.95,
      }));
      sprite.scale.set(0.16, 0.16, 1);
      sprite.position.set(0, 0.02, ORB_R * 0.72);
      mesh.add(sprite);
    }
    // Rim/outline shell used when selected (BackSide halo — readable without bloom).
    const halo = new THREE.Mesh(
      new THREE.SphereGeometry(ORB_R * 1.18, 20, 14),
      new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.BackSide, transparent: true, opacity: 0 })
    );
    mesh.add(halo);
    mesh.userData.halo = halo;
    return mesh;
  }

  /** Instant, exact placement from snapshot — also the skip/fast-forward path. */
  syncState(state) {
    this._state = state;
    for (let i = 0; i < state.tubes.length; i++) {
      const stack = state.tubes[i];
      const meshes = this._orbMeshes[i];
      while (meshes.length > stack.length) {
        const m = meshes.pop();
        m.parent.remove(m);
        this._deepDispose(m);
      }
      while (meshes.length < stack.length) {
        const m = this._makeOrb(stack[meshes.length]);
        this._tubeGroups[i].add(m);
        meshes.push(m);
      }
      for (let j = 0; j < meshes.length; j++) {
        meshes[j].position.set(0, this._orbRestY(j), 0);
        meshes[j].scale.setScalar(1);
      }
    }
    this._applySelection();
  }

  // ---------------------------------------------------------- interaction --

  _bindPointer() {
    this._downAt = null;
    this.canvas.addEventListener('pointerdown', (e) => {
      this._downAt = { x: e.clientX, y: e.clientY, t: performance.now() };
      try { this.canvas.setPointerCapture(e.pointerId); } catch (err) {}
      if (this.hooks.onPickDown) this.hooks.onPickDown(this.pick(e.clientX, e.clientY));
    });
    this.canvas.addEventListener('pointermove', (e) => {
      const r = this.canvas.getBoundingClientRect();
      this._pointer.x = (e.clientX - r.left) / r.width * 2 - 1;
      this._pointer.y = -((e.clientY - r.top) / r.height * 2 - 1);
    });
    const finish = (e, cancelled) => {
      if (!this._downAt) return;
      const d = this._downAt;
      this._downAt = null;
      // Tap vs drag/camera gesture by distance/time thresholds (spec §3).
      const dist = Math.hypot(e.clientX - d.x, e.clientY - d.y);
      const dt = performance.now() - d.t;
      if (cancelled || dist > 12 || dt > 600) return;
      if (this.hooks.onPick) this.hooks.onPick(this.pick(e.clientX, e.clientY));
    };
    this.canvas.addEventListener('pointerup', (e) => finish(e, false));
    this.canvas.addEventListener('pointercancel', (e) => finish(e, true)); // cancel safely on lost capture
  }

  /** Raycast only against the explicit interaction layer (spec §3). */
  pick(clientX, clientY) {
    if (!this.renderer) return null;
    const r = this.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((clientX - r.left) / r.width) * 2 - 1,
      -((clientY - r.top) / r.height) * 2 + 1
    );
    this.raycaster.setFromCamera(ndc, this.camera);
    const hits = this.raycaster.intersectObjects(this._pickMeshes, false);
    return hits.length ? hits[0].object.userData.tubeIndex : null;
  }

  select(tubeIndex) {
    this._selected = tubeIndex === null || tubeIndex === undefined ? -1 : tubeIndex;
    this._applySelection();
  }

  _applySelection() {
    const sel = this._selected;
    for (let i = 0; i < this._orbMeshes.length; i++) {
      const meshes = this._orbMeshes[i];
      if (!meshes.length) continue;
      const top = meshes[meshes.length - 1];
      const isSel = i === sel;
      // Lift + halo + emissive; marker is separate (grounded).
      const targetY = this._orbRestY(meshes.length - 1) + (isSel ? 0.34 : 0);
      this._tween(top.position, { y: targetY }, 0.18, easeOutCubic);
      top.userData.halo.material.opacity = isSel ? 0.85 : 0;
      top.material.emissive = top.material.color.clone().multiplyScalar(isSel ? 0.45 : 0);
    }
  }

  /** Preview legal targets before commit; clear with []. */
  previewTargets(actions, fromTube) {
    for (const m of this._markers) { m.material.opacity = 0; m.material.color.set(0x7dffa8); }
    if (!actions) return;
    for (const a of actions) {
      if (a.from !== fromTube) continue;
      const marker = this._markers[a.to];
      marker.material.opacity = 0.55;
    }
  }

  setHint(h) {
    this._hint = h;
    for (const m of this._markers) { m.material.opacity = 0; }
    if (h) {
      for (const idx of [h.from, h.to]) {
        const marker = this._markers[idx];
        marker.material.color.set(0x8ecfff);
        marker.material.opacity = 0.7;
      }
    }
  }

  /** Invalid-action feedback: red flash + low-amplitude shake (event tier 0). */
  invalidFeedback(tubeIndex) {
    if (tubeIndex === null || tubeIndex === undefined || !this._markers[tubeIndex]) return;
    const marker = this._markers[tubeIndex];
    marker.material.color.set(0xff6a5e);
    marker.material.opacity = 0.8;
    this._tween(marker.material, { opacity: 0 }, 0.5, easeOutCubic, () => marker.material.color.set(0x7dffa8));
    if (!this.reducedMotion) this._shakeAmp = Math.max(this._shakeAmp, 0.012);
  }

  /** Animate a committed move; resolves when the orb lands. */
  animateMove(evt) {
    const fromMeshes = this._orbMeshes[evt.from];
    const orb = fromMeshes[fromMeshes.length - 1];
    if (!orb) return Promise.resolve();
    // Re-parent bookkeeping instantly; visuals catch up via the arc tween.
    fromMeshes.pop();
    this._orbMeshes[evt.to].push(orb);
    this._tubeGroups[evt.from].remove(orb);
    this._tubeGroups[evt.to].add(orb);
    const targetStack = this._orbMeshes[evt.to].length - 1;

    if (this.reducedMotion) {
      orb.position.set(0, this._orbRestY(targetStack), 0);
      return Promise.resolve();
    }
    const fromPos = this._tubeGroups[evt.from].position;
    const toPos = this._tubeGroups[evt.to].position;
    const liftY = this._tubeH + 0.95;
    const dur = 0.42;
    const world = orb.getWorldPosition(new THREE.Vector3());
    // Express in target-tube local space through world waypoints.
    const local0 = orb.position.clone();
    return new Promise((resolve) => {
      const tw = { t: 0 };
      this._tweens.push({
        update: (dt) => {
          tw.t += dt / dur;
          const k = Math.min(1, tw.t);
          // Piecewise arc: lift -> travel -> drop, all from sim endpoints.
          const liftEnd = 0.35, travelEnd = 0.8;
          const worldPos = new THREE.Vector3();
          const startW = world.clone();
          const endW = new THREE.Vector3(toPos.x, this._orbRestY(targetStack), toPos.z);
          if (k < liftEnd) {
            const u = easeOutCubic(k / liftEnd);
            worldPos.copy(startW); worldPos.y += (liftY - startW.y) * u;
          } else if (k < travelEnd) {
            const u = easeInOutQuad((k - liftEnd) / (travelEnd - liftEnd));
            worldPos.lerpVectors(new THREE.Vector3(fromPos.x, liftY, fromPos.z), new THREE.Vector3(toPos.x, liftY, toPos.z), u);
          } else {
            const u = easeInOutQuad((k - travelEnd) / (1 - travelEnd));
            worldPos.lerpVectors(new THREE.Vector3(toPos.x, liftY, toPos.z), endW, u);
          }
          orb.parent.worldToLocal(worldPos);
          orb.position.copy(worldPos);
          if (k >= 1) {
            orb.position.set(0, this._orbRestY(targetStack), 0); // exact deterministic end
            resolve();
            return false;
          }
          return true;
        },
        // Scene rebuilt / animations skipped: land the orb and settle the promise.
        finish: () => {
          orb.position.set(0, this._orbRestY(targetStack), 0);
          resolve();
        },
      });
    });
  }

  /** Pooled particle burst (bounded by tier; never raycastable). */
  burst(tubeIndex, colorHex, count, big) {
    const budget = PARTICLE_BUDGET[this.q.particles] || 0;
    if (this.reducedMotion || budget === 0) return;
    const pos = this._tubeGroups[tubeIndex] ? this._tubeGroups[tubeIndex].position : new THREE.Vector3();
    const alive = this._particlePool.all.length - this._particlePool.free;
    const n = Math.min(this.q.particles === 'high' ? count : Math.ceil(count / 2), budget - alive);
    const color = new THREE.Color(colorHex || 0xffffff);
    for (let i = 0; i < n; i++) {
      const p = this._particlePool.spawn();
      if (!p) break;
      p.pos.set(pos.x, this._tubeH + 0.4, pos.z);
      const a = Math.random() * Math.PI * 2;
      const sp = (big ? 2.2 : 1.2) * (0.5 + Math.random());
      p.vel.set(Math.cos(a) * sp * 0.5, 1.2 + Math.random() * (big ? 2.4 : 1.2), Math.sin(a) * sp * 0.5);
      p.life = p.maxLife = big ? 1.4 : 0.8;
      p.color.copy(color);
    }
  }

  _initParticles() {
    const MAX = 2000; // hard cap; tiers gate how many may spawn
    const geo = new THREE.BufferGeometry();
    this._pPos = new Float32Array(MAX * 3);
    this._pCol = new Float32Array(MAX * 3);
    geo.setAttribute('position', new THREE.BufferAttribute(this._pPos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(this._pCol, 3));
    const mat = new THREE.PointsMaterial({
      size: 0.07, vertexColors: true, transparent: true, opacity: 0.95, depthWrite: false,
      map: this._radialTexture(), blending: THREE.AdditiveBlending,
    });
    this._points = new THREE.Points(geo, mat);
    this._points.layers.set(LAYER_FX);
    this._points.frustumCulled = false;
    this._fxGroup.add(this._points);
    const pool = [];
    for (let i = 0; i < MAX; i++) {
      pool.push({ alive: false, i, pos: new THREE.Vector3(), vel: new THREE.Vector3(), life: 0, maxLife: 1, color: new THREE.Color() });
      this._pPos[i * 3 + 1] = -100;
    }
    this._particlePool = {
      all: pool,
      get free() { return pool.reduce((n, p) => n + (p.alive ? 0 : 1), 0); },
      spawn() { const p = pool.find((q) => !q.alive); if (p) p.alive = true; return p || null; },
    };
  }

  _updateParticles(dt) {
    if (!this._particlePool) return;
    let any = false;
    for (const p of this._particlePool.all) {
      if (!p.alive) continue;
      any = true;
      p.life -= dt;
      if (p.life <= 0) { p.alive = false; this._pPos[p.i * 3 + 1] = -100; continue; }
      p.vel.y -= 4.5 * dt;
      p.pos.addScaledVector(p.vel, dt);
      this._pPos[p.i * 3] = p.pos.x;
      this._pPos[p.i * 3 + 1] = p.pos.y;
      this._pPos[p.i * 3 + 2] = p.pos.z;
      const f = p.life / p.maxLife;
      const k = f * 1.5; // slightly over 1 so fresh sparks catch the bloom
      this._pCol[p.i * 3] = p.color.r * k;
      this._pCol[p.i * 3 + 1] = p.color.g * k;
      this._pCol[p.i * 3 + 2] = p.color.b * k;
    }
    if (any) {
      this._points.geometry.attributes.position.needsUpdate = true;
      this._points.geometry.attributes.color.needsUpdate = true;
    }
  }

  celebrate() {
    // Round-completion tier: burst from every tube, gentle camera settle.
    for (let i = 0; i < this._tubeGroups.length; i++) {
      const top = this._state && this._state.tubes[i].length ? this._state.tubes[i][this._state.tubes[i].length - 1] : 0;
      this.burst(i, this.palette[top] ? this.palette[top].hex : 0xffffff, 40, true);
    }
    if (!this.reducedMotion) this._shakeAmp = Math.max(this._shakeAmp, 0.03);
  }

  // ------------------------------------------------------------- camera --

  setCameraPreset(name) {
    if (FRAMING.presets[name]) {
      this.cameraPreset = name;
      this._frameCamera(false);
    }
  }

  resetCamera() { this._frameCamera(false); }

  /**
   * Playfield rectangle not covered by DOM chrome (tutorial card, board-status
   * strip). The camera frames the tubes inside it through a view offset, so
   * instructions never sit on top of the targets.
   */
  _safeRect() {
    const W = this.container.clientWidth || 1, H = this.container.clientHeight || 1;
    let top = 0, bottom = H, left = 0, right = W;
    const host = this.container.getBoundingClientRect();
    // rects are visual px, W/H layout px: convert (they differ under the UI zoom)
    const k = host.width ? host.width / W : 1;
    const rectOf = (id) => {
      const el = document.getElementById(id);
      if (!el || el.hidden) return null;
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) return null;
      return { x: (r.left - host.left) / k, y: (r.top - host.top) / k, w: r.width / k, h: r.height / k };
    };
    const card = rectOf('tutorial-card');
    if (card) {
      // banner across the top (wide, or centred over the middle of the board)
      if (card.w > W * 0.55 || (card.x < W / 2 && card.x + card.w > W / 2)) top = Math.max(top, card.y + card.h);
      else if (card.x + card.w / 2 < W / 2) left = Math.max(left, card.x + card.w); // docked left
      else right = Math.min(right, card.x);                                // docked right
    }
    const status = document.getElementById('board-status');
    if (status && status.offsetHeight) {
      const r = status.getBoundingClientRect();
      bottom = Math.min(bottom, (r.top - host.top) / k);
    }
    if (right - left < W * 0.4) { left = 0; right = W; }
    if (bottom - top < H * 0.4) { top = 0; bottom = H; }
    return { x: left, y: top, w: right - left, h: bottom - top, W, H };
  }

  _applyViewOffset() {
    const sr = this._safeRect();
    const pad = 6;
    const sw = Math.max(1, sr.w - pad * 2), sh = Math.max(1, sr.h - pad * 2);
    this.camera.aspect = sw / sh;
    this.camera.setViewOffset(sw, sh, -(sr.x + pad), -(sr.y + pad), sr.W, sr.H);
    this.camera.updateProjectionMatrix();
  }

  _frameCamera(snap) {
    const p = FRAMING.presets[this.cameraPreset] || FRAMING.presets.default;
    const n = this._state ? this._state.tubes.length : 8;
    const cap = this._state ? this._state.capacity : 4;
    this._applyViewOffset();
    // Fit by projection: probe the board's bounding corners (outer tubes, floor
    // to the number labels above the glass) through a camera at the candidate
    // distance and pull back until every corner is inside the safe rectangle.
    const halfW = ((n - 1) / 2) * TUBE_SPACING + 0.9;
    const tubeH = 0.32 + cap * (ORB_R * 2 + 0.015);
    const pitch = THREE.MathUtils.degToRad(FRAMING.pitchDeg);
    const h = (2.6 + cap * FRAMING.heightPerCapacity) * p.height;
    const lookY = FRAMING.lookAheadY + tubeH * 0.28;
    const probe = new THREE.PerspectiveCamera(FRAMING.fov, this.camera.aspect || 1, 0.1, 100);
    const pts = [];
    for (const x of [-halfW, halfW]) for (const y of [0, tubeH + 1.35]) for (const z of [-0.6, 0.6]) pts.push(new THREE.Vector3(x, y, z));
    const v = new THREE.Vector3();
    let dist = 4.5 * p.dist;
    for (let i = 0; i < 14; i++) {
      probe.position.set(Math.sin(p.yaw) * dist * Math.cos(pitch), h, Math.cos(p.yaw) * dist * Math.cos(pitch));
      probe.lookAt(0, lookY, 0);
      probe.updateMatrixWorld();
      probe.updateProjectionMatrix();
      let over = 0;
      for (const q of pts) { v.copy(q).project(probe); over = Math.max(over, Math.abs(v.x) / 0.94, Math.abs(v.y) / 0.9); }
      if (over <= 1) break;
      dist *= Math.min(1.6, over + 0.02);
    }
    this._camSpring.dist.set(dist);
    this._camSpring.yaw.set(p.yaw);
    this._camSpring.height.set(p.height);
    if (snap) {
      this._camSpring.dist.snap(dist);
      this._camSpring.yaw.snap(p.yaw);
      this._camSpring.height.snap(p.height);
    }
  }

  _updateCamera(dt) {
    const dist = this._camSpring.dist.update(dt);
    const yaw = this._camSpring.yaw.update(dt);
    const hMul = this._camSpring.height.update(dt);
    const cap = this._state ? this._state.capacity : 4;
    const h = (2.6 + cap * FRAMING.heightPerCapacity) * hMul;
    const pitch = THREE.MathUtils.degToRad(FRAMING.pitchDeg);
    const cx = Math.sin(yaw) * dist * Math.cos(pitch);
    const cz = Math.cos(yaw) * dist * Math.cos(pitch);
    let x = cx, y = h, z = cz;
    // Pointer parallax (disabled by reduced motion).
    if (!this.reducedMotion) {
      x += this._pointer.x * 0.35;
      y += this._pointer.y * 0.15;
    }
    // Camera shake: low amplitude, event-tiered, never changes raycast truth
    // (picking uses the unshaken raycaster camera state from last frame).
    if (this._shakeAmp > 0.0005 && !this.reducedMotion) {
      x += (Math.random() - 0.5) * this._shakeAmp * 2;
      y += (Math.random() - 0.5) * this._shakeAmp * 2;
      this._shakeAmp *= Math.pow(0.001, dt); // fast decay
    } else {
      this._shakeAmp = 0;
    }
    this.camera.position.set(x, y, z);
    this.camera.lookAt(0, this._camSpring.lookY.update(dt) + (this._tubeH || 2) * 0.28, 0);
  }

  // -------------------------------------------------------------- loop --

  start() {
    if (this._running || !this.renderer || this._contextLost) return;
    this._running = true;
    this._clock.start();
    this.renderer.setAnimationLoop(() => this._frame());
  }
  stop() {
    this._running = false;
    if (this.renderer) this.renderer.setAnimationLoop(null);
  }

  _frame() {
    if (this._disposed) return;
    const dt = Math.min(0.05, this._clock.getDelta());
    this._elapsed += dt;
    // Tweens (gameplay animation derives from sim endpoints, not frame count).
    if (this._tweens.length) {
      this._tweens = this._tweens.filter((tw) => tw.update(dt) !== false);
    }
    // Ambient motion: mobiles, dust motes, light-strip shimmer. Off with reduced
    // motion or a static background.
    if (this._ambientOn()) {
      for (const m of this._decorSpinners) m.rotation.y += m.userData.spinSpeed * dt;
      for (const s of this._shimmer) s.mat.emissiveIntensity = s.base + Math.sin(this._elapsed * s.speed) * s.amp;
      this._updateMotes(dt);
    }
    // Marker pulse.
    const pulse = 0.45 + Math.sin(this._elapsed * 4) * 0.15;
    for (const m of this._markers) if (m.material.opacity > 0.05) m.material.opacity = Math.min(m.material.opacity, pulse + 0.2);
    this._updateParticles(dt);
    this._updateCamera(dt);
    this._render();
  }

  _ambientOn() {
    if (this.reducedMotion || this.q.background !== 'animated') return false;
    return !(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }

  // ------------------------------------------------------------ dust motes --

  _initMotes() {
    const N = 140;
    const pos = new Float32Array(N * 3);
    let seed = 7;
    const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    for (let i = 0; i < N; i++) {
      pos[i * 3] = (rnd() - 0.5) * 9;
      pos[i * 3 + 1] = rnd() * 5;
      pos[i * 3 + 2] = (rnd() - 0.5) * 5 - 0.8;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const mat = new THREE.PointsMaterial({
      size: 0.035, map: this._radialTexture(), color: 0xffe0b8, transparent: true, opacity: 0.35,
      depthWrite: false, blending: THREE.AdditiveBlending,
    });
    this._motes = new THREE.Points(geo, mat);
    this._motes.layers.set(LAYER_FX);
    this._motes.frustumCulled = false;
    this._motes.visible = false;
    this._fxGroup.add(this._motes);
  }

  _updateMotes(dt) {
    if (!this._motes || !this._motes.visible) return;
    const a = this._motes.geometry.attributes.position;
    const p = a.array;
    for (let i = 0; i < p.length; i += 3) {
      p[i + 1] += dt * (0.05 + (i % 7) * 0.008);
      p[i] += Math.sin(this._elapsed * 0.3 + i) * dt * 0.03;
      if (p[i + 1] > 5) p[i + 1] = 0;
    }
    a.needsUpdate = true;
  }

  // ---------------------------------------------------------- render path --

  _pixelRatioFor() {
    // the canvas sits inside the zoomed #app (layout px): multiply by the UI zoom
    const zoom = (window.UIScale && window.UIScale.value) || 1;
    return Math.min(window.devicePixelRatio || 1, this.q.cap) * zoom * this.q.scale * this.adaptiveScale;
  }

  _render() {
    const now = performance.now();
    const ms = this._lastFrameAt ? Math.min(250, now - this._lastFrameAt) : 16;
    this._lastFrameAt = now;
    if (this._adapt(ms)) this.resize();
    const w = this._size[0], h = this._size[1];
    const key = this._postKey(w, h);
    if (key !== this.postKey) {
      this.postKey = key;
      this._buildPost(w, h);
    }
    if (this.composer) {
      try {
        this.composer.render(ms / 1000);
        return;
      } catch (e) {
        this.postFailed = true;
        this.composer.dispose();
        this.composer = null;
      }
    }
    this.renderer.render(this.scene, this.camera);
  }

  /** Adaptive resolution: ~90-frame average; step down when slow, up when fast. */
  _adapt(ms) {
    const f = this._frames;
    f.push(ms);
    if (f.length < 90) return false;
    const avg = f.reduce((a, b) => a + b, 0) / f.length;
    f.length = 0;
    this.fps = 1000 / avg;
    const el = document.getElementById('fps-meter');
    if (el && !el.hidden) el.textContent = `${Math.round(this.fps)} fps · ${Math.round(this.pixelRatio * 100) / 100}×`;
    if (!this.q.adaptive) return false;
    const before = this.adaptiveScale;
    if (avg > 26) this.adaptiveScale = Math.max(0.6, this.adaptiveScale - 0.1);
    else if (avg < 14 && this.adaptiveScale < 1) this.adaptiveScale = Math.min(1, this.adaptiveScale + 0.05);
    return before !== this.adaptiveScale;
  }

  _postKey(w, h) {
    const g = this.q;
    return g.post && !this.postFailed ? [g.ao, g.bloom, g.grade, g.antialias, w, h, this.pixelRatio].join('|') : 'none';
  }

  _buildPost(w, h) {
    const g = this.q;
    if (this.composer) this.composer.dispose();
    this.composer = null;
    if (!g.post || this.postFailed) return;
    try {
      const pr = this.pixelRatio;
      const W = Math.max(1, Math.round(w * pr)), H = Math.max(1, Math.round(h * pr));
      const target = new THREE.WebGLRenderTarget(W, H, {
        type: THREE.HalfFloatType, samples: g.antialias === 'msaa' ? 4 : 0,
      });
      const composer = new EffectComposer(this.renderer, target);
      composer.setPixelRatio(pr);
      composer.setSize(w, h);
      composer.addPass(new RenderPass(this.scene, this.camera));
      if (g.ao !== 'off') {
        const ao = new GTAOPass(this.scene, this.camera, W, H);
        ao.output = GTAOPass.OUTPUT.Default;
        ao.blendIntensity = 0.75;
        ao.updateGtaoMaterial({ radius: 0.35, distanceExponent: 1.4, thickness: 1.2, scale: 1.0, samples: g.ao === 'high' ? 16 : 8 });
        ao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: g.ao === 'high' ? 6 : 4, rings: 2, samples: g.ao === 'high' ? 16 : 8 });
        // Glass, sprites and decals must not occlude: hide them from the AO G-buffer.
        const base = ao.overrideVisibility.bind(ao);
        ao.overrideVisibility = () => {
          base();
          this.scene.traverse((o) => {
            if (o.isSprite || o.userData.noAO || (o.material && o.material.transparent)) o.visible = false;
          });
        };
        composer.addPass(ao);
      }
      if (g.bloom === 'on') {
        // High threshold: only emissive strips, selection glow and specular highlights bloom.
        composer.addPass(new UnrealBloomPass(new THREE.Vector2(W, H), 0.5, 0.4, 0.88));
      }
      if (g.grade === 'on') composer.addPass(new ShaderPass(GradeShader));
      composer.addPass(new OutputPass());
      if (g.antialias === 'smaa') composer.addPass(new SMAAPass(W, H));
      if (g.antialias === 'fxaa') {
        const fxaa = new ShaderPass(FXAAShader);
        fxaa.material.uniforms.resolution.value.set(1 / W, 1 / H);
        composer.addPass(fxaa);
      }
      this.composer = composer;
    } catch (e) {
      // Post-processing is an enhancement: render directly; the Graphics panel says so.
      this.postFailed = true;
      this.composer = null;
    }
  }

  _tween(obj, props, dur, ease, onDone) {
    if (this.reducedMotion || dur <= 0) {
      Object.assign(obj, props);
      if (onDone) onDone();
      return;
    }
    const from = {};
    for (const k of Object.keys(props)) from[k] = obj[k];
    let t = 0;
    this._tweens.push({
      update: (dt) => {
        t += dt / dur;
        const k = ease(Math.min(1, t));
        for (const key of Object.keys(props)) obj[key] = from[key] + (props[key] - from[key]) * k;
        if (t >= 1) { if (onDone) onDone(); return false; }
        return true;
      },
      finish: () => { Object.assign(obj, props); if (onDone) onDone(); },
    });
  }

  /** Jump every pending tween to its end, resolving any waiting move promises. */
  _finishTweens() {
    const pending = this._tweens;
    this._tweens = [];
    for (const tw of pending) if (tw.finish) tw.finish();
  }

  /** Skip/fast-forward: settle every animated object into its exact end state. */
  skipAnimations() {
    this._finishTweens();
    if (this._state) this.syncState(this._state);
    this._shakeAmp = 0;
  }

  // ----------------------------------------------------------- settings --

  /** Apply saved graphics settings live (see gfx.js for the model). */
  setGraphics(saved) {
    if (!this.renderer) return;
    const key = JSON.stringify(saved || {});
    if (key === this._gfxKey) return;
    this._gfxKey = key;
    const prev = this.q;
    const g = resolve(saved || {}, this.detected);
    this.q = g;
    this.tierName = g.preset;
    this.adaptiveScale = 1;
    this._frames = [];
    this.postFailed = false;
    this.postKey = null;
    document.body.dataset.gfxPreset = g.preset;
    this.canvas.dataset.gfxPreset = g.preset;
    this._fpsVisible(g.showFps);
    this._applyShadows();
    this._applyReflections();
    if (this._motes) this._motes.visible = g.background === 'animated';
    if (this._state && prev.detail !== g.detail && this.theme) {
      const sel = this._selected, hint = this._hint;
      this._buildEnvironment();
      this._rebuildBoard(this._state);
      this.select(sel);
      if (hint) this.setHint(hint);
      this.renderer.compile(this.scene, this.camera);
    }
    this.resize();
  }

  /** What the settings panel shows: GPU, auto choice, resolved tiers, cost. */
  graphicsInfo() {
    const px = [Math.round(this._size[0] * this.pixelRatio), Math.round(this._size[1] * this.pixelRatio)];
    return {
      gpu: this.gpu || 'unknown GPU',
      detected: this.detected,
      resolved: this.q,
      summary: describe(this.q, this._size[0] > 1 && this._size[1] > 1 ? px : null),
      fps: Math.round(this.fps || 0),
      adaptiveScale: Math.round(this.adaptiveScale * 100) / 100,
      postFailed: !!this.postFailed,
    };
  }

  _applyShadows() {
    if (!this.renderer) return;
    const size = SHADOW_MAP[this.q.shadows] || 0;
    const on = size > 0;
    const changed = this.renderer.shadowMap.enabled !== on;
    this.renderer.shadowMap.enabled = on;
    const key = this._keyLight;
    if (key) {
      key.castShadow = on;
      if (on && key.shadow.mapSize.x !== size) {
        key.shadow.mapSize.set(size, size);
        if (key.shadow.map) { key.shadow.map.dispose(); key.shadow.map = null; }
      }
      // Frustum fitted tightly around the sculpture row (light space ≈ board extent).
      const r = Math.max(2.8, (this._boardHalfW || 3) + 0.8);
      const cam = key.shadow.camera;
      cam.left = -r; cam.right = r; cam.top = r; cam.bottom = -r;
      cam.near = 4; cam.far = 18;
      cam.updateProjectionMatrix();
    }
    if (changed) this.scene.traverse((o) => { if (o.material) for (const m of [].concat(o.material)) m.needsUpdate = true; });
  }

  _applyReflections() {
    if (!this.renderer) return;
    const on = this.q.reflections === 'on';
    if (on && !this._envTex) {
      try {
        const pmrem = new THREE.PMREMGenerator(this.renderer);
        const room = new RoomEnvironment(this.renderer);
        this._envTex = pmrem.fromScene(room, 0.04).texture;
        room.traverse((o) => { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); });
        pmrem.dispose();
      } catch (e) {
        this._envTex = null;
      }
    }
    this.scene.environment = on ? this._envTex : null;
    // With image-based lighting the hemisphere fill is partly redundant.
    if (this._hemi) this._hemi.intensity = on && this._envTex ? 0.45 : 0.85;
  }

  _fpsVisible(on) {
    let el = document.getElementById('fps-meter');
    if (on && !el) {
      el = document.createElement('div');
      el.id = 'fps-meter';
      el.setAttribute('aria-hidden', 'true');
      el.textContent = '… fps';
      document.body.append(el);
    }
    if (el) el.hidden = !on;
  }

  /** Legacy tier names map onto presets. */
  setQuality(tierName) {
    const map = { low: 'low', medium: 'balanced', high: 'high' };
    this.setGraphics({ preset: map[tierName] || tierName });
  }

  /** Dynamic render-scale multiplier (the adaptive step lives in _adapt). */
  setRenderScale(scale) {
    this.adaptiveScale = Math.max(0.5, Math.min(1, scale));
    this.resize();
  }

  setReducedMotion(b) {
    this.reducedMotion = !!b;
    if (b) this.skipAnimations();
  }

  resize() {
    if (!this.renderer) return;
    const w = this.container.clientWidth || 1;
    const h = this.container.clientHeight || 1;
    const dpr = this._pixelRatioFor();
    this.pixelRatio = dpr;
    this._size = [w, h];
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(w, h, false);
    this._frameCamera(false); // aspect / chrome change may require re-fit
  }

  /** Screen-space anchor for DOM labels (shared layout model, spec §3). */
  tubeScreenPositions() {
    if (!this._state) return [];
    const w = this.container.clientWidth || 1;
    const h = this.container.clientHeight || 1;
    const v = new THREE.Vector3();
    return this._tubeGroups.map((g, i) => {
      v.copy(g.position);
      v.y = this._tubeH + 0.9;
      v.project(this.camera);
      return { i, x: (v.x * 0.5 + 0.5) * w, y: (-v.y * 0.5 + 0.5) * h };
    });
  }

  /** Perf evidence for the quality router (draw calls, triangles). */
  debugInfo() {
    if (!this.renderer) return null;
    return {
      drawCalls: this.renderer.info.render.calls,
      triangles: this.renderer.info.render.triangles,
      geometries: this.renderer.info.memory.geometries,
      textures: this.renderer.info.memory.textures,
      tier: this.tierName,
    };
  }
}
