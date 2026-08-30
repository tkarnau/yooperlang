// Canvas-generated text for the 3D world. Every glyph in the scene comes
// through here; no font files are loaded.

import * as THREE from "three";

const FONT = "monospace";

export function makeCanvas(w, h) {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return c;
}

export function canvasTexture(canvas) {
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

// A floating billboard label. scale is world height per canvas... roughly:
// the sprite is sized so text reads at a few meters.
export function makeLabelSprite(text, opts = {}) {
  const fontPx = opts.fontPx || 44;
  const color = opts.color || "#cfe4ff";
  const bg = opts.bg || "rgba(6,9,22,0.72)";
  const pad = 18;
  const c = makeCanvas(4, 4);
  const g = c.getContext("2d");
  g.font = fontPx + "px " + FONT;
  const tw = Math.ceil(g.measureText(text).width);
  c.width = tw + pad * 2;
  c.height = fontPx + pad * 2;
  const g2 = c.getContext("2d");
  g2.font = fontPx + "px " + FONT;
  g2.fillStyle = bg;
  g2.beginPath();
  g2.roundRect(0, 0, c.width, c.height, 12);
  g2.fill();
  g2.fillStyle = color;
  g2.textBaseline = "middle";
  g2.fillText(text, pad, c.height / 2 + 2);
  const mat = new THREE.SpriteMaterial({
    map: canvasTexture(c),
    transparent: true,
    depthWrite: false,
  });
  const spr = new THREE.Sprite(mat);
  const worldH = opts.worldH || 0.9;
  spr.scale.set(worldH * (c.width / c.height), worldH, 1);
  return spr;
}

// A flat panel mesh with lines of text. Used for plaques and screens.
// lines: array of { text, color?, fontPx? } or plain strings.
export function makeTextPanel(lines, opts = {}) {
  const fontPx = opts.fontPx || 30;
  const lineH = Math.round(fontPx * 1.4);
  const pad = opts.pad !== undefined ? opts.pad : 24;
  const norm = lines.map((l) => (typeof l === "string" ? { text: l } : l));
  const probe = makeCanvas(4, 4).getContext("2d");
  let maxW = 0;
  for (const l of norm) {
    probe.font = (l.fontPx || fontPx) + "px " + FONT;
    maxW = Math.max(maxW, probe.measureText(l.text).width);
  }
  const w = Math.ceil(maxW) + pad * 2;
  let h = pad * 2;
  for (const l of norm) h += Math.round((l.fontPx || fontPx) * 1.4);
  const c = makeCanvas(w, h);
  const g = c.getContext("2d");
  g.fillStyle = opts.bg || "rgba(8,12,28,0.92)";
  g.fillRect(0, 0, w, h);
  if (opts.border !== false) {
    g.strokeStyle = opts.borderColor || "#3a4a8a";
    g.lineWidth = 4;
    g.strokeRect(2, 2, w - 4, h - 4);
  }
  let y = pad;
  for (const l of norm) {
    const fp = l.fontPx || fontPx;
    g.font = fp + "px " + FONT;
    g.fillStyle = l.color || opts.color || "#cfe4ff";
    g.textBaseline = "top";
    g.fillText(l.text, pad, y + fp * 0.15);
    y += Math.round(fp * 1.4);
  }
  const worldW = opts.worldW || 3;
  const geo = new THREE.PlaneGeometry(worldW, worldW * (h / w));
  const mat = new THREE.MeshBasicMaterial({
    map: canvasTexture(c),
    transparent: true,
  });
  const mesh = new THREE.Mesh(geo, mat);
  // Front side only: a double-sided plane would show the text mirrored from
  // behind. The back is a plain dark plate instead.
  const back = new THREE.Mesh(
    geo,
    new THREE.MeshBasicMaterial({ color: 0x0c1226 })
  );
  back.rotation.y = Math.PI;
  back.position.z = -0.01;
  mesh.add(back);
  return mesh;
}

// A plaque: text panel standing on a short post at a position.
export function makePlaque(lines, opts = {}) {
  const group = new THREE.Group();
  const panel = makeTextPanel(lines, opts);
  const height = opts.height !== undefined ? opts.height : 1.4;
  panel.position.y = height;
  group.add(panel);
  const post = new THREE.Mesh(
    new THREE.CylinderGeometry(0.05, 0.07, height, 6),
    new THREE.MeshStandardMaterial({ color: 0x222a44, roughness: 0.8 })
  );
  post.position.y = height / 2;
  group.add(post);
  return group;
}
