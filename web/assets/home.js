/* Landing page behavior: the three-layer switcher and the kind/IR diff. */
(function () {
  "use strict";

  const S = window.YoopSite;
  if (!S) return;
  const { el, codeBlock } = S;

  /* ------------------------------------------------------- layer switcher */

  const LAYERS = {
    type: {
      lead:
        "A type is the shape of the data and nothing else. No methods live inside it, " +
        "there is no inheritance, and two structs with the same fields are still two " +
        "different types: names are what identity is made of here.",
      code: `type Point {
  x: int32,
  y: int32,
}

// Same fields. Still not the same type - identity is the name, not the
// shape, so a Meters can never be passed where a Seconds is wanted.
type Meters  { v: int32 }
type Seconds { v: int32 }

function shifted(p: Point, dx: int32): Point {
  return { x: p.x + dx, y: p.y };
}`,
      note:
        "Behavior lives in free functions, next to the data rather than inside it. " +
        "That is the whole object model.",
    },
    trait: {
      lead:
        "A trait is a capability: the operations a type promises to provide. It is the " +
        "only polymorphism mechanism in the language. Generics monomorphize against it " +
        "at compile time, and a vtable gives you runtime dispatch when you need a " +
        "heterogeneous list.",
      code: `trait Greeter {
  function greet(ref self): string;
}

// A type opts in and supplies the methods inline.
type Town implements Greeter {
  name: string,
  function greet(ref self): string {
    return self.name;
  }
}

// Calls are trait-qualified. The trait name at the call site is why two
// traits on one type can both have a \`greet\` with no ambiguity.
function announce<T implements Greeter>(ref g: T): void {
  printf(\`hello from \${Greeter.greet(ref g)}\\n\`);
}`,
      note:
        "No x.method() sugar, on purpose: Trait.method(ref x) is unambiguous without a " +
        "resolution order to learn.",
    },
    kind: {
      lead:
        "A kind is a usage contract on the BINDING. Same type, two bindings, different " +
        "obligations. A kind can require a trait, make the compiler inject calls, forbid " +
        "a value from escaping its scope, or tag a value with a static marker that has no " +
        "runtime cost at all.",
      code: `// This is the entire declaration of \`disposable\`, from
// std/core/kinds.yoop. There is no compiler magic in it.
export trait Disposable {
  function dispose(ref self): void;
}

export kind disposable {
  appliesTo binding;                  // attaches to a let/const site
  requires Disposable;                // the type must implement it
  mustCall dispose beforeScopeEnd;    // inject the call at scope exit
  ownsBlock;                          // may take a trailing { } block
}

function useIt(): void {
  let a: Conn = { id: 1 };            // no kind: nothing injected
  disposable b: Conn = { id: 2 };     // dispose(b) placed at scope end
}`,
      note:
        "The compiler reads the clauses, not the name. Declare the same clauses under " +
        "your own name and your kind behaves identically.",
    },
  };

  function renderLayer(which) {
    const panel = document.getElementById("layer-panel");
    if (!panel) return;
    const layer = LAYERS[which];
    panel.innerHTML = "";
    panel.appendChild(el("p", { class: "lede", text: layer.lead }));
    panel.appendChild(codeBlock(layer.code, { name: which, commentToggle: false }));
    panel.appendChild(el("p", { class: "muted small", text: layer.note }));
    panel.setAttribute("aria-labelledby", "layer-" + which);
  }

  const layerButtons = Array.from(document.querySelectorAll(".layer-btn"));
  layerButtons.forEach((btn) => {
    btn.addEventListener("click", () => {
      layerButtons.forEach((other) =>
        other.setAttribute("aria-selected", String(other === btn)),
      );
      renderLayer(btn.dataset.layer);
    });
  });
  if (layerButtons.length) renderLayer("type");

  /* ------------------------------------------------------------ kind diff */

  function renderKindDiff() {
    const mount = document.getElementById("kind-diff");
    const data = (window.YOOP_DATA || {}).home;
    if (!mount) return;
    if (!data) {
      mount.innerHTML =
        '<p class="muted">The generated build output is missing. Run <code>npm run gen:web</code>.</p>';
      return;
    }

    mount.innerHTML = "";

    const column = (title, blurb, pair, highlight) => {
      const wrap = el("div", null, [
        el("h3", { text: title }),
        el("p", { class: "muted small", text: blurb }),
      ]);

      const tabs = el("div", { class: "tabs" });
      const bodyMount = el("div");
      const views = {
        source: () => codeBlock(pair.source, { name: "what you wrote", commentToggle: false }),
        ir: () => {
          const fig = codeBlock(pair.ir, {
            name: "what the compiler emitted",
            lang: "llvm",
            commentToggle: false,
          });
          if (highlight) {
            // Light up the injected call so the difference is findable
            // without reading forty lines of LLVM.
            const code = fig.querySelector("code");
            code.innerHTML = code.innerHTML.replace(
              /(call void @[\w.$]*dispose[\w.$]*\(ptr %c\))/,
              '<mark class="line-mark">$1</mark>',
            );
          }
          return fig;
        },
      };

      let current = "source";
      const paint = () => {
        bodyMount.innerHTML = "";
        bodyMount.appendChild(views[current]());
        tabs.querySelectorAll(".tab").forEach((tab) =>
          tab.setAttribute("aria-selected", String(tab.dataset.view === current)),
        );
      };

      for (const [view, label] of [
        ["source", "Yoop"],
        ["ir", "LLVM IR"],
      ]) {
        const tab = el("button", {
          class: "tab",
          type: "button",
          "aria-selected": String(view === current),
          text: label,
        });
        tab.dataset.view = view;
        tab.addEventListener("click", () => {
          current = view;
          paint();
        });
        tabs.appendChild(tab);
      }

      wrap.appendChild(tabs);
      wrap.appendChild(bodyMount);
      paint();
      return wrap;
    };

    mount.appendChild(
      column(
        "let: nothing happens",
        "A plain binding carries no obligation. Ownership is advisory by default and the compiler stays quiet.",
        data.plain,
        false,
      ),
    );
    mount.appendChild(
      column(
        "disposable: a call appears",
        "The kind requires Disposable and says mustCall dispose beforeScopeEnd, so the call is placed before every exit.",
        data.kinded,
        true,
      ),
    );
  }

  renderKindDiff();

  /* ---------------------------------------------------------------- stats */

  const status = (window.YOOP_DATA || {}).status;
  if (status) {
    document.querySelectorAll("[data-stat]").forEach((node) => {
      const value = status[node.dataset.stat];
      if (value !== null && value !== undefined) node.textContent = String(value);
    });
  }
})();
