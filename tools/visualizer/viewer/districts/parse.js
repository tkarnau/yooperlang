// AST GROVE: the parse tree as a canopy. Root at the ground, children fan
// upward and outward; leaf angles come from depth-first order so siblings
// cluster.

import * as THREE from "three";
import { makeLabelSprite, makePlaque } from "/viewer/text.js";
import { makeGhost, revealDelay } from "/viewer/districts/common.js";

const MAX_NODES = 800;
const MAX_LABELS = 60;

const CAT_COLORS = {
  decl: 0x2fbf71,
  stmt: 0x3c78e8,
  expr: 0xe8b93c,
  type: 0xa06ae8,
  other: 0x8a93b8,
};

function category(kind) {
  if (kind.includes("TYPE")) return "type";
  if (kind.includes("DECL") || kind === "PARAM") return "decl";
  if (
    kind.includes("STATEMENT") ||
    kind === "BLOCK" ||
    kind === "ASSIGNMENT" ||
    kind === "EXTERN_BLOCK"
  ) {
    return "stmt";
  }
  if (
    kind.includes("EXPRESSION") ||
    kind.includes("LITERAL") ||
    kind.includes("PART") ||
    kind === "IDENT" ||
    kind === "CALL" ||
    kind.includes("ACCESS") ||
    kind.includes("REF") ||
    kind.includes("PREFIX")
  ) {
    return "expr";
  }
  return "other";
}

