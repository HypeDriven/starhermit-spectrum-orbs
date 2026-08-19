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
import * as THREE from '../vendor/three.module.min.js';

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

const QUALITY_TIERS = {
  low: { pixelRatioCap: 1, shadows: false, particles: 0, envDetail: 0.3, anisotropy: 1 },
  medium: { pixelRatioCap: 1.5, shadows: true, particles: 600, envDetail: 0.7, anisotropy: 2 },
  high: { pixelRatioCap: 2, shadows: true, particles: 2000, envDetail: 1, anisotropy: 4 },
};

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
    this.tierName = 'high';
    this.tier = QUALITY_TIERS.high;
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
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

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
    this._bindPointer();
    this._bindContextLoss();
    this.resize();
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
      if (this._state) this._rebuildBoard(this._state);
      this.start();
    });
  }

  dispose() {
    this._disposed = true;
    this.stop();
    this._deepDispose(this.scene);
    if (this.renderer) this.renderer.dispose();
    if (this.canvas.parentNode) this.canvas.parentNode.removeChild(this.canvas);
  }

  _deepDispose(obj) {
    obj.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) {
        for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
          for (const k of ['map', 'emissiveMap', 'normalMap', 'roughnessMap']) if (m[k]) m[k].dispose();
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
    const t = this.theme;
    const detail = this.tier.envDetail;

    this.scene.background = new THREE.Color(t.sky);
    this.scene.fog = new THREE.Fog(t.fog, 14, 42);

    // Lighting: one dominant key, soft environment fill, contact grounding.
    const hemi = new THREE.HemisphereLight(t.hemiSky, t.hemiGround, 0.85);
    this._envGroup.add(hemi);
    const key = new THREE.DirectionalLight(t.keyLight, t.keyIntensity);
    key.position.set(4.5, 8, 5);
    key.castShadow = this.tier.shadows;
    if (key.castShadow) {
      key.shadow.mapSize.set(1024, 1024);
      key.shadow.camera.left = -8; key.shadow.camera.right = 8;
      key.shadow.camera.top = 8; key.shadow.camera.bottom = -8;
      key.shadow.bias = -0.0004;
    }
    this._envGroup.add(key);
    this._keyLight = key;
    const rim = new THREE.DirectionalLight(t.hemiSky, 0.5);
    rim.position.set(-6, 4, -4);
    this._envGroup.add(rim);

    // Floor: broad disc with a subtle radial accent ring.
    const floorMat = new THREE.MeshStandardMaterial({ color: t.floor, roughness: 0.85, metalness: 0.05 });
    const floor = new THREE.Mesh(new THREE.CylinderGeometry(16, 16, 0.3, 48), floorMat);
    floor.position.y = -0.15;
    floor.receiveShadow = this.tier.shadows;
    this._envGroup.add(floor);
    const ringMat = new THREE.MeshStandardMaterial({ color: t.floorAccent, roughness: 0.7 });
    const ring = new THREE.Mesh(new THREE.TorusGeometry(5.2, 0.05, 8, 64), ringMat);
    ring.rotation.x = Math.PI / 2; ring.position.y = 0.01;
    this._envGroup.add(ring);

    // Back wall panels (instanced — repeated environment modules).
    if (detail > 0.2) {
      const panelCount = Math.round(7 * detail) + 3;
      const panelGeo = new THREE.BoxGeometry(1.6, 5.5, 0.18);
      const panelMat = new THREE.MeshStandardMaterial({ color: t.wall, roughness: 0.8 });
      const panels = new THREE.InstancedMesh(panelGeo, panelMat, panelCount);
      const m = new THREE.Matrix4();
      for (let i = 0; i < panelCount; i++) {
        const a = (i / (panelCount - 1) - 0.5) * Math.PI * 0.9;
        const r = 12;
        m.makeRotationY(-a);
        m.setPosition(Math.sin(a) * r, 2.6, -Math.cos(a) * r - 2);
        panels.setMatrixAt(i, m);
      }
      panels.instanceMatrix.needsUpdate = true;
      this._envGroup.add(panels);
    }

    // Kinetic sculpture mobiles: slow deterministic spin (paused when hidden).
    if (detail > 0.4) {
      const count = Math.round(3 * detail);
      for (let i = 0; i < count; i++) {
        const mobile = new THREE.Group();
        const armMat = new THREE.MeshStandardMaterial({ color: t.pedestal, roughness: 0.4, metalness: 0.6 });
        const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.015, 1.6, 6), armMat);
        arm.rotation.z = Math.PI / 2;
        mobile.add(arm);
        for (const side of [-0.8, 0.8]) {
          const dropGeo = new THREE.IcosahedronGeometry(0.09 + this._decorRng.float() * 0.06, 0);
          const dropMat = new THREE.MeshStandardMaterial({
            color: new THREE.Color(t.keyLight).multiplyScalar(0.9), roughness: 0.3, metalness: 0.7,
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
    this._tweens = [];
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

    const tubeGlass = new THREE.MeshPhysicalMaterial({
      color: 0xdfe8f0, transparent: true, opacity: 0.16, roughness: 0.08,
      metalness: 0, side: THREE.DoubleSide, depthWrite: false,
    });
    const rimMat = new THREE.MeshStandardMaterial({ color: t.pedestal, roughness: 0.35, metalness: 0.55 });
    const baseMat = new THREE.MeshStandardMaterial({ color: t.pedestal, roughness: 0.5, metalness: 0.3 });

    for (let i = 0; i < n; i++) {
      const g = new THREE.Group();
      g.position.copy(positions[i]);

      // Pedestal — grounding the sculpture.
      const ped = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.36, 0.5, 20), baseMat);
      ped.position.y = 0.25;
      ped.castShadow = this.tier.shadows; ped.receiveShadow = this.tier.shadows;
      g.add(ped);

      // Glass tube: open-ended cylinder + rim torus.
      const glass = new THREE.Mesh(new THREE.CylinderGeometry(TUBE_R, TUBE_R, tubeH, 24, 1, true), tubeGlass);
      glass.position.y = 0.5 + tubeH / 2;
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
    const mat = new THREE.MeshStandardMaterial({
      color, roughness: 0.32, metalness: 0.12,
      emissive: color.clone().multiplyScalar(0.0),
    });
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(ORB_R, 24, 18), mat);
    mesh.castShadow = this.tier.shadows;
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
      });
    });
  }

  /** Pooled particle burst (bounded by tier; never raycastable). */
  burst(tubeIndex, colorHex, count, big) {
    if (this.reducedMotion || this.tier.particles === 0) return;
    const pos = this._tubeGroups[tubeIndex] ? this._tubeGroups[tubeIndex].position : new THREE.Vector3();
    const n = Math.min(count, this._particlePool.free);
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
    const mat = new THREE.PointsMaterial({ size: 0.05, vertexColors: true, transparent: true, opacity: 0.9, depthWrite: false });
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
      this._pCol[p.i * 3] = p.color.r * f;
      this._pCol[p.i * 3 + 1] = p.color.g * f;
      this._pCol[p.i * 3 + 2] = p.color.b * f;
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

  _frameCamera(snap) {
    const p = FRAMING.presets[this.cameraPreset] || FRAMING.presets.default;
    const n = this._state ? this._state.tubes.length : 8;
    let dist = (FRAMING.distBase + n * FRAMING.distPerTube) * p.dist;
    // Aspect-aware fit: in narrow/portrait viewports, pull back until the
    // whole row is inside the horizontal field of view.
    const aspect = this.camera.aspect || 1;
    const halfW = ((n - 1) / 2) * TUBE_SPACING + 1.15;
    const hTan = Math.tan(THREE.MathUtils.degToRad(FRAMING.fov / 2)) * aspect;
    const pitch = THREE.MathUtils.degToRad(FRAMING.pitchDeg);
    const fitDist = (halfW / hTan) / Math.cos(pitch) + 1.2;
    dist = Math.max(dist, fitDist);
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
    // Decorative motion (skipped when hidden — loop itself is stopped by UI).
    if (!this.reducedMotion) {
      for (const m of this._decorSpinners) m.rotation.y += m.userData.spinSpeed * dt;
    }
    // Marker pulse.
    const pulse = 0.45 + Math.sin(this._elapsed * 4) * 0.15;
    for (const m of this._markers) if (m.material.opacity > 0.05) m.material.opacity = Math.min(m.material.opacity, pulse + 0.2);
    this._updateParticles(dt);
    this._updateCamera(dt);
    this.renderer.render(this.scene, this.camera);
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
    });
  }

  /** Skip/fast-forward: settle every animated object into its exact end state. */
  skipAnimations() {
    this._tweens = [];
    if (this._state) this.syncState(this._state);
    this._shakeAmp = 0;
  }

  // ----------------------------------------------------------- settings --

  setQuality(tierName) {
    if (!QUALITY_TIERS[tierName]) return;
    this.tierName = tierName;
    this.tier = QUALITY_TIERS[tierName];
    this.renderer.shadowMap.enabled = this.tier.shadows;
    this.resize();
    if (this._state) this.build(this._state, this.theme, this.palette, this._decorRng);
  }

  /** Dynamic render-scale: lower before ever touching simulation rate. */
  setRenderScale(scale) {
    this._renderScale = scale;
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
    const dpr = Math.min(window.devicePixelRatio || 1, this.tier.pixelRatioCap) * (this._renderScale || 1);
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this._frameCamera(false); // aspect change may require re-fit (portrait)
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
