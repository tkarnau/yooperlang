// Entry point: renderer, player, stage flow, raycast interaction.

import * as THREE from "three";
import { PointerLockControls } from "three/addons/controls/PointerLockControls.js";
import { Manager, Timeline } from "/viewer/timeline.js";
import { Hud } from "/viewer/hud.js";
import { createWorld, makePedestal, DISTRICT_X, ROAD_HALF_WIDTH } from "/viewer/world.js";
import * as sourceDistrict from "/viewer/districts/source.js";
import * as lexDistrict from "/viewer/districts/lex.js";
import * as parseDistrict from "/viewer/districts/parse.js";
import * as modulesDistrict from "/viewer/districts/modules.js";
import * as typecheckDistrict from "/viewer/districts/typecheck.js";
import * as codegenDistrict from "/viewer/districts/codegen.js";
import * as linkDistrict from "/viewer/districts/link.js";
import * as runDistrict from "/viewer/districts/run.js";

const DISTRICT_MODULES = {
  source: sourceDistrict,
  lex: lexDistrict,
  parse: parseDistrict,
  modules: modulesDistrict,
  typecheck: typecheckDistrict,
  codegen: codegenDistrict,
  link: linkDistrict,
  run: runDistrict,
};

// ---- debug state ----------------------------------------------------------

window.__VIZ = { ready: false, stagesDone: [], errors: [], build: "b3" };
const vizStateEl = document.getElementById("viz-state");
function mirrorViz() {
  try {
    vizStateEl.textContent = JSON.stringify(window.__VIZ);
  } catch (e) {
    // never let the mirror throw
  }
}
window.onerror = (msg, src, line, col) => {
  window.__VIZ.errors.push(String(msg) + " @ " + src + ":" + line + ":" + col);
  mirrorViz();
};
window.addEventListener("unhandledrejection", (ev) => {
  window.__VIZ.errors.push("unhandledrejection: " + String(ev.reason));
  mirrorViz();
});

const params = new URLSearchParams(location.search);
const FAST = params.get("fast") === "1";
const NOLOCK = params.get("nolock") === "1";

// ---- renderer and world ---------------------------------------------------

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.3;
document.getElementById("app").appendChild(renderer.domElement);
renderer.domElement.addEventListener("webglcontextlost", () => {
  window.__VIZ.errors.push("webgl context lost");
  mirrorViz();
});

const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.1, 900);
camera.rotation.order = "YXZ";

const { scene } = createWorld();
if (params.get("bgdbg") === "1") scene.background = new THREE.Color(0xff2020);

window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  // Resizing wipes the drawing buffer; redraw at once so a throttled loop
  // (shot mode) never leaves a cleared canvas on screen.
  renderer.render(scene, camera);
});

// ---- player ---------------------------------------------------------------

const controls = new PointerLockControls(camera, renderer.domElement);
const player = controls.object;
player.position.set(-14, 1.7, 0);
camera.rotation.set(0, -Math.PI / 2, 0); // look along +X

const EYE = 1.7;
const keys = {};
let velY = 0;
let flying = false;
let onGround = true;

document.addEventListener("keydown", (e) => {
  keys[e.code] = true;
  if (e.code === "KeyF") {
    flying = !flying;
    velY = 0;
  }
  if (e.code === "KeyE") tryInteract();
  if (e.code === "Space" && !flying && onGround) {
    velY = 8.5;
    onGround = false;
  }
});
document.addEventListener("keyup", (e) => {
  keys[e.code] = false;
});

const mouseNdc = new THREE.Vector2(0, 0);
document.addEventListener("mousemove", (e) => {
  mouseNdc.x = (e.clientX / window.innerWidth) * 2 - 1;
  mouseNdc.y = -(e.clientY / window.innerHeight) * 2 + 1;
});

