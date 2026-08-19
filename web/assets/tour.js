/* The tour page: fills each episode slot with the real program, a run button
 * that reveals the real output, and the break-it cards for that episode.
 *
 * Nothing here fakes anything. Every string it renders came out of
 * scripts/gen_web.mjs, which compiled and ran the program to get it.
 */
(function () {
  "use strict";

  const S = window.YoopSite;
  const data = (window.YOOP_DATA || {}).tour;
  if (!S) return;
  const { el, codeBlock, termBlock } = S;

  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  function missing(mount, what) {
    mount.appendChild(
      el("p", {
        class: "muted",
        text: `Generated data for ${what} is missing. Run "npm run gen:web" to build it.`,
      }),
    );
  }

  /* --------------------------------------------------------- run reveal */

  // Reveal the output a line at a time, because watching a program print is
  // more fun than being handed a finished block. Clicking again finishes it.
  function revealOutput(container, episode) {
    const term = termBlock("", {
      label: `./${episode.id}`,
      exitCode: episode.exitCode,
    });
    const body = term.querySelector(".term-body");
    container.appendChild(term);

    // stderr is its own pane: the logging step exists to show that log lines
    // go there, and gluing the streams together would hide it.
    if (episode.stderr) {
      container.appendChild(termBlock(episode.stderr, { label: "stderr" }));
    }

    const lines = episode.output.split("\n");
    if (reduceMotion || lines.length > 60) {
      body.textContent = episode.output;
      return;
    }

    let i = 0;
    let timer = null;
    const finish = () => {
      clearInterval(timer);
      body.textContent = episode.output;
      term.removeEventListener("click", finish);
    };
    timer = setInterval(() => {
      body.textContent = lines.slice(0, ++i).join("\n");
      if (i >= lines.length) finish();
    }, 45);
    term.addEventListener("click", finish);
  }

  /* --------------------------------------------------------- break cards */

  function breakCard(card) {
    const wrap = el("div", { class: "break" });
    const summary = el("button", { class: "break-head", type: "button" }, [
      el("span", { class: "break-tag", text: "break it" }),
      el("span", { class: "break-title", text: card.title }),
      el("span", { class: "break-chev", "aria-hidden": "true" }),
    ]);
    const body = el("div", { class: "break-body", hidden: true });
    let built = false;

    summary.addEventListener("click", () => {
      const open = body.hasAttribute("hidden");
      if (open && !built) {
        built = true;
        body.appendChild(el("p", { class: "muted small", text: card.note }));
        body.appendChild(
          codeBlock(card.source, { name: card.file, scroll: true, commentToggle: false }),
        );
        body.appendChild(
          termBlock(card.diagnostic, { label: "what the compiler said", bad: true }),
        );
      }
      if (open) body.removeAttribute("hidden");
      else body.setAttribute("hidden", "");
      summary.setAttribute("aria-expanded", String(open));
      wrap.classList.toggle("open", open);
    });

    summary.setAttribute("aria-expanded", "false");
    wrap.appendChild(summary);
    wrap.appendChild(body);
    return wrap;
  }

  /* ------------------------------------------------------------ episodes */

  function renderEpisode(mount) {
    const id = mount.dataset.episode;
    const episode = (data?.episodes || []).find((e) => e.id === id);
    if (!episode) {
      missing(mount, id);
      return;
    }

    mount.classList.add("episode");
    mount.appendChild(
      codeBlock(episode.source, {
        name: episode.file,
        scroll: true,
      }),
    );

    const runRow = el("div", { class: "run-row" });
    const runBtn = el("button", { class: "btn btn-primary btn-run", type: "button" }, [
      "Run it",
    ]);
    const outMount = el("div", { class: "run-out" });

    runBtn.addEventListener("click", () => {
      runBtn.disabled = true;
      runBtn.textContent = "ran it";
      revealOutput(outMount, episode);
    });

    runRow.appendChild(runBtn);
    runRow.appendChild(
      el("span", {
        class: "muted small",
        text: "recorded from a real build of this file, not a simulation",
      }),
    );
    mount.appendChild(runRow);
    mount.appendChild(outMount);

    const cards = (data.breaks || []).filter((b) => b.episode === id);
    if (cards.length) {
      const breaks = el("div", { class: "breaks" });
      for (const card of cards) breaks.appendChild(breakCard(card));
      mount.appendChild(breaks);
    }
  }

  document.querySelectorAll("[data-episode]").forEach(renderEpisode);

})();
