import * as THREE from 'three';
import { rand } from './util.js';

const VERT = /* glsl */ `
  attribute float psize;
  attribute vec4 pcolor;
  uniform float uScale;
  uniform float uMaxSize;
  varying vec4 vColor;
  void main() {
    vColor = pcolor;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    // point sprites are capped per GPU (as low as ~511 px): clamp ourselves so every
    // machine draws the same thing
    gl_PointSize = min(psize * uScale / max(0.1, -mv.z), uMaxSize);
    gl_Position = projectionMatrix * mv;
  }
`;
const FRAG = /* glsl */ `
  varying vec4 vColor;
  void main() {
    float d = length(gl_PointCoord - 0.5);
    float a = smoothstep(0.5, 0.08, d);
    gl_FragColor = vec4(vColor.rgb, vColor.a * a);
  }
`;

/** Fixed-size ring buffer of camera-facing sprites. */
class Particles {
  constructor(scene, max, blending) {
    this.max = max;
    this.cursor = 0;
    this.pos = new Float32Array(max * 3);
    this.col = new Float32Array(max * 4);
    this.size = new Float32Array(max);
    this.vel = new Float32Array(max * 3);
    this.data = new Float32Array(max * 8); // life, maxLife, s0, s1, alpha, gravity, drag, unused
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    geo.setAttribute('pcolor', new THREE.BufferAttribute(this.col, 4));
    geo.setAttribute('psize', new THREE.BufferAttribute(this.size, 1));
    this.geo = geo;
    this.mat = new THREE.ShaderMaterial({
      uniforms: { uScale: { value: 600 }, uMaxSize: { value: 480 } },
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      blending,
    });
    this.points = new THREE.Points(geo, this.mat);
    this.points.frustumCulled = false;
    scene.add(this.points);
  }

  emit(x, y, z, vx, vy, vz, life, s0, s1, r, g, b, a = 1, gravity = 0, drag = 0) {
    const i = this.cursor;
    this.cursor = (i + 1) % this.max;
    this.pos.set([x, y, z], i * 3);
    this.vel.set([vx, vy, vz], i * 3);
    this.col.set([r, g, b, a], i * 4);
    this.data.set([life, life, s0, s1, a, gravity, drag, 0], i * 8);
  }

  update(dt) {
    const { pos, vel, col, size, data } = this;
    for (let i = 0; i < this.max; i++) {
      const o = i * 8;
      if (data[o] <= 0) continue;
      data[o] -= dt;
      if (data[o] <= 0) {
        // a zero-size point is undefined behaviour on some drivers: make it invisible as well
        size[i] = 0;
        col[i * 4 + 3] = 0;
        continue;
      }
      const p = i * 3;
      const drag = Math.max(0, 1 - data[o + 6] * dt);
      vel[p] *= drag;
      vel[p + 1] = vel[p + 1] * drag - data[o + 5] * dt;
      vel[p + 2] *= drag;
      pos[p] += vel[p] * dt;
      pos[p + 1] += vel[p + 1] * dt;
      pos[p + 2] += vel[p + 2] * dt;
      const k = data[o] / data[o + 1]; // 1 -> 0
      size[i] = data[o + 3] + (data[o + 2] - data[o + 3]) * k;
      col[i * 4 + 3] = data[o + 4] * Math.min(1, k * 2.2);
    }
    this.geo.attributes.position.needsUpdate = true;
    this.geo.attributes.pcolor.needsUpdate = true;
    this.geo.attributes.psize.needsUpdate = true;
  }
}

const _dir = new THREE.Vector3();
const _z = new THREE.Vector3(0, 0, 1);