function movePlayer(dt) {
  const sprint = keys.ShiftLeft || keys.ShiftRight ? 2.1 : 1;
  const speed = (flying ? 15 : 7.5) * sprint;
  let fwd = 0;
  let right = 0;
  if (keys.KeyW) fwd += 1;
  if (keys.KeyS) fwd -= 1;
  if (keys.KeyD) right += 1;
  if (keys.KeyA) right -= 1;
  const yaw = camera.rotation.y;
  const dirX = -Math.sin(yaw) * fwd + Math.cos(yaw) * right;
  const dirZ = -Math.cos(yaw) * fwd - Math.sin(yaw) * right;
  const len = Math.hypot(dirX, dirZ) || 1;
  const prevX = player.position.x;
  player.position.x += (dirX / len) * speed * dt * (fwd || right ? 1 : 0);
  player.position.z += (dirZ / len) * speed * dt * (fwd || right ? 1 : 0);

  if (flying) {
    if (keys.Space) player.position.y += speed * dt;
    if (keys.KeyC) player.position.y -= speed * dt;
    if (player.position.y < EYE) player.position.y = EYE;
  } else {
    velY -= 25 * dt;
    player.position.y += velY * dt;
    if (player.position.y <= EYE) {
      player.position.y = EYE;
      velY = 0;
      onGround = true;
    }
  }

  // The typecheck gate physically blocks the road until it opens.
  const gateX = DISTRICT_X.typecheck;
  if (!flags.gateOpen && player.position.y < 11) {
    if (prevX < gateX - 1.2 && player.position.x >= gateX - 1.2 &&
        Math.abs(player.position.z) < ROAD_HALF_WIDTH + 4) {
      player.position.x = gateX - 1.2;
    }
  }
}

// ---- stage flow -----------------------------------------------------------

const manager = new Manager();
manager.instant = FAST;

const flags = { gateOpen: false, pipelineBlocked: false };

let session = null;
let hud = null;
const districts = {};
const pedestals = {};
const interactables = [];
const idleFns = [];

const ctx = {
  scene,
  interactables,
  addIdle(fn) {
    idleFns.push(fn);
  },
  manager,
  flags,
  getSourceWall() {
    return districts.source && districts.source.wall ? districts.source.wall : null;
  },
  hudToast(msg, kind) {
    if (hud) hud.toast(msg, kind);
  },
};

function setStage(stage, state) {
  hud.setStage(stage, state);
  if (pedestals[stage]) pedestals[stage].setState(state);
}

function nextStage(stage) {
  const i = session.stages.indexOf(stage);
  return i >= 0 && i + 1 < session.stages.length ? session.stages[i + 1] : null;
}

function markDone(stage) {
  if (!window.__VIZ.stagesDone.includes(stage)) window.__VIZ.stagesDone.push(stage);
  mirrorViz();
}

const inFlight = {};

// Runs a stage on the server, then materializes its district. Resolves when
// the materialization has fully played out.
async function runStage(stage) {
  if (hud.stageState(stage) !== "ready" || inFlight[stage]) return;
  inFlight[stage] = true;
  setStage(stage, "running");
  let resp;
  try {
    const r = await fetch("/api/stage/run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ stage }),
    });
    resp = await r.json();
  } catch (e) {
    resp = { ok: false, error: "server unreachable: " + e };
  }
  inFlight[stage] = false;

  if (!resp.ok) {
    setStage(stage, "failed");
    hud.toast(stage + ": " + (resp.error || "failed"));
    if (resp.stderr) console.warn(resp.stderr);
    if (stage === "typecheck") {
      flags.pipelineBlocked = true;
      districts.typecheck.materializeFailure(resp);
    }
    window.__VIZ.errors.push("stage " + stage + " failed: " + (resp.error || ""));
    mirrorViz();
    return;
  }

  const typecheckBad = stage === "typecheck" && resp.data && resp.data.ok === false;

  const tl = new Timeline(stage);
  districts[stage].materialize(resp.data, tl, ctx);
  const donePromise = new Promise((resolve) => {
    const prev = tl.onDone;
    tl.onDone = () => {
      if (prev) prev();
      resolve();
    };
  });
  manager.add(tl);
  await donePromise;

  if (typecheckBad) {
    setStage(stage, "failed");
    flags.pipelineBlocked = true;
    hud.toast("typecheck reported errors - compilation cannot continue; the gate stays shut");
    window.__VIZ.errors.push("typecheck data.ok=false");
    mirrorViz();
    return;
  }

  setStage(stage, "done");
  markDone(stage);
  const nxt = nextStage(stage);
  if (nxt && !flags.pipelineBlocked && hud.stageState(nxt) === "locked") {
    setStage(nxt, "ready");
  }
}

