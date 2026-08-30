// LINKER FORGE: a press machine that forges the binary into a glowing ingot.

import * as THREE from "three";
import { makePlaque } from "/viewer/text.js";
import { makeGhost, humanBytes } from "/viewer/districts/common.js";

export function create(ctx, x) {
  const group = new THREE.Group();
  group.position.set(x, 0, 0);
  ctx.scene.add(group);

  const ghost = makeGhost("LINK", 10, 9, 8);
  ghost.position.set(0, 0, 9);
  group.add(ghost);

  const metal = new THREE.MeshStandardMaterial({ color: 0x1c2440, roughness: 0.5, metalness: 0.7 });

  const light = new THREE.PointLight(0xff9a3c, 0, 30);
  light.position.set(0, 5, 9);
  group.add(light);

  const district = {
    name: "link",
    group,
    materialize(data, tl, c) {
      ghost.visible = false;
      const cz = 9;

      // Anvil base, two pillars, crossbar, ram.
      const base = new THREE.Mesh(new THREE.BoxGeometry(4.4, 1.2, 3.2), metal);
      base.position.set(0, 0.6, cz);
      const pillarL = new THREE.Mesh(new THREE.BoxGeometry(0.8, 7.5, 0.8), metal);
      pillarL.position.set(-2.4, 3.75, cz);
      const pillarR = pillarL.clone();
      pillarR.position.x = 2.4;
      const crossbar = new THREE.Mesh(new THREE.BoxGeometry(5.6, 0.9, 1.4), metal);
      crossbar.position.set(0, 7.4, cz);
      const ram = new THREE.Mesh(
        new THREE.BoxGeometry(2.2, 1.8, 2.2),
        new THREE.MeshStandardMaterial({ color: 0x2a3560, roughness: 0.4, metalness: 0.8 })
      );
      ram.position.set(0, 6.0, cz);
      const parts = [base, pillarL, pillarR, crossbar, ram];
      for (const p of parts) {
        p.visible = false;
        group.add(p);
      }

      // Sparks on impact.
      const nSparks = 90;
      const sparkPos = new Float32Array(nSparks * 3);
      const sparkVel = [];
      const sparkGeo = new THREE.BufferGeometry();
      sparkGeo.setAttribute("position", new THREE.BufferAttribute(sparkPos, 3));
      const sparks = new THREE.Points(
        sparkGeo,
        new THREE.PointsMaterial({
          color: 0xffc060,
          size: 0.14,
          transparent: true,
          opacity: 0,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
        })
      );
      group.add(sparks);
      let sparkLife = 0;
      ctx.addIdle((t, dt) => {
        if (sparkLife <= 0) return;
        sparkLife -= dt;
        for (let i = 0; i < nSparks; i++) {
          const v = sparkVel[i];
          v.y -= 12 * dt;
          sparkPos[i * 3] += v.x * dt;
          sparkPos[i * 3 + 1] += v.y * dt;
          sparkPos[i * 3 + 2] += v.z * dt;
        }
        sparkGeo.attributes.position.needsUpdate = true;
        sparks.material.opacity = Math.max(0, sparkLife / 1.4);
      });

      const ingotMat = new THREE.MeshStandardMaterial({
        color: 0xffd970,
        emissive: 0xff9a3c,
        emissiveIntensity: 0,
        roughness: 0.25,
        metalness: 0.9,
      });
      const ingot = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.6, 1.0), ingotMat);
      ingot.position.set(0, 1.5, cz);
      ingot.visible = false;
      group.add(ingot);
      ctx.interactables.push(ingot);
      const baseName = (data.outPath || "").split("/").pop();
      c.flags.binName = baseName;
      ingot.userData.viz = {
        title: "binary: " + baseName,
        lines: [data.outPath, humanBytes(data.sizeBytes), "linked in " + data.wallMs + " ms"],
      };
      ctx.addIdle((t) => {
        if (!ingot.visible) return;
        ingotMat.emissiveIntensity = 0.55 + Math.sin(t * 2.2) * 0.25;
      });

      // Machine assembles, ram presses slowly, sparks fly, ingot appears.
      for (const p of parts) {
        tl.seq(0.35, () => {
          p.visible = true;
        });
      }
      tl.tween(tl.cursor, 1.0, (k) => {
        light.intensity = k * 60;
      });
      tl.tween(tl.cursor + 0.3, 2.8, (k) => {
        ram.position.y = 6.0 - 3.9 * k * k;
      }, 30);
      tl.seq(0.05, () => {
        sparkLife = 1.4;
        for (let i = 0; i < nSparks; i++) {
          sparkPos[i * 3] = (Math.random() - 0.5) * 1.5;
          sparkPos[i * 3 + 1] = 1.6;
          sparkPos[i * 3 + 2] = cz + (Math.random() - 0.5) * 1.5;
          const a = Math.random() * Math.PI * 2;
          const sp = 2 + Math.random() * 4;
          sparkVel[i] = new THREE.Vector3(
            Math.cos(a) * sp,
            2 + Math.random() * 5,
            Math.sin(a) * sp
          );
        }
        sparkGeo.attributes.position.needsUpdate = true;
      });
      tl.tween(tl.cursor + 0.4, 1.6, (k) => {
        ram.position.y = 2.1 + 3.9 * k;
        if (k > 0.2) ingot.visible = true;
      }, 16);
      tl.seq(0.3, () => {
        const plaque = makePlaque(
          [
            { text: baseName, color: "#ffd970", fontPx: 38 },
            humanBytes(data.sizeBytes) + ", " + data.wallMs + " ms",
          ],
          { worldW: 3.2 }
        );
        plaque.position.set(-4.2, 0, cz - 2.5);
        plaque.rotation.y = Math.PI; // face the road
        group.add(plaque);
      });
    },
  };
  return district;
}
