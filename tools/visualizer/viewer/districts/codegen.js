// CODEGEN HALL: user functions as platforms, basic blocks as slabs joined by
// CFG catwalks, instructions as stacked bars. The std prelude is a dim
// skyline behind the hall.

import * as THREE from "three";
import { makeLabelSprite, makePlaque } from "/viewer/text.js";
import { makeGhost, revealDelay, humanBytes } from "/viewer/districts/common.js";
import { makeGlowTube } from "/viewer/world.js";

const MAX_FUNCTIONS = 12;
const MAX_INSTR_TOTAL = 1500;
const BARS_PER_COL = 22;
const COLS_PER_BLOCK = 4;

const GREEN_OPS = new Set([
  "add", "sub", "mul", "sdiv", "udiv", "srem", "urem", "fadd", "fsub", "fmul",
  "fdiv", "and", "or", "xor", "shl", "ashr", "lshr", "icmp", "fcmp", "sext",
  "zext", "trunc", "fptosi", "sitofp", "select",
]);

function opColor(op) {
  if (op === "call") return 0xff9a3c;
  if (op === "br" || op === "ret" || op === "switch" || op === "unreachable") return 0xe84a4a;
  if (op === "load" || op === "store") return 0x4a9ae8;
  if (GREEN_OPS.has(op)) return 0x2fbf71;
  return 0x8a93b8;
}