// ---- interaction ----------------------------------------------------------

const raycaster = new THREE.Raycaster();
raycaster.far = 80;
let currentHit = null; // { mesh, instanceId, point, dist }

function pickRay() {
  // Meshes added by a materialization event have no world matrix until the
  // next render; refresh so picking never sees a stale transform.
  scene.updateMatrixWorld(true);
  if (controls.isLocked) {
    raycaster.setFromCamera(new THREE.Vector2(0, 0), camera);
  } else {
    raycaster.setFromCamera(mouseNdc, camera);
  }
  const hits = raycaster.intersectObjects(interactables, false);
  if (hits.length === 0) {
    currentHit = null;
    return;
  }
  const h = hits[0];
  currentHit = {
    mesh: h.object,
    instanceId: h.instanceId,
    point: h.point,
    dist: h.distance,
  };
}

function describeHit() {
  if (!currentHit) return null;
  const ud = currentHit.mesh.userData;
  if (ud.pedestal) {
    const ped = ud.pedestal;
    const st = hud.stageState(ped.stage);
    const near = currentHit.dist <= 4.5;
    const lines = ["state: " + st];
    let prompt = null;
    if (st === "ready") prompt = near ? "[E] run " + ped.stage : "walk closer to run " + ped.stage;
    if (st === "locked") lines.push("run the previous stage first");
    return { title: "pedestal: " + ped.stage, lines, prompt };
  }
  if (ud.viz) {
    const v = typeof ud.viz === "function" ? ud.viz(currentHit.instanceId, currentHit) : ud.viz;
    return v || null;
  }
  return null;
}

let lastInfoKey = "";
function updateInfoPanel() {
  const info = describeHit();
  const key = info ? info.title + "|" + (info.lines || []).join("|") + "|" + (info.prompt || "") : "";
  if (key !== lastInfoKey) {
    lastInfoKey = key;
    hud.showInfo(info);
    const wall = ctx.getSourceWall();
    if (wall) {
      if (info && info.span) {
        wall.highlightSpan(info.span.line, info.span.col || 1, info.span.len || 1);
      } else {
        wall.clearHighlight();
      }
    }
  }
}

// Debug hooks for headless verification of the debugger bar:
// ?pausestage=lex&pauseafter=2.5 pauses that stage's materialization at its
// timeline time; &steps=N then advances N single steps while paused.
const PAUSE_STAGE = params.get("pausestage");
const PAUSE_AFTER = parseFloat(params.get("pauseafter") || "0");
const PAUSE_STEPS = parseInt(params.get("steps") || "0", 10);
let pauseFired = false;
function debugPauseCheck() {
  if (pauseFired || !PAUSE_AFTER || manager.paused) return;
  for (const tl of manager.active) {
    if (PAUSE_STAGE && tl.label !== PAUSE_STAGE) continue;
    if (tl.t >= PAUSE_AFTER) {
      pauseFired = true;
      manager.setPaused(true);
      for (let i = 0; i < PAUSE_STEPS; i++) manager.step();
      if (hud) hud.refreshBar();
      break;
    }
  }
}

function tryInteract() {
  if (!currentHit || currentHit.dist > 4.5) return;
  const ud = currentHit.mesh.userData;
  if (ud.pedestal && hud.stageState(ud.pedestal.stage) === "ready") {
    runStage(ud.pedestal.stage);
  }
}

// ---- boot -----------------------------------------------------------------

