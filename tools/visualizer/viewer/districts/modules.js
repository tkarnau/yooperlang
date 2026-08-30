// MODULE ARCHIPELAGO: floating islands, one per module, bridges per import
// edge. The main module floats nearest the road.

import * as THREE from "three";
import { makeLabelSprite, makePlaque } from "/viewer/text.js";
import { makeGhost, revealDelay } from "/viewer/districts/common.js";
import { makeGlowTube } from "/viewer/world.js";

const ROOT_COLORS = {
  main: 0xfff0c0,
  std: 0x2fd8e8,
  modules: 0xe86ab4,
  local: 0x7fe0a8,
};

const MAX_ISLANDS = 40;

export function create(ctx, x) {
  const group = new THREE.Group();
  group.position.set(x, 0, 0);
  ctx.scene.add(group);

  const ghost = makeGhost("MODULES", 30, 18, 30);
  ghost.position.set(0, 0, 26);
  group.add(ghost);

  const light = new THREE.PointLight(0x2fd8e8, 0, 60);
  light.position.set(0, 16, 26);
  group.add(light);

  const district = {
    name: "modules",
    group,
    materialize(data, tl, c) {
      ghost.visible = false;
      const nodes = (data.nodes || []).slice(0, MAX_ISLANDS);
      const hidden = (data.nodes || []).length - nodes.length;

      // Layout: main nearest the road, the rest fanned further out.
      const posOf = new Map();
      const mainNode = nodes.find((n) => n.root === "main") || nodes[0];
      const rest = nodes.filter((n) => n !== mainNode);
      rest.sort((a, b) => (a.root + a.id).localeCompare(b.root + b.id));
      posOf.set(mainNode.id, new THREE.Vector3(0, 9, 13));
      rest.forEach((n, i) => {
        const ring = Math.floor(i / 7);
        const inRing = i % 7;
        const count = Math.min(7, rest.length - ring * 7);
        const a = (inRing / count) * Math.PI * 1.15 - Math.PI * 0.07;
        const r = 15 + ring * 11;
        posOf.set(
          n.id,
          new THREE.Vector3(
            Math.cos(a) * r * 0.9,
            8 + ((i * 7) % 5) * 1.8,
            14 + Math.sin(a) * r * 0.8
          )
        );
      });

      const islands = [];
      nodes.forEach((n, i) => {
        const iGroup = new THREE.Group();
        const p = posOf.get(n.id);
        iGroup.position.copy(p);
        const topR = 1.4 + Math.log2(n.loc + 2) * 0.34;
        const colorHex = ROOT_COLORS[n.root] || 0xc0c0d8;
        const rock = new THREE.Mesh(
          new THREE.ConeGeometry(topR, topR * 1.5, 7),
          new THREE.MeshStandardMaterial({ color: 0x1a2240, roughness: 0.9, flatShading: true })
        );
        rock.rotation.x = Math.PI;
        rock.position.y = -topR * 0.75;
        iGroup.add(rock);
        const top = new THREE.Mesh(
          new THREE.CylinderGeometry(topR, topR * 1.02, 0.35, 7),
          new THREE.MeshStandardMaterial({
            color: colorHex,
            emissive: colorHex,
            emissiveIntensity: n.root === "main" ? 0.7 : 0.35,
            roughness: 0.5,
          })
        );
        iGroup.add(top);
        const spr = makeLabelSprite(n.name, {
          worldH: 0.7,
          color: "#" + new THREE.Color(colorHex).getHexString(),
        });
        spr.position.y = 1.6;
        iGroup.add(spr);
        iGroup.visible = false;
        iGroup.scale.setScalar(0.01);
        group.add(iGroup);
        ctx.interactables.push(top);
        top.userData.viz = {
          title: "module " + n.name,
          lines: [n.id, "root: " + n.root, n.files + " file(s), " + n.loc + " loc"],
        };
        islands.push({ n, iGroup, phase: i * 1.3, baseY: p.y });
      });

      ctx.addIdle((t) => {
        for (const isl of islands) {
          if (!isl.iGroup.visible) continue;
          isl.iGroup.position.y = isl.baseY + Math.sin(t * 0.6 + isl.phase) * 0.35;
        }
      });

      // Bridges.
      const bridges = [];
      for (const e of data.edges || []) {
        const a = posOf.get(e.from);
        const b = posOf.get(e.to);
        if (!a || !b) continue;
        const mid = a.clone().lerp(b, 0.5);
        mid.y += a.distanceTo(b) * 0.25;
        const curve = new THREE.QuadraticBezierCurve3(a, mid, b);
        const toNode = nodes.find((n) => n.id === e.to);
        const col = ROOT_COLORS[toNode ? toNode.root : "std"] || 0x2fd8e8;
        const tube = makeGlowTube(curve, 0.07, col, 36);
        tube.mesh.material.opacity = 0.55;
        group.add(tube.mesh);
        bridges.push(tube);
      }

      tl.tween(0.1, 1.2, (k) => {
        light.intensity = k * 140;
      });
      const per = revealDelay(islands.length, 2.2, 10);
      for (const isl of islands) {
        tl.seq(per, () => {
          isl.iGroup.visible = true;
        });
        tl.tween(tl.cursor, 0.5, (k) => {
          isl.iGroup.scale.setScalar(0.01 + 0.99 * k);
        }, 8);
      }
      for (const b of bridges) {
        tl.tween(tl.cursor + 0.1, 0.7, (k) => b.reveal(k), 12);
      }
      tl.seq(0.3, () => {
        const lines = [
          { text: nodes.length + " modules, " + (data.edges || []).length + " imports", color: "#9fd8ff", fontPx: 34 },
          "gold main, cyan std, magenta modules, green local",
        ];
        if (hidden > 0) lines.push({ text: "+" + hidden + " more not shown", color: "#e8b93c" });
        const plaque = makePlaque(lines, { worldW: 4.4 });
        plaque.position.set(-4, 0, 7);
        plaque.rotation.y = Math.PI; // face the road
        group.add(plaque);
      });
    },
  };
  return district;
}
