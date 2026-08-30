// DOM overlay: stage chips, info panel, toast, debugger bar, intro card.

const STAGE_STATES = ["locked", "ready", "running", "done", "failed"];

export class Hud {
  constructor(stages, manager) {
    this.stages = stages;
    this.manager = manager;
    this.chipEls = {};
    this.states = {};
    this.toastTimer = null;

    const chips = document.getElementById("chips");
    for (const s of stages) {
      const el = document.createElement("div");
      el.className = "chip";
      el.textContent = s;
      chips.appendChild(el);
      this.chipEls[s] = el;
      this.states[s] = "locked";
    }

    this.infoEl = document.getElementById("info");
    this.toastEl = document.getElementById("toast");

    const help = document.getElementById("help");
    help.addEventListener("click", () => help.classList.toggle("collapsed"));

    this.playBtn = document.getElementById("db-play");
    this.stepBtn = document.getElementById("db-step");
    this.speedEl = document.getElementById("db-speed");
    this.speedVal = document.getElementById("db-speedval");
    this.statusEl = document.getElementById("db-status");

    this.playBtn.addEventListener("click", () => {
      manager.setPaused(!manager.paused);
      this.refreshBar();
    });
    this.stepBtn.addEventListener("click", () => {
      if (!manager.paused) manager.setPaused(true);
      manager.step();
      this.refreshBar();
    });
    this.speedEl.addEventListener("input", () => {
      manager.speed = Math.pow(2, parseFloat(this.speedEl.value));
      this.speedVal.textContent = manager.speed.toFixed(manager.speed < 1 ? 2 : 1) + "x";
    });
    manager.onChange = () => this.refreshBar();
    this.refreshBar();
  }

  refreshBar() {
    const st = this.manager.status();
    this.playBtn.textContent = this.manager.paused ? "Play" : "Pause";
    this.stepBtn.disabled = st === null;
    if (st) {
      this.statusEl.textContent = st.label + ": " + st.at + "/" + st.total +
        (this.manager.paused ? " [paused]" : "");
    } else {
      this.statusEl.textContent = "idle";
    }
  }

  setStage(stage, state) {
    if (!STAGE_STATES.includes(state)) return;
    this.states[stage] = state;
    const el = this.chipEls[stage];
    el.className = "chip" + (state === "locked" ? "" : " " + state);
  }

  stageState(stage) {
    return this.states[stage];
  }

  // info: { title, lines: [..], prompt? } or null to hide.
  showInfo(info) {
    if (!info) {
      this.infoEl.style.display = "none";
      return;
    }
    this.infoEl.innerHTML = "";
    const title = document.createElement("div");
    title.className = "title";
    title.textContent = info.title || "";
    this.infoEl.appendChild(title);
    for (const line of info.lines || []) {
      const d = document.createElement("div");
      d.className = "line";
      d.textContent = line;
      this.infoEl.appendChild(d);
    }
    if (info.prompt) {
      const d = document.createElement("div");
      d.className = "prompt";
      d.textContent = info.prompt;
      this.infoEl.appendChild(d);
    }
    this.infoEl.style.display = "block";
  }

  toast(msg, kind) {
    this.toastEl.textContent = msg;
    this.toastEl.className = "hud" + (kind === "note" ? " note" : "");
    this.toastEl.style.display = "block";
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => {
      this.toastEl.style.display = "none";
    }, 6000);
  }

  hideIntro() {
    const el = document.getElementById("intro");
    if (el) el.style.display = "none";
  }
}