export function create(ctx, x) {
  const group = new THREE.Group();
  group.position.set(x, 0, -20);
  ctx.scene.add(group);

  const ghost = makeGhost("PARSE", 26, 20, 26);
  ghost.position.set(0, 0, 0);
  group.add(ghost);

  const light = new THREE.PointLight(0x7fe0a8, 0, 45);
  light.position.set(0, 12, 0);
  group.add(light);

  const district = {
    name: "parse",
    group,
    materialize(data, tl, c) {
      ghost.visible = false;

      // Flatten depth-first; a DFS prefix is always a connected subtree.
      const flat = [];
      (function walk(node, depth, parentIdx) {
        if (flat.length >= MAX_NODES) return;
        const idx = flat.length;
        flat.push({ node, depth, parentIdx, leaves: 0, angle: 0 });
        for (const ch of node.children) walk(ch, depth + 1, idx);
      })(data.ast, 0, -1);
      const hidden = data.nodeCount - flat.length;

      // Leaf counting (children beyond the cap count as leaves of their kept
      // ancestor via the DFS prefix truncation).
      for (let i = flat.length - 1; i >= 0; i--) {
        if (flat[i].leaves === 0) flat[i].leaves = 1;
        if (flat[i].parentIdx >= 0) flat[flat[i].parentIdx].leaves += flat[i].leaves;
      }

      // Angles: leaves take slots around the trunk in DFS order; internal
      // nodes average their children.
      const totalLeaves = flat[0].leaves;
      let leafSeen = 0;
      const childIdx = flat.map(() => []);
      for (let i = 1; i < flat.length; i++) childIdx[flat[i].parentIdx].push(i);
      (function assign(idx) {
        const f = flat[idx];
        const kids = childIdx[idx];
        if (kids.length === 0) {
          f.angle = (leafSeen / Math.max(1, totalLeaves)) * Math.PI * 2;
          leafSeen++;
          return;
        }
        let sum = 0;
        for (const k of kids) {
          assign(k);
          sum += flat[k].angle;
        }
        f.angle = sum / kids.length;
      })(0);

      const maxDepth = Math.max(1, data.maxDepth);
      const radStep = Math.min(1.6, 18 / maxDepth);
      const yStep = Math.min(1.9, 19 / maxDepth);
      const positions = flat.map((f) => {
        if (f.depth === 0) return new THREE.Vector3(0, 0.8, 0);
        const r = 1.2 + f.depth * radStep;
        return new THREE.Vector3(
          Math.sin(f.angle) * r,
          1.2 + f.depth * yStep,
          Math.cos(f.angle) * r
        );
      });

      // Node boxes.
      const geo = new THREE.BoxGeometry(0.55, 0.55, 0.55);
      const mat = new THREE.MeshStandardMaterial({ roughness: 0.4, metalness: 0.1 });
      const inst = new THREE.InstancedMesh(geo, mat, flat.length);
      inst.count = 0;
      const color = new THREE.Color();
      const m = new THREE.Matrix4();
      for (let i = 0; i < flat.length; i++) {
        color.setHex(CAT_COLORS[category(flat[i].node.kind)]);
        inst.setColorAt(i, color);
        m.setPosition(positions[i]);
        inst.setMatrixAt(i, m);
      }
      inst.instanceColor.needsUpdate = true;
      group.add(inst);
      ctx.interactables.push(inst);
      inst.userData.viz = (id) => {
        if (id === undefined || id === null || id >= flat.length) return null;
        const n = flat[id].node;
        const lines = ["kind: " + n.kind];
        if (n.label) lines.push("label: " + n.label);
        if (n.slot) lines.push("slot: " + n.slot);
        let span = null;
        if (n.span) {
          lines.push("line " + n.span.line + ", col " + n.span.col + ", len " + n.span.length);
          span = { line: n.span.line, col: n.span.col, len: n.span.length };
        }
        return { title: "ast node #" + n.id, lines, span };
      };

      // Edges as vines: one segment per non-root node, revealed with it.
      const edgePos = new Float32Array((flat.length - 1) * 6);
      const edgeIdxOfNode = new Array(flat.length).fill(-1);
      let e = 0;
      for (let i = 1; i < flat.length; i++) {
        const a = positions[flat[i].parentIdx];
        const b = positions[i];
        edgePos.set([a.x, a.y, a.z, b.x, b.y, b.z], e * 6);
        edgeIdxOfNode[i] = e;
        e++;
      }
      const edgeGeo = new THREE.BufferGeometry();
      edgeGeo.setAttribute("position", new THREE.BufferAttribute(edgePos, 3));
      edgeGeo.setDrawRange(0, 0);
      const edges = new THREE.LineSegments(
        edgeGeo,
        new THREE.LineBasicMaterial({ color: 0x3f8f5f, transparent: true, opacity: 0.75 })
      );
      group.add(edges);

      // Labels for labeled nodes with real subtrees.
      const labelable = [];
      for (let i = 0; i < flat.length; i++) {
        const n = flat[i].node;
        if (n.label && (flat[i].leaves >= 2 || flat[i].depth <= 2)) labelable.push(i);
        else if (!n.label && flat[i].leaves >= 8) labelable.push(i);
      }
      const labels = new Map();
      for (const i of labelable.slice(0, MAX_LABELS)) {
        const n = flat[i].node;
        const spr = makeLabelSprite(n.label || n.kind, {
          worldH: 0.42,
          color: "#d8ffe8",
          bg: "rgba(6,18,12,0.7)",
        });
        spr.position.copy(positions[i]);
        spr.position.y += 0.7;
        spr.visible = false;
        group.add(spr);
        labels.set(i, spr);
      }

      tl.tween(0.1, 1.0, (k) => {
        light.intensity = k * 90;
      });
      const per = revealDelay(flat.length, 20, 22);
      for (let i = 0; i < flat.length; i++) {
        tl.seq(per, () => {
          inst.count = i + 1;
          const ei = edgeIdxOfNode[i];
          if (ei >= 0) edgeGeo.setDrawRange(0, (ei + 1) * 2);
          const spr = labels.get(i);
          if (spr) spr.visible = true;
        });
      }
      tl.seq(0.3, () => {
        const lines = [
          { text: data.nodeCount + " nodes, depth " + data.maxDepth, color: "#9fd8ff", fontPx: 34 },
          "decl green, stmt blue, expr amber, type violet",
        ];
        if (hidden > 0) lines.push({ text: "+" + hidden + " nodes not shown", color: "#e8b93c" });
        const plaque = makePlaque(lines, { worldW: 4 });
        plaque.position.set(4, 0, 14);
        group.add(plaque);
      });
    },
  };
  return district;
}