export function create(ctx, x) {
  const group = new THREE.Group();
  group.position.set(x, 0, 0);
  ctx.scene.add(group);

  const ghost = makeGhost("CODEGEN", 40, 8, 26);
  ghost.position.set(0, 0, -18);
  group.add(ghost);

  const light = new THREE.PointLight(0xff9a3c, 0, 55);
  light.position.set(0, 10, -16);
  group.add(light);

  const district = {
    name: "codegen",
    group,
    materialize(data, tl, c) {
      ghost.visible = false;

      const fns = (data.functions || []).slice(0, MAX_FUNCTIONS);
      const hiddenFns = (data.functions || []).length - fns.length;

      // Hall floor.
      const floor = new THREE.Mesh(
        new THREE.PlaneGeometry(44, 30),
        new THREE.MeshStandardMaterial({ color: 0x131a32, roughness: 0.85, metalness: 0.3 })
      );
      floor.rotation.x = -Math.PI / 2;
      floor.position.set(0, 0.03, -19);
      floor.visible = false;
      group.add(floor);
      tl.seq(0.2, () => {
        floor.visible = true;
      });
      tl.tween(0.2, 1.0, (k) => {
        light.intensity = k * 100;
      });

      // Precompute layout: platforms in a row along x, blocks along each
      // platform's local x, bars stacked per block.
      const barGeo = new THREE.BoxGeometry(2.0, 0.09, 0.5);
      const barMat = new THREE.MeshStandardMaterial({ roughness: 0.35, metalness: 0.2 });
      const barInfo = []; // per instance: { fn, block, inst }
      const barMatrices = [];
      const barColors = [];
      const slabPop = []; // { mesh, atBar } slabs pop before their bars
      const arcs = []; // { tube, afterBar }
      const color = new THREE.Color();
      const mat4 = new THREE.Matrix4();

      let fx = -18;
      let instrBudget = MAX_INSTR_TOTAL;
      for (const fn of fns) {
        const blockW = 2.6;
        const blockGap = 1.1;
        const platW = fn.blocks.length * (blockW + blockGap) + 2;
        const platform = new THREE.Mesh(
          new THREE.BoxGeometry(platW, 0.8, 6),
          new THREE.MeshStandardMaterial({ color: 0x1a2240, roughness: 0.6, metalness: 0.4 })
        );
        const pz = -12 - (fx > 0 ? 8 : 0);
        platform.position.set(fx + platW / 2 - 1, 0.4, pz);
        platform.visible = false;
        group.add(platform);
        const nameSpr = makeLabelSprite(fn.name, { worldH: 0.8, color: "#ffd0a0" });
        nameSpr.position.set(fx + platW / 2 - 1, 2.6 + 0.4, pz + 3.4);
        nameSpr.visible = false;
        group.add(nameSpr);
        slabPop.push({ mesh: platform, atBar: barInfo.length, extra: nameSpr });

        const slabPos = new Map();
        fn.blocks.forEach((b, bi) => {
          const bx = fx + 1 + bi * (blockW + blockGap);
          const slab = new THREE.Mesh(
            new THREE.BoxGeometry(blockW, 0.35, 3.2),
            new THREE.MeshStandardMaterial({
              color: 0x263252,
              roughness: 0.5,
              emissive: 0x121a34,
            })
          );
          slab.position.set(bx, 0.95, pz);
          slab.visible = false;
          group.add(slab);
          ctx.interactables.push(slab);
          slab.userData.viz = {
            title: fn.name + " : " + b.label,
            lines: [
              b.instructions.length + " instruction(s)",
              b.succ && b.succ.length ? "branches to " + b.succ.join(", ") : "terminates",
            ],
          };
          slabPos.set(b.label, new THREE.Vector3(bx, 1.15, pz));
          slabPop.push({ mesh: slab, atBar: barInfo.length });

          const shownInstr = Math.min(
            b.instructions.length,
            BARS_PER_COL * COLS_PER_BLOCK,
            Math.max(0, instrBudget)
          );
          for (let ii = 0; ii < shownInstr; ii++) {
            const colI = Math.floor(ii / BARS_PER_COL);
            const row = ii % BARS_PER_COL;
            mat4.makeRotationY(0);
            mat4.setPosition(bx, 1.2 + row * 0.13, pz - 1.15 + colI * 0.72);
            barMatrices.push(mat4.clone());
            color.setHex(opColor(b.instructions[ii].op));
            barColors.push(color.clone());
            barInfo.push({ fn, block: b, inst: b.instructions[ii] });
          }
          instrBudget -= shownInstr;
        });

        // CFG catwalks.
        fn.blocks.forEach((b) => {
          const a = slabPos.get(b.label);
          for (const s of b.succ || []) {
            const bp = slabPos.get(s);
            if (!a || !bp) continue;
            const mid = a.clone().lerp(bp, 0.5);
            mid.y += Math.max(1.6, a.distanceTo(bp) * 0.3);
            const curve = new THREE.QuadraticBezierCurve3(
              a.clone().add(new THREE.Vector3(0, 0.2, 0)),
              mid,
              bp.clone().add(new THREE.Vector3(0, 0.2, 0))
            );
            const tube = makeGlowTube(curve, 0.06, 0xe8b93c, 30);
            tube.mesh.material.opacity = 0.7;
            group.add(tube.mesh);
            arcs.push({ tube, afterBar: barInfo.length });
          }
        });

        fx += platW + 3;
      }

      const inst = new THREE.InstancedMesh(barGeo, barMat, Math.max(1, barMatrices.length));
      inst.count = 0;
      barMatrices.forEach((m, i) => inst.setMatrixAt(i, m));
      barColors.forEach((cc, i) => inst.setColorAt(i, cc));
      if (inst.instanceColor) inst.instanceColor.needsUpdate = true;
      group.add(inst);
      ctx.interactables.push(inst);
      inst.userData.viz = (id) => {
        if (id === undefined || id === null || id >= barInfo.length) return null;
        const b = barInfo[id];
        const lines = [b.inst.text];
        let span = null;
        if (b.inst.src) {
          lines.push("from source line " + b.inst.src.line + ":" + b.inst.src.col);
          span = { line: b.inst.src.line, col: 1, len: 96 };
        }
        return { title: b.fn.name + " : " + b.block.label + " [" + b.inst.op + "]", lines, span };
      };

      // Reveal: slabs and platforms pop as their first bar approaches; bars
      // one at a time; arcs draw after their function's bars.
      const per = revealDelay(barInfo.length, 10, 28);
      let popIdx = 0;
      let arcIdx = 0;
      for (let i = 0; i < barInfo.length; i++) {
        tl.seq(per, () => {
          while (popIdx < slabPop.length && slabPop[popIdx].atBar <= i) {
            slabPop[popIdx].mesh.visible = true;
            if (slabPop[popIdx].extra) slabPop[popIdx].extra.visible = true;
            popIdx++;
          }
          inst.count = i + 1;
        });
        while (arcIdx < arcs.length && arcs[arcIdx].afterBar === i + 1) {
          const arc = arcs[arcIdx];
          tl.tween(tl.cursor, 0.6, (k) => arc.tube.reveal(k), 10);
          arcIdx++;
        }
      }
      tl.seq(0.05, () => {
        while (popIdx < slabPop.length) {
          slabPop[popIdx].mesh.visible = true;
          if (slabPop[popIdx].extra) slabPop[popIdx].extra.visible = true;
          popIdx++;
        }
        while (arcIdx < arcs.length) {
          arcs[arcIdx].tube.reveal(1);
          arcIdx++;
        }
      });

      // The std prelude skyline, distant and dim.
      const stdFns = data.stdFunctions || [];
      if (stdFns.length > 0) {
        const towerGeo = new THREE.BoxGeometry(2.2, 1, 2.2);
        const towerMat = new THREE.MeshStandardMaterial({
          color: 0x1a2038,
          emissive: 0x1c2648,
          emissiveIntensity: 0.5,
          roughness: 0.9,
        });
        const towers = new THREE.InstancedMesh(towerGeo, towerMat, stdFns.length);
        stdFns.forEach((f, i) => {
          const h = Math.min(18, 1.5 + f.instructions * 0.05);
          const tx = -30 + (i % 14) * 4.6;
          const tz = -38 - Math.floor(i / 14) * 6;
          mat4.makeScale(1, h, 1);
          mat4.setPosition(tx, h / 2, tz);
          towers.setMatrixAt(i, mat4.clone());
        });
        towers.visible = false;
        group.add(towers);
        tl.seq(0.4, () => {
          towers.visible = true;
        });
      }

      tl.seq(0.3, () => {
        const lines = [
          { text: fns.length + " function(s), " + data.irLines + " IR lines", color: "#9fd8ff", fontPx: 34 },
          humanBytes(data.irBytes) + " of IR" + (data.truncated ? " (truncated)" : ""),
          "std prelude: " + (data.stdFunctionCount || 0) + " functions, the skyline behind",
        ];
        if (hiddenFns > 0) lines.push({ text: "+" + hiddenFns + " functions not shown", color: "#e8b93c" });
        const plaque = makePlaque(lines, { worldW: 4.6 });
        plaque.position.set(-8, 0, -6);
        group.add(plaque);
      });
    },
  };
  return district;
}
