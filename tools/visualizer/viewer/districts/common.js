// Shared district helpers.

import * as THREE from "three";
import { makeLabelSprite } from "/viewer/text.js";

// A hologram ghost: wireframe volume plus a dim label, shown until the
// district's stage runs.
export function makeGhost(label, w, h, d) {
  const group = new THREE.Group();
  const edges = new THREE.LineSegments(
    new THREE.EdgesGeometry(new THREE.BoxGeometry(w, h, d)),
    new THREE.LineBasicMaterial({ color: 0x2a3a6a, transparent: true, opacity: 0.4 })
  );
  edges.position.y = h / 2;
  group.add(edges);
  const spr = makeLabelSprite(label, { color: "#44548f", bg: "rgba(6,9,22,0.4)", worldH: 1.2 });
  spr.position.y = h + 1;
  group.add(spr);
  return group;
}

// Distributes n reveal events on a timeline: per-item delay aims for `rate`
// items per second but compresses so the whole thing fits in `maxTotal`
// seconds at speed 1.
export function revealDelay(n, rate, maxTotal) {
  const d = 1 / rate;
  return Math.min(d, maxTotal / Math.max(1, n));
}

export function humanBytes(n) {
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KiB";
  return (n / (1024 * 1024)).toFixed(2) + " MiB";
}
