// The one materialization clock. Every district schedules its appearance on
// a Timeline; the debugger bar drives the Manager, so pause, step and speed
// behave identically everywhere.

export class Timeline {
  constructor(label) {
    this.label = label;
    this.events = [];
    this.cursor = 0;
    this.t = 0;
    this.idx = 0;
    this.done = false;
    this.onDone = null;
  }

  // Schedule fn at an absolute time on this timeline.
  at(time, fn) {
    this.events.push({ t: time, fn });
    if (time > this.cursor) this.cursor = time;
    return this;
  }

  // Schedule fn `delay` seconds after the previously scheduled event.
  seq(delay, fn) {
    this.cursor += delay;
    this.events.push({ t: this.cursor, fn });
    return this;
  }

  // A tween: fn(k) called every tick with k in [0,1] between start and end.
  // Implemented as events at ~30 steps so step mode remains meaningful.
  tween(start, dur, fn, steps) {
    const n = Math.max(2, steps || Math.min(30, Math.ceil(dur * 30)));
    for (let i = 0; i < n; i++) {
      const k = i / (n - 1);
      this.at(start + dur * k, () => fn(k));
    }
    return this;
  }

  sort() {
    this.events.sort((a, b) => a.t - b.t);
  }

  fireNext() {
    if (this.idx >= this.events.length) return false;
    const ev = this.events[this.idx++];
    this.t = ev.t;
    ev.fn();
    if (this.idx >= this.events.length) this.finishMark();
    return true;
  }

  tick(dt) {
    if (this.done) return;
    this.t += dt;
    while (this.idx < this.events.length && this.events[this.idx].t <= this.t) {
      this.events[this.idx++].fn();
    }
    if (this.idx >= this.events.length) this.finishMark();
  }

  finish() {
    while (this.idx < this.events.length) this.events[this.idx++].fn();
    this.finishMark();
  }

  finishMark() {
    if (this.done) return;
    this.done = true;
    if (this.onDone) this.onDone();
  }

  get remaining() {
    return this.events.length - this.idx;
  }
}

export class Manager {
  constructor() {
    this.active = [];
    this.paused = false;
    this.speed = 1;
    this.instant = false;
    this.onChange = null;
  }

  add(tl) {
    tl.sort();
    if (this.instant) {
      tl.finish();
      return tl;
    }
    this.active.push(tl);
    this.notify();
    return tl;
  }

  tick(dt) {
    if (this.active.length === 0) return;
    if (!this.paused) {
      for (const tl of this.active) tl.tick(dt * this.speed);
    }
    const before = this.active.length;
    this.active = this.active.filter((tl) => !tl.done);
    if (this.active.length !== before) this.notify();
  }

  step() {
    // Advance exactly one event on the timeline whose next event is earliest.
    let best = null;
    for (const tl of this.active) {
      if (tl.done || tl.idx >= tl.events.length) continue;
      if (!best || tl.events[tl.idx].t < best.events[best.idx].t) best = tl;
    }
    if (best) {
      best.fireNext();
      this.active = this.active.filter((tl) => !tl.done);
      this.notify();
    }
  }

  setPaused(p) {
    this.paused = p;
    this.notify();
  }

  status() {
    if (this.active.length === 0) return null;
    const tl = this.active[0];
    return { label: tl.label, at: tl.idx, total: tl.events.length };
  }

  notify() {
    if (this.onChange) this.onChange();
  }
}