/** Every transient visual: sparks, dust, light flashes, shock rings, the hero's beam. */
export class FX {
  constructor(scene) {
    this.scene = scene;
    this.sparks = new Particles(scene, 1800, THREE.AdditiveBlending);
    this.smoke = new Particles(scene, 700, THREE.NormalBlending);
    this.trauma = 0;

    this.flashes = [];
    for (let i = 0; i < 2; i++) {
      const light = new THREE.PointLight(0xffffff, 0, 0, 2);
      scene.add(light);
      this.flashes.push({ light, t: 0, dur: 1, peak: 0 });
    }

    this.rings = [];
    const ringGeo = new THREE.RingGeometry(0.82, 1, 56);
    for (let i = 0; i < 8; i++) {
      const mesh = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, fog: false }));
      mesh.visible = false;
      scene.add(mesh);
      this.rings.push({ mesh, t: 0, dur: 1, size: 1 });
    }

    this.beam = this.makeBeam();
  }

  makeBeam() {
    const group = new THREE.Group();
    const geo = new THREE.CylinderGeometry(1, 1, 1, 20, 1, true);
    geo.rotateX(Math.PI / 2);
    geo.translate(0, 0, 0.5); // runs from z = 0 to z = 1
    const layer = (r, color, opacity) => {
      const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, fog: false }));
      m.userData.r = r;
      group.add(m);
      return m;
    };
    this.beamLayers = [layer(0.28, new THREE.Color(2.4, 2.7, 3), 1), layer(0.7, new THREE.Color(0.25, 1.1, 1.8), 0.5), layer(1.25, new THREE.Color(0.06, 0.3, 0.7), 0.2)];
    const orbMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(1.2, 2.0, 2.5), transparent: true, opacity: 0.75, depthWrite: false, blending: THREE.AdditiveBlending, fog: false });
    this.beamMuzzle = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 12), orbMat);
    this.beamImpact = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 12), orbMat);
    group.add(this.beamMuzzle);
    this.scene.add(this.beamImpact);
    this.beamImpact.visible = false;
    group.visible = false;
    this.scene.add(group);
    return group;
  }

  /** Position the beam for this frame. `width` scales its thickness (charge level). */
  setBeam(origin, dir, len, t, width = 1) {
    const b = this.beam;
    b.visible = true;
    b.position.copy(origin);
    b.quaternion.setFromUnitVectors(_z, _dir.copy(dir).normalize());
    const grow = Math.min(1, t / 0.12) * width;
    const wobble = 1 + Math.sin(t * 70) * 0.08;
    for (const m of this.beamLayers) m.scale.set(m.userData.r * grow * wobble, m.userData.r * grow * wobble, len);
    this.beamMuzzle.scale.setScalar(1.0 * grow + Math.sin(t * 50) * 0.12);
    this.beamImpact.visible = true;
    this.beamImpact.position.copy(origin).addScaledVector(_dir, len);
    this.beamImpact.scale.setScalar(1.6 * grow + Math.sin(t * 44) * 0.3);
    // streaks racing down the beam
    for (let i = 0; i < 3; i++) {
      const k = Math.random() * len;
      this.sparks.emit(
        origin.x + _dir.x * k + rand(-0.7, 0.7), origin.y + _dir.y * k + rand(-0.7, 0.7), origin.z + _dir.z * k + rand(-0.7, 0.7),
        _dir.x * 40, _dir.y * 40, _dir.z * 40, 0.22, 1.0, 0.15, 0.8, 2.2, 3.0, 0.8,
      );
    }
  }

  hideBeam() {
    this.beam.visible = false;
    this.beamImpact.visible = false;
  }

  shake(amount) {
    this.trauma = Math.min(1, this.trauma + amount);
  }

  /**
   * A brief point light. `color` is an rgb triple like every other FX call; it is normalised
   * so HDR spark colours do not multiply into the intensity, and the light is lifted off the
   * surface it was spawned on (a light touching a glossy surface overflows the float target).
   */
  flash(pos, color, peak, dur) {
    let slot = this.flashes[0];
    for (const f of this.flashes) if (f.t / f.dur > slot.t / slot.dur) slot = f;
    const top = Math.max(color[0], color[1], color[2], 1e-3);
    slot.light.position.set(pos.x, pos.y + 2.2, pos.z);
    slot.light.color.setRGB(color[0] / top, color[1] / top, color[2] / top);
    slot.t = 0;
    slot.dur = dur;
    slot.peak = peak;
  }

  ring(pos, color, size, dur = 0.5, flat = true) {
    const r = this.rings.find((x) => !x.mesh.visible) || this.rings[0];
    r.mesh.visible = true;
    r.mesh.position.copy(pos);
    r.mesh.rotation.set(flat ? -Math.PI / 2 : 0, 0, 0);
    r.mesh.material.color.setRGB(color[0], color[1], color[2]);
    r.flat = flat;
    r.t = 0;
    r.dur = dur;
    r.size = size;
  }

  /** Impact burst. `color` is an HDR rgb triple so the sparks bloom. */
  hit(pos, color, power = 1) {
    const n = Math.round(22 * power);
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const e = rand(-0.6, 1.2);
      const sp = rand(6, 26) * power;
      this.sparks.emit(pos.x, pos.y, pos.z, Math.cos(a) * Math.cos(e) * sp, Math.sin(e) * sp, Math.sin(a) * Math.cos(e) * sp, rand(0.18, 0.5), rand(0.5, 1.1) * power, 0.05, color[0], color[1], color[2], 1, 26, 2.5);
    }
    this.sparks.emit(pos.x, pos.y, pos.z, 0, 0, 0, 0.11, 2.0 * power, 0.8, color[0] * 0.5, color[1] * 0.5, color[2] * 0.5, 0.45);
    this.ring(pos, color, 3.2 * power, 0.28, false);
    this.flash(pos, color, 160 * power, 0.22);
  }

  block(pos) {
    for (let i = 0; i < 12; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = rand(8, 20);
      this.sparks.emit(pos.x, pos.y, pos.z, Math.cos(a) * sp, rand(-4, 10), Math.sin(a) * sp, rand(0.12, 0.3), 0.5, 0.05, 2.4, 2.8, 3.4, 1, 20, 3);
    }
    this.ring(pos, [1.4, 1.8, 2.4], 2.4, 0.22, false);
  }

  dust(x, y, z, n = 10, spread = 2, size = 3) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = rand(1, 5);
      const c = rand(0.22, 0.34);
      this.smoke.emit(x + Math.cos(a) * rand(0, spread), y + rand(0, 0.8), z + Math.sin(a) * rand(0, spread), Math.cos(a) * sp, rand(1, 4.5), Math.sin(a) * sp, rand(0.9, 2.2), size * rand(0.5, 0.9), size * rand(1.6, 2.6), c, c * 0.96, c * 0.9, rand(0.3, 0.55), -0.4, 1.4);
    }
  }

  debris(x, y, z, n = 14) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = rand(3, 12);
      this.smoke.emit(x, y + rand(0, 1.5), z, Math.cos(a) * sp, rand(5, 15), Math.sin(a) * sp, rand(0.7, 1.4), rand(0.25, 0.6), 0.2, 0.1, 0.1, 0.11, 1, 30, 0.3);
    }
  }

  explosion(pos, scale = 1, color = [5, 2.2, 0.5]) {
    const n = Math.round(46 * scale);
    const big = Math.min(scale, 1.3); // bigger blasts get more sparks, not screen-filling sprites
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const e = rand(-0.3, 1.4);
      const sp = rand(5, 30) * scale;
      this.sparks.emit(pos.x, pos.y, pos.z, Math.cos(a) * Math.cos(e) * sp, Math.sin(e) * sp, Math.sin(a) * Math.cos(e) * sp, rand(0.4, 1.1), rand(1, 2.4) * scale, 0.1, color[0], color[1], color[2], 1, 12, 1.6);
    }
    for (let i = 0; i < 5; i++) {
      this.sparks.emit(pos.x + rand(-1, 1) * scale, pos.y + rand(-1, 1) * scale, pos.z + rand(-1, 1) * scale, rand(-2, 2), rand(1, 5), rand(-2, 2), rand(0.3, 0.6), 6 * big, 11 * big, color[0] * 0.6, color[1] * 0.6, color[2] * 0.6, 0.6, 0, 1);
    }
    this.dust(pos.x, pos.y, pos.z, Math.round(10 * big), 2.5 * scale, 4.5 * big);
    this.ring(new THREE.Vector3(pos.x, 0.3, pos.z), color, 14 * scale, 0.7, true);
    this.flash(pos, color, 700 * Math.min(scale, 1.5), 0.6);
    this.shake(0.5 * scale);
  }

  trail(pos, color, size = 1.2) {
    this.sparks.emit(pos.x + rand(-0.3, 0.3), pos.y + rand(-0.3, 0.3), pos.z + rand(-0.3, 0.3), rand(-1, 1), rand(-1, 1), rand(-1, 1), rand(0.25, 0.45), size, 0.1, color[0], color[1], color[2], 0.9);
  }

  /** Motes drawn in toward a point (charging up). */
  gather(pos, color, radius = 5) {
    const a = Math.random() * Math.PI * 2;
    const e = rand(-1.2, 1.2);
    const x = Math.cos(a) * Math.cos(e) * radius;
    const y = Math.sin(e) * radius;
    const z = Math.sin(a) * Math.cos(e) * radius;
    const life = 0.35;
    this.sparks.emit(pos.x + x, pos.y + y, pos.z + z, -x / life, -y / life, -z / life, life, 0.3, 0.9, color[0], color[1], color[2], 1);
  }

  update(dt, camera, viewportHeight) {
    const scale = viewportHeight / (2 * Math.tan((camera.fov * Math.PI) / 360));
    for (const p of [this.sparks, this.smoke]) {
      p.mat.uniforms.uScale.value = scale;
      p.mat.uniforms.uMaxSize.value = Math.min(480, viewportHeight * 0.45);
    }
    this.sparks.update(dt);
    this.smoke.update(dt);
    this.trauma = Math.max(0, this.trauma - dt * 1.6);

    for (const f of this.flashes) {
      f.t += dt;
      const k = Math.max(0, 1 - f.t / f.dur);
      f.light.intensity = f.peak * k * k;
    }
    for (const r of this.rings) {
      if (!r.mesh.visible) continue;
      r.t += dt;
      const k = r.t / r.dur;
      if (k >= 1) {
        r.mesh.visible = false;
        continue;
      }
      r.mesh.scale.setScalar(r.size * (0.15 + 0.85 * (1 - (1 - k) ** 3)));
      r.mesh.material.opacity = (1 - k) * 0.9;
      if (!r.flat) r.mesh.quaternion.copy(camera.quaternion);
    }
  }
}
