// The night world: fog, lights, grid ground, the pipeline road, and the
// pedestal factory shared by every district.

import * as THREE from "three";
import { makeLabelSprite } from "/viewer/text.js";

// District anchors along the road (the road runs along +X, at z = 0).
export const DISTRICT_X = {
  source: 0,
  lex: 45,
  parse: 90,
  modules: 135,
  typecheck: 180,
  codegen: 225,
  link: 268,
  run: 305,
};

export const ROAD_HALF_WIDTH = 4;

export const STATE_COLORS = {
  locked: { base: 0x1a2038, glow: 0x232c50, intensity: 0.15 },
  ready: { base: 0x123524, glow: 0x2fbf71, intensity: 1.0 },
  running: { base: 0x3a2f10, glow: 0xe8b93c, intensity: 1.2 },
  done: { base: 0x101c3a, glow: 0x3c78e8, intensity: 0.5 },
  failed: { base: 0x3a1010, glow: 0xe84a4a, intensity: 1.2 },
};

export function createWorld() {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x05060f);
  scene.fog = new THREE.FogExp2(0x05060f, 0.0048);

  const hemi = new THREE.HemisphereLight(0x3a4a8a, 0x0a0c18, 1.5);
  scene.add(hemi);
  const moon = new THREE.DirectionalLight(0x8899ff, 1.0);
  moon.position.set(-80, 120, 60);
  scene.add(moon);

  // Ground: a dark disc plus a faint grid.
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(1400, 1400),
    new THREE.MeshStandardMaterial({ color: 0x0a0d1c, roughness: 1 })
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.set(160, -0.05, 0);
  scene.add(ground);

  const grid = new THREE.GridHelper(1400, 280, 0x2a3a68, 0x1a2444);
  grid.position.set(160, 0, 0);
  scene.add(grid);

  // Stars.
  {
    const n = 700;
    const pos = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = 400 + Math.random() * 500;
      pos[i * 3] = 160 + Math.cos(a) * r;
      pos[i * 3 + 1] = 90 + Math.random() * 320;
      pos[i * 3 + 2] = Math.sin(a) * r;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    const stars = new THREE.Points(
      g,
      new THREE.PointsMaterial({ color: 0x9fb4ff, size: 1.6, sizeAttenuation: false, fog: false })
    );
    scene.add(stars);
  }

  // The pipeline road.
  const roadLen = 380;
  const roadCx = 152;
  const road = new THREE.Mesh(
    new THREE.PlaneGeometry(roadLen, ROAD_HALF_WIDTH * 2),
    new THREE.MeshStandardMaterial({ color: 0x141a30, roughness: 0.9 })
  );
  road.rotation.x = -Math.PI / 2;
  road.position.set(roadCx, 0.01, 0);
  scene.add(road);

  const edgeMat = new THREE.MeshBasicMaterial({ color: 0x2fd8e8 });
  for (const side of [-1, 1]) {
    const edge = new THREE.Mesh(new THREE.BoxGeometry(roadLen, 0.06, 0.12), edgeMat);
    edge.position.set(roadCx, 0.03, side * ROAD_HALF_WIDTH);
    scene.add(edge);
  }
  // Center dashes.
  {
    const dash = new THREE.BoxGeometry(1.6, 0.04, 0.14);
    const dashMat = new THREE.MeshBasicMaterial({ color: 0x22518a });
    const count = Math.floor(roadLen / 6);
    const dashes = new THREE.InstancedMesh(dash, dashMat, count);
    const m = new THREE.Matrix4();
    for (let i = 0; i < count; i++) {
      m.setPosition(roadCx - roadLen / 2 + 3 + i * 6, 0.02, 0);
      dashes.setMatrixAt(i, m);
    }
    scene.add(dashes);
  }

  return { scene };
}

// A pedestal the player triggers a stage from. Returns a group with:
//   setState(state)  - locked | ready | running | done | failed
//   interactMesh     - what the raycaster should hit
export function makePedestal(stage, position) {
  const group = new THREE.Group();
  group.position.copy(position);

  const baseMat = new THREE.MeshStandardMaterial({
    color: 0x1a2038,
    roughness: 0.5,
    metalness: 0.4,
  });
  const base = new THREE.Mesh(new THREE.CylinderGeometry(0.65, 0.85, 1.0, 8), baseMat);
  base.position.y = 0.5;
  group.add(base);

  const crystalMat = new THREE.MeshStandardMaterial({
    color: 0x232c50,
    emissive: 0x232c50,
    emissiveIntensity: 0.5,
    roughness: 0.3,
  });
  const crystal = new THREE.Mesh(new THREE.OctahedronGeometry(0.34), crystalMat);
  crystal.position.y = 1.55;
  group.add(crystal);

  const ringMat = new THREE.MeshBasicMaterial({
    color: 0x232c50,
    transparent: true,
    opacity: 0.8,
    side: THREE.DoubleSide,
  });
  const ring = new THREE.Mesh(new THREE.RingGeometry(1.05, 1.25, 40), ringMat);
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.03;
  group.add(ring);

  const light = new THREE.PointLight(0x2fbf71, 0, 9);
  light.position.y = 2;
  group.add(light);

  const label = makeLabelSprite(stage.toUpperCase(), { worldH: 0.55, color: "#9fd8ff" });
  label.position.y = 2.35;
  group.add(label);

  const ped = {
    group,
    stage,
    crystal,
    interactMesh: base,
    state: "locked",
    setState(state) {
      ped.state = state;
      const c = STATE_COLORS[state] || STATE_COLORS.locked;
      crystalMat.emissive.setHex(c.glow);
      crystalMat.color.setHex(c.base);
      crystalMat.emissiveIntensity = c.intensity;
      ringMat.color.setHex(c.glow);
      light.color.setHex(c.glow);
      light.intensity = c.intensity * 30;
    },
    idle(t) {
      crystal.rotation.y = t * 0.9;
      crystal.position.y = 1.55 + Math.sin(t * 1.7) * 0.07;
      if (ped.state === "ready") {
        ringMat.opacity = 0.55 + Math.sin(t * 3) * 0.3;
      }
    },
  };
  base.userData.pedestal = ped;
  crystal.userData.pedestal = ped;
  ped.setState("locked");
  return ped;
}

// A glowing tube along a curve; used for module bridges and CFG catwalks.
// Returns { mesh, reveal(k) } where reveal(0..1) grows it along its length.
export function makeGlowTube(curve, radius, color, segments) {
  const seg = segments || 40;
  const geo = new THREE.TubeGeometry(curve, seg, radius, 6, false);
  const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.85 });
  const mesh = new THREE.Mesh(geo, mat);
  const total = geo.index.count;
  geo.setDrawRange(0, 0);
  return {
    mesh,
    reveal(k) {
      geo.setDrawRange(0, Math.floor(total * Math.max(0, Math.min(1, k))));
    },
  };
}
