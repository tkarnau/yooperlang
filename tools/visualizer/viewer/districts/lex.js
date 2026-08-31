// LEXER CONVEYOR: tokens as colored blocks riding a snaking belt loop.

import * as THREE from "three";
import { makePlaque } from "/viewer/text.js";
import { makeGhost, revealDelay } from "/viewer/districts/common.js";

const KIND_COLORS = {
  kw: 0xe86ab4,
  ident: 0x7fd4ff,
  num: 0xffd970,
  str: 0x7fe0a8,
  punct: 0x8a93b8,
  comment: 0x4a5578,
  other: 0xc0c0d8,
};

const MAX_TOKENS = 300;
const SPACING = 0.62;
const BELT_SPEED = 0.45;

export function create(ctx, x) {
  const group = new THREE.Group();
  group.position.set(x, 0, 0);
  ctx.scene.add(group);

  const ghost = makeGhost("LEX", 34, 5, 24);
  ghost.position.set(0, 0, 17);
  group.add(ghost);

  const light = new THREE.PointLight(0xe86ab4, 0, 40);
  light.position.set(0, 8, 16);
  group.add(light);

  // Serpentine closed loop beside the road.
  const pts = [];
  const rows = 6;
  const rowZ0 = 7;
  const rowDz = 4.2;
  const halfLen = 16;
  for (let r = 0; r < rows; r++) {
    const z = rowZ0 + r * rowDz;
    if (r % 2 === 0) {
      pts.push(new THREE.Vector3(-halfLen, 1.0, z), new THREE.Vector3(halfLen, 1.0, z));
    } else {
      pts.push(new THREE.Vector3(halfLen, 1.0, z), new THREE.Vector3(-halfLen, 1.0, z));
    }
  }
  // Return leg to close the loop.
  pts.push(new THREE.Vector3(-halfLen - 4, 1.0, rowZ0 + (rows - 1) * rowDz));
  pts.push(new THREE.Vector3(-halfLen - 4, 1.0, rowZ0 - 2));
  const curve = new THREE.CatmullRomCurve3(pts, true, "catmullrom", 0.2);
  const beltLen = curve.getLength();
  const LUT = 2400;
  const lutPts = curve.getSpacedPoints(LUT);

  // Belt ribbon.
  const belt = new THREE.Mesh(
    new THREE.TubeGeometry(curve, 400, 0.55, 6, true),
    new THREE.MeshStandardMaterial({ color: 0x121a34, roughness: 0.8, metalness: 0.3 })
  );
  belt.scale.y = 0.22;
  belt.position.y = 0.75;
  belt.visible = false;
  group.add(belt);

  // Emissive belt edge strip.
  const strip = new THREE.Mesh(
    new THREE.TubeGeometry(curve, 400, 0.06, 4, true),
    new THREE.MeshBasicMaterial({ color: 0x30407a })
  );
  strip.visible = false;
  group.add(strip);

  const district = {
    name: "lex",
    group,
    materialize(data, tl, c) {
      ghost.visible = false;
      const tokens = data.tokens || [];
      const shown = Math.min(tokens.length, MAX_TOKENS);
      const hidden = tokens.length - shown;

      const geo = new THREE.BoxGeometry(0.55, 0.45, 0.45);
      const mat = new THREE.MeshStandardMaterial({ roughness: 0.35, metalness: 0.15 });
      const inst = new THREE.InstancedMesh(geo, mat, shown);
      inst.count = 0;
      const color = new THREE.Color();
      for (let i = 0; i < shown; i++) {
        color.setHex(KIND_COLORS[tokens[i].kind] || KIND_COLORS.other);
        inst.setColorAt(i, color);
      }
      inst.instanceColor.needsUpdate = true;
      group.add(inst);
      ctx.interactables.push(inst);

      inst.userData.viz = (id) => {
        if (id === undefined || id === null || id >= shown) return null;
        const t = tokens[id];
        return {
          title: "token " + t.kind + " (" + t.tag + ")",
          lines: [JSON.stringify(t.text), "line " + t.line + ", col " + t.col + ", len " + t.len],
          span: { line: t.line, col: t.col, len: t.len },
        };
      };

      // Ride the belt.
      let beltT = 0;
      const m = new THREE.Matrix4();
      const q = new THREE.Quaternion();
      const up = new THREE.Vector3(0, 1, 0);
      ctx.addIdle((t, dt) => {
        if (!belt.visible) return;
        beltT += dt * BELT_SPEED;
        for (let i = 0; i < inst.count; i++) {
          const arc = (i * SPACING + beltT) % beltLen;
          const u = arc / beltLen;
          const idx = Math.min(LUT - 1, Math.floor(u * LUT));
          const p = lutPts[idx];
          const p2 = lutPts[(idx + 1) % LUT];
          const yaw = Math.atan2(p2.x - p.x, p2.z - p.z);
          q.setFromAxisAngle(up, yaw);
          m.makeRotationFromQuaternion(q);
          m.setPosition(p.x, 1.35, p.z);
          inst.setMatrixAt(i, m);
        }
        inst.instanceMatrix.needsUpdate = true;
      });

      tl.seq(0.2, () => {
        belt.visible = true;
        strip.visible = true;
      });
      tl.tween(0.2, 1.0, (k) => {
        light.intensity = k * 80;
      });
      // The signature slow reveal: one token at a time in token order.
      const per = revealDelay(shown, 12, 26);
      for (let i = 1; i <= shown; i++) {
        tl.seq(per, () => {
          inst.count = i;
        });
      }
      tl.seq(0.3, () => {
        const lines = [
          { text: tokens.length + " tokens", color: "#9fd8ff", fontPx: 36 },
          "kw/ident/num/str/punct by color",
        ];
        if (hidden > 0) lines.push({ text: "+" + hidden + " more not shown", color: "#e8b93c" });
        const plaque = makePlaque(lines, { worldW: 3.6 });
        plaque.position.set(-halfLen - 1, 0, rowZ0 - 2.4);
        group.add(plaque);
      });
    },
  };
  return district;
}
