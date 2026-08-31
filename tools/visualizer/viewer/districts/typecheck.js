// TYPECHECK GATE: a monumental gate across the road. data.ok opens it; a
// failed check keeps it shut and the road blocked, like the real pipeline.

import * as THREE from "three";
import { makePlaque, makeTextPanel } from "/viewer/text.js";
import { revealDelay } from "/viewer/districts/common.js";

const MAX_DECLS = 24;
const MAX_DIAGS = 30;

export function create(ctx, x) {
  const group = new THREE.Group();
  group.position.set(x, 0, 0);
  ctx.scene.add(group);

  const stone = new THREE.MeshStandardMaterial({ color: 0x1c2440, roughness: 0.7, metalness: 0.2 });

  // Pillars and lintel exist from the start; the gate is the district.
  for (const side of [-1, 1]) {
    const pillar = new THREE.Mesh(new THREE.BoxGeometry(3, 13, 3), stone);
    pillar.position.set(0, 6.5, side * 6.5);
    group.add(pillar);
    // Flanking walls the decl plaques hang on.
    const wall = new THREE.Mesh(new THREE.BoxGeometry(1.2, 4.5, 12), stone);
    wall.position.set(0, 2.25, side * (6.5 + 1.5 + 6));
    group.add(wall);
  }
  const lintel = new THREE.Mesh(new THREE.BoxGeometry(4, 2.4, 16), stone);
  lintel.position.set(0, 13.5, 0);
  group.add(lintel);

  const runeMat = new THREE.MeshBasicMaterial({ color: 0x26305a });
  const rune = new THREE.Mesh(new THREE.PlaneGeometry(12, 1.2), runeMat);
  rune.position.set(-2.05, 13.5, 0);
  rune.rotation.y = -Math.PI / 2;
  group.add(rune);

  const doorMat = new THREE.MeshStandardMaterial({
    color: 0x141b36,
    roughness: 0.4,
    metalness: 0.6,
  });
  const doors = [];
  for (const side of [-1, 1]) {
    const door = new THREE.Mesh(new THREE.BoxGeometry(0.8, 11.5, 5.2), doorMat);
    door.position.set(0, 5.75, side * 2.55);
    group.add(door);
    doors.push({ mesh: door, side, closedZ: side * 2.55 });
  }

  // Light shaft revealed as the doors part.
  const shaft = new THREE.Mesh(
    new THREE.PlaneGeometry(10, 11),
    new THREE.MeshBasicMaterial({
      color: 0xbfe0ff,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    })
  );
  shaft.position.set(0.6, 5.5, 0);
  shaft.rotation.y = Math.PI / 2;
  group.add(shaft);

  const light = new THREE.PointLight(0xbfe0ff, 0, 45);
  light.position.set(0, 8, 0);
  group.add(light);

  const district = {
    name: "typecheck",
    group,
    materialize(data, tl, c) {
      const ok = data.ok !== false;

      tl.tween(0.1, 1.0, (k) => {
        light.intensity = k * (ok ? 90 : 60);
        light.color.setHex(ok ? 0xbfe0ff : 0xe84a4a);
        runeMat.color.lerpColors(
          new THREE.Color(0x26305a),
          new THREE.Color(ok ? 0x7fd4ff : 0xe84a4a),
          k
        );
      });

      // Diagnostics hover in front of the gate on the approach side.
      const diags = (data.diagnostics || []).slice(0, MAX_DIAGS);
      diags.forEach((d, i) => {
        const isErr = d.severity === "error";
        const sigil = new THREE.Mesh(
          new THREE.OctahedronGeometry(0.5),
          new THREE.MeshStandardMaterial({
            color: isErr ? 0xe84a4a : 0xe8b93c,
            emissive: isErr ? 0xe84a4a : 0xe8b93c,
            emissiveIntensity: 0.9,
            roughness: 0.3,
          })
        );
        const row = Math.floor(i / 6);
        const colI = i % 6;
        sigil.position.set(-6 - row * 2.2, 2.2 + (i % 3) * 1.4, (colI - 2.5) * 2.2);
        sigil.visible = false;
        group.add(sigil);
        ctx.interactables.push(sigil);
        sigil.userData.viz = {
          title: d.severity + " at line " + d.line + ":" + d.col,
          lines: [d.message],
          span: { line: d.line, col: d.col, len: 8 },
        };
        const phase = i * 0.9;
        ctx.addIdle((t) => {
          if (!sigil.visible) return;
          sigil.rotation.y = t * 1.2 + phase;
          sigil.position.y += Math.sin(t * 2 + phase) * 0.004;
        });
        tl.seq(0.35, () => {
          sigil.visible = true;
        });
      });

      if (ok) {
        // The gate opens, slowly, with light spilling through.
        tl.tween(tl.cursor + 0.4, 4.0, (k) => {
          for (const d of doors) {
            d.mesh.position.z = d.closedZ + d.side * 4.6 * k;
          }
          shaft.material.opacity = Math.sin(k * Math.PI) * 0.28 + k * 0.1;
          light.intensity = 90 + k * 90;
          if (k > 0.55) c.flags.gateOpen = true;
        }, 40);

        // Decl plaques along the flanking walls.
        const decls = (data.decls || []).slice(0, MAX_DECLS);
        const hidden = (data.decls || []).length - decls.length;
        decls.forEach((d, i) => {
          tl.seq(0.45, () => {
            const panel = makeTextPanel(
              [
                { text: d.name, color: "#9fd8ff", fontPx: 36 },
                { text: d.kind + " : " + d.type, fontPx: 28 },
                { text: "line " + d.line, color: "#5a668f", fontPx: 24 },
              ],
              { worldW: 2.6 }
            );
            const side = i % 2 === 0 ? 1 : -1;
            const slot = Math.floor(i / 2);
            panel.position.set(-0.62, 2.6, side * (7.2 + slot * 2.9));
            panel.rotation.y = -Math.PI / 2;
            group.add(panel);
            ctx.interactables.push(panel);
            panel.userData.viz = {
              title: "decl " + d.name,
              lines: [d.kind + " : " + d.type, "line " + d.line],
              span: { line: d.line, col: 1, len: 96 },
            };
          });
        });
        tl.seq(0.3, () => {
          const lines = [
            { text: "typecheck ok", color: "#7fe0a8", fontPx: 36 },
            (data.decls || []).length + " decl(s), " + diags.length + " diagnostic(s)",
          ];
          if (hidden > 0) lines.push({ text: "+" + hidden + " decls not shown", color: "#e8b93c" });
          const plaque = makePlaque(lines, { worldW: 3.4 });
          plaque.position.set(-5, 0, -7);
          group.add(plaque);
        });
      } else {
        tl.seq(0.5, () => {
          const plaque = makePlaque(
            [
              { text: "typecheck FAILED", color: "#ff8a8a", fontPx: 38 },
              "the gate stays shut - the pipeline is blocked",
              diags.length + " diagnostic(s) hover before the gate",
            ],
            { worldW: 4.2, borderColor: "#e84a4a" }
          );
          plaque.position.set(-6, 0, -7);
          group.add(plaque);
        });
      }
    },
    // Stage-level failure (HTTP ok:false): red glow, gate shut.
    materializeFailure(resp) {
      light.intensity = 70;
      light.color.setHex(0xe84a4a);
      runeMat.color.setHex(0xe84a4a);
    },
  };
  return district;
}
