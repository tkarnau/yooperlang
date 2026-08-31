// RUN PAD: a terminal monolith at the road's end. stdout types out on its
// screen; exit 0 celebrates, nonzero smolders.

import * as THREE from "three";
import { makeCanvas, canvasTexture, makeTextPanel } from "/viewer/text.js";
import { makeGhost } from "/viewer/districts/common.js";

const MAX_CHARS = 2000;
const SCREEN_W = 880;
const SCREEN_H = 620;
const FONT_PX = 24;
const LINE_H = 30;
const PAD = 26;

export function create(ctx, x) {
  const group = new THREE.Group();
  group.position.set(x + 8, 0, 0);
  group.rotation.y = -Math.PI / 2; // screen faces back down the road (-X)
  ctx.scene.add(group);

  const ghost = makeGhost("RUN", 12, 12, 4);
  ghost.position.set(0, 0, 0);
  ctx.scene.add(ghost);
  ghost.position.set(x + 8, 0, 0);

  const light = new THREE.PointLight(0x7fe0a8, 0, 35);
  light.position.set(0, 8, 3);
  group.add(light);

  const district = {
    name: "run",
    group,
    materialize(data, tl, c) {
      ghost.visible = false;

      // Monolith slab.
      const slab = new THREE.Mesh(
        new THREE.BoxGeometry(13, 11, 1.6),
        new THREE.MeshStandardMaterial({ color: 0x161d38, roughness: 0.5, metalness: 0.5 })
      );
      slab.position.set(0, 5.5, 0);
      slab.visible = false;
      group.add(slab);

      // Screen canvas.
      const canvas = makeCanvas(SCREEN_W, SCREEN_H);
      const g = canvas.getContext("2d");
      const tex = canvasTexture(canvas);
      const screen = new THREE.Mesh(
        new THREE.PlaneGeometry(11.4, 11.4 * (SCREEN_H / SCREEN_W)),
        new THREE.MeshBasicMaterial({ map: tex })
      );
      screen.position.set(0, 5.9, 0.85);
      screen.visible = false;
      group.add(screen);
      ctx.interactables.push(screen);
      screen.userData.viz = {
        title: "program run",
        lines: [
          "exit=" + data.exitCode + (data.timedOut ? " (timed out)" : ""),
          data.wallMs + " ms wall",
        ],
      };

      const out = (data.stdout || "").slice(0, MAX_CHARS);
      const clipped = (data.stdout || "").length - out.length;

      function draw(n, withExit) {
        g.fillStyle = "#04120a";
        g.fillRect(0, 0, SCREEN_W, SCREEN_H);
        g.strokeStyle = "#2fbf71";
        g.lineWidth = 4;
        g.strokeRect(2, 2, SCREEN_W - 4, SCREEN_H - 4);
        g.font = FONT_PX + "px monospace";
        g.textBaseline = "top";
        g.fillStyle = "#5a8f6f";
        g.fillText("$ ./" + (c.flags.binName || "prog"), PAD, PAD);
        g.fillStyle = "#8fffb0";
        const text = out.slice(0, n);
        const lines = text.split("\n");
        const maxLines = Math.floor((SCREEN_H - PAD * 3 - LINE_H) / LINE_H) - 1;
        const shown = lines.slice(-maxLines);
        let y = PAD + LINE_H * 1.4;
        for (const line of shown) {
          g.fillText(line.slice(0, 58), PAD, y);
          y += LINE_H;
        }
        if (n < out.length) {
          // cursor
          const last = shown[shown.length - 1] || "";
          g.fillRect(PAD + Math.min(58, last.length) * (FONT_PX * 0.6), y - LINE_H, 12, FONT_PX);
        }
        if (withExit) {
          if (clipped > 0) {
            g.fillStyle = "#e8b93c";
            g.fillText("(+" + clipped + " more bytes)", PAD, y);
            y += LINE_H;
          }
          g.fillStyle = data.exitCode === 0 ? "#7fe0a8" : "#ff8a8a";
          g.fillText("exit=" + data.exitCode, PAD, y + 6);
        }
        tex.needsUpdate = true;
      }

      tl.seq(0.3, () => {
        slab.visible = true;
      });
      tl.tween(0.3, 0.8, (k) => {
        light.intensity = k * 60;
      });
      tl.seq(0.4, () => {
        screen.visible = true;
        draw(0, false);
      });
      // Type stdout character by character.
      const perChar = Math.min(0.045, 8 / Math.max(1, out.length));
      for (let i = 1; i <= out.length; i++) {
        tl.seq(perChar, () => draw(i, false));
      }
      tl.seq(0.6, () => draw(out.length, true));

      // stderr on a dimmer side panel.
      if (data.stderr && data.stderr.length > 0) {
        tl.seq(0.4, () => {
          const errLines = data.stderr.split("\n").slice(0, 14).map((l) => ({
            text: l.slice(0, 64),
            color: "#c88a8a",
            fontPx: 24,
          }));
          const panel = makeTextPanel(
            [{ text: "stderr", color: "#ff8a8a", fontPx: 30 }, ...errLines],
            { worldW: 6, bg: "rgba(20,8,10,0.85)", borderColor: "#6a3040" }
          );
          panel.position.set(-9.5, 4, 0.85);
          group.add(panel);
        });
      }

      // Exit ceremony.
      const nP = 220;
      const pPos = new Float32Array(nP * 3);
      const pVel = [];
      const pGeo = new THREE.BufferGeometry();
      pGeo.setAttribute("position", new THREE.BufferAttribute(pPos, 3));
      const good = data.exitCode === 0;
      const pMat = new THREE.PointsMaterial({
        size: good ? 0.16 : 0.3,
        transparent: true,
        opacity: 0,
        blending: good ? THREE.AdditiveBlending : THREE.NormalBlending,
        vertexColors: good,
        depthWrite: false,
        color: good ? 0xffffff : 0x5a1616,
      });
      if (good) {
        const cols = new Float32Array(nP * 3);
        const palette = [0x7fe0a8, 0xffd970, 0x7fd4ff, 0xe86ab4];
        const cc = new THREE.Color();
        for (let i = 0; i < nP; i++) {
          cc.setHex(palette[i % palette.length]);
          cols.set([cc.r, cc.g, cc.b], i * 3);
        }
        pGeo.setAttribute("color", new THREE.BufferAttribute(cols, 3));
      }
      const points = new THREE.Points(pGeo, pMat);
      group.add(points);
      let burstLife = 0;
      ctx.addIdle((t, dt) => {
        if (burstLife <= 0) return;
        burstLife -= dt;
        for (let i = 0; i < nP; i++) {
          const v = pVel[i];
          if (good) v.y -= 6 * dt;
          else v.y += 0.5 * dt;
          pPos[i * 3] += v.x * dt;
          pPos[i * 3 + 1] += v.y * dt;
          pPos[i * 3 + 2] += v.z * dt;
        }
        pGeo.attributes.position.needsUpdate = true;
        pMat.opacity = Math.max(0, Math.min(1, burstLife / (good ? 2.5 : 5)));
      });
      tl.seq(0.2, () => {
        for (let i = 0; i < nP; i++) {
          pPos[i * 3] = (Math.random() - 0.5) * 3;
          pPos[i * 3 + 1] = 6 + (Math.random() - 0.5) * 3;
          pPos[i * 3 + 2] = 1.5;
          if (good) {
            const a = Math.random() * Math.PI * 2;
            const sp = 2 + Math.random() * 5;
            pVel[i] = new THREE.Vector3(Math.cos(a) * sp, 3 + Math.random() * 5, 1 + Math.random() * 3);
          } else {
            pVel[i] = new THREE.Vector3(
              (Math.random() - 0.5) * 0.8,
              0.6 + Math.random() * 0.8,
              (Math.random() - 0.5) * 0.8
            );
          }
        }
        pGeo.attributes.position.needsUpdate = true;
        burstLife = good ? 2.5 : 5;
        light.color.setHex(good ? 0x7fe0a8 : 0xe84a4a);
        light.intensity = good ? 100 : 80;
      });
    },
  };
  return district;
}
