// SOURCE PLAZA: the program text as a glowing wall. The wall's
// highlightSpan(line, col, len) is what every other district points back at.

import * as THREE from "three";
import { makeCanvas, canvasTexture, makePlaque } from "/viewer/text.js";
import { makeGhost } from "/viewer/districts/common.js";

const FONT_PX = 16;
const LINE_H = 20;
const PAD = 14;
const GUTTER_CHARS = 5;
const MAX_LINE_CHARS = 96;
const LINES_PER_COL = 60;
const MAX_COLS = 4;
const PX_PER_WORLD = 42;

export function create(ctx, x) {
  const group = new THREE.Group();
  group.position.set(x, 0, 0);
  ctx.scene.add(group);

  // Plaza floor.
  const floor = new THREE.Mesh(
    new THREE.CircleGeometry(14, 40),
    new THREE.MeshStandardMaterial({ color: 0x10162c, roughness: 0.9 })
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.set(0, 0.02, -12);
  group.add(floor);

  const ghost = makeGhost("SOURCE", 22, 12, 2);
  ghost.position.set(0, 0, -14);
  group.add(ghost);

  const light = new THREE.PointLight(0x66aaff, 0, 40);
  light.position.set(0, 8, -8);
  group.add(light);

  const district = {
    name: "source",
    group,
    wall: null,
    materialize(data, tl, c) {
      ghost.visible = false;
      district.wall = buildWall(group, ctx, data);
      const wall = district.wall;
      const total = wall.shownLines;
      const perLine = Math.min(0.14, 6 / Math.max(1, total));
      tl.seq(0.2, () => {
        wall.mesh.visible = true;
      });
      for (let i = 1; i <= total; i++) {
        tl.seq(perLine, () => wall.drawUpTo(i));
      }
      tl.tween(tl.cursor, 1.2, (k) => {
        light.intensity = k * 70;
      });
      tl.seq(0.3, () => {
        const plaque = makePlaque(
          [
            { text: data.path, color: "#9fd8ff", fontPx: 34 },
            data.lines + " lines, " + data.bytes + " bytes",
          ],
          { worldW: 4.2 }
        );
        plaque.position.set(-6, 0, -4.5);
        plaque.rotation.y = 0.4;
        group.add(plaque);
      });
    },
  };
  return district;
}

function buildWall(group, ctx, data) {
  const rawLines = data.text.split("\n");
  if (rawLines.length && rawLines[rawLines.length - 1] === "") rawLines.pop();
  const totalLines = rawLines.length;
  const cols = Math.min(MAX_COLS, Math.max(1, Math.ceil(totalLines / LINES_PER_COL)));
  const linesPerCol = Math.ceil(Math.min(totalLines, cols * LINES_PER_COL) / cols);
  const shownLines = Math.min(totalLines, cols * linesPerCol);
  const hidden = totalLines - shownLines;

  const probe = makeCanvas(4, 4).getContext("2d");
  probe.font = FONT_PX + "px monospace";
  const charW = probe.measureText("M").width;

  let maxChars = 0;
  for (let i = 0; i < shownLines; i++) {
    maxChars = Math.max(maxChars, Math.min(rawLines[i].length, MAX_LINE_CHARS));
  }
  maxChars = Math.max(maxChars, 20);

  const colPxW = Math.ceil((GUTTER_CHARS + maxChars + 2) * charW);
  const w = colPxW * cols + PAD * 2;
  const h = linesPerCol * LINE_H + PAD * 2;
  const canvas = makeCanvas(w, h);
  const g = canvas.getContext("2d");

  let drawn = 0;
  function drawUpTo(n) {
    drawn = n;
    g.fillStyle = "#070b1e";
    g.fillRect(0, 0, w, h);
    g.strokeStyle = "#2fd8e8";
    g.lineWidth = 3;
    g.strokeRect(1.5, 1.5, w - 3, h - 3);
    g.font = FONT_PX + "px monospace";
    g.textBaseline = "top";
    for (let i = 0; i < Math.min(n, shownLines); i++) {
      const col = Math.floor(i / linesPerCol);
      const row = i % linesPerCol;
      const bx = PAD + col * colPxW;
      const by = PAD + row * LINE_H + (LINE_H - FONT_PX) / 2;
      g.fillStyle = "#3d548f";
      g.fillText(String(i + 1).padStart(4, " "), bx, by);
      let text = rawLines[i];
      if (text.length > MAX_LINE_CHARS) text = text.slice(0, MAX_LINE_CHARS - 3) + "...";
      g.fillStyle = "#b8d4ff";
      g.fillText(text, bx + GUTTER_CHARS * charW, by);
    }
    if (hidden > 0 && n >= shownLines) {
      g.fillStyle = "#e8b93c";
      g.fillText("+" + hidden + " more lines", PAD + GUTTER_CHARS * charW, h - LINE_H);
    }
    tex.needsUpdate = true;
  }

  const tex = canvasTexture(canvas);
  const worldW = w / PX_PER_WORLD;
  const worldH = h / PX_PER_WORLD;
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(worldW, worldH),
    new THREE.MeshBasicMaterial({ map: tex, transparent: true })
  );
  mesh.position.set(0, worldH / 2 + 0.6, -14);
  mesh.visible = false;
  group.add(mesh);

  // Back plate so the wall reads as solid from behind.
  const back = new THREE.Mesh(
    new THREE.PlaneGeometry(worldW, worldH),
    new THREE.MeshBasicMaterial({ color: 0x0a0f24, side: THREE.BackSide })
  );
  back.position.copy(mesh.position);
  back.position.z -= 0.05;
  group.add(back);

  // Highlight quad, repositioned by highlightSpan.
  const hl = new THREE.Mesh(
    new THREE.PlaneGeometry(1, 1),
    new THREE.MeshBasicMaterial({
      color: 0xffd970,
      transparent: true,
      opacity: 0.4,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    })
  );
  hl.visible = false;
  hl.position.z = 0.04;
  mesh.add(hl);
  ctx.addIdle((t) => {
    if (hl.visible) hl.material.opacity = 0.3 + Math.sin(t * 6) * 0.15;
  });

  const wall = {
    mesh,
    shownLines,
    drawUpTo,
    highlightSpan(line, col, len) {
      const i = line - 1;
      if (i < 0 || i >= shownLines) {
        hl.visible = false;
        return;
      }
      const colIdx = Math.floor(i / linesPerCol);
      const row = i % linesPerCol;
      const c0 = Math.max(0, (col || 1) - 1);
      const nch = Math.max(1, Math.min(len || 1, MAX_LINE_CHARS - c0));
      const px = PAD + colIdx * colPxW + (GUTTER_CHARS + c0) * charW;
      const py = PAD + row * LINE_H;
      const s = 1 / PX_PER_WORLD;
      hl.scale.set(Math.max(nch * charW + 6, 8) * s, LINE_H * s, 1);
      hl.position.x = -worldW / 2 + (px + (nch * charW) / 2) * s;
      hl.position.y = worldH / 2 - (py + LINE_H / 2) * s;
      hl.visible = true;
    },
    clearHighlight() {
      hl.visible = false;
    },
  };
  return wall;
}