async function boot() {
  const sceneResp = await fetch("/api/scene").then((r) => r.json());
  session = sceneResp.session;

  hud = new Hud(session.stages, manager);

  // Build districts and pedestals.
  for (const stage of session.stages) {
    const x = DISTRICT_X[stage];
    const mod = DISTRICT_MODULES[stage];
    districts[stage] = mod.create(ctx, x);
    const pedPos = new THREE.Vector3(x - 7, 0, ROAD_HALF_WIDTH - 1.2);
    const ped = makePedestal(stage, pedPos);
    pedestals[stage] = ped;
    scene.add(ped.group);
    interactables.push(ped.interactMesh, ped.crystal);
    ctx.addIdle((t) => ped.idle(t));
  }
  setStage(session.stages[0], "ready");

  // Restore stages already completed on the server.
  const results = sceneResp.results || {};
  const wasInstant = manager.instant;
  manager.instant = true;
  for (const stage of session.stages) {
    const res = results[stage];
    if (!res || !res.ok) break;
    setStage(stage, "running");
    const tl = new Timeline(stage);
    districts[stage].materialize(res.data, tl, ctx);
    manager.add(tl); // instant: finishes inside add
    if (stage === "typecheck" && res.data && res.data.ok === false) {
      setStage(stage, "failed");
      flags.pipelineBlocked = true;
      break;
    }
    setStage(stage, "done");
    markDone(stage);
    const nxt = nextStage(stage);
    if (nxt) setStage(nxt, "ready");
  }
  manager.instant = wasInstant;

  // URL-driven camera.
  const cam = params.get("cam");
  if (cam) {
    const p = cam.split(",").map(Number);
    if (p.length >= 3) player.position.set(p[0], p[1], p[2]);
    if (p.length >= 4) camera.rotation.y = p[3];
    if (p.length >= 5) camera.rotation.x = p[4];
    flying = true; // a URL-placed camera hovers; gravity would drag it down
  }

  // Intro / pointer lock.
  const intro = document.getElementById("intro");
  if (NOLOCK) {
    hud.hideIntro();
  } else {
    intro.addEventListener("click", () => {
      hud.hideIntro();
      controls.lock();
    });
    renderer.domElement.addEventListener("click", () => {
      if (!controls.isLocked) controls.lock();
    });
  }

  // Auto-run stages from the URL.
  const runParam = params.get("run");
  if (runParam) {
    const wanted = runParam === "all" ? session.stages.slice() : runParam.split(",");
    (async () => {
      for (const stage of session.stages) {
        if (!wanted.includes(stage)) continue;
        if (hud.stageState(stage) === "done") continue;
        if (hud.stageState(stage) !== "ready") break;
        await runStage(stage);
        if (flags.pipelineBlocked) break;
      }
    })();
  }

  window.__VIZ.ready = true;
  mirrorViz();
}

// ---- frame loop -----------------------------------------------------------

const clock = new THREE.Clock();
let rayAccum = 0;
let frameNo = 0;
// ?shot=N renders only every Nth frame; software GL under headless chromium
// cannot keep up with a render per virtual-time tick.
const SHOT_EVERY = parseInt(params.get("shot") || "0", 10);
function frame() {
  const dt = Math.min(clock.getDelta(), 0.1);
  const t = clock.elapsedTime;
  frameNo++;
  movePlayer(dt);
  manager.tick(dt);
  debugPauseCheck();
  for (const fn of idleFns) fn(t, dt);
  rayAccum += dt;
  if (rayAccum > 0.08) {
    rayAccum = 0;
    if (hud) {
      pickRay();
      updateInfoPanel();
    }
  }
  if (!SHOT_EVERY || frameNo % SHOT_EVERY === 0) {
    renderer.render(scene, camera);
    window.__VIZ.renders = (window.__VIZ.renders || 0) + 1;
    window.__VIZ.cam = {
      pos: camera.position.toArray().map((v) => Math.round(v * 100) / 100),
      rot: [camera.rotation.x, camera.rotation.y, camera.rotation.z].map(
        (v) => Math.round(v * 1000) / 1000
      ),
      order: camera.rotation.order,
    };
    if (SHOT_EVERY) {
      if (params.get("pixdbg") === "1") {
        const gl = renderer.getContext();
        const px = new Uint8Array(4);
        gl.readPixels(
          Math.floor(gl.drawingBufferWidth / 2),
          Math.floor(gl.drawingBufferHeight / 2),
          1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px
        );
        window.__VIZ.centerPixel = Array.from(px);
        window.__VIZ.bufSize = [gl.drawingBufferWidth, gl.drawingBufferHeight];
      }
      mirrorViz();
    }
  }
  // Under headless virtual time, requestAnimationFrame stalls after a few
  // frames; timers keep advancing. Shot mode schedules on setTimeout.
  if (SHOT_EVERY) setTimeout(frame, 16);
  else requestAnimationFrame(frame);
}

boot().catch((e) => {
  window.__VIZ.errors.push("boot failed: " + (e && e.stack ? e.stack : e));
  mirrorViz();
});
requestAnimationFrame(frame);
