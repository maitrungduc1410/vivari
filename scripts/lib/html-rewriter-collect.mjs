// Runs the shared corpus through whichever HTMLRewriter it is handed. One
// function, two callers: the recorder (real Bun) and the spike (Vivari's shim).
// Any divergence in HOW the two are driven would show up as a false difference,
// so they are driven by the same code.
export async function collect(HTMLRewriter, corpus) {
  const out = {};
  const run = (prefix, cases) => {
    for (const [name, html, build] of cases) {
      try {
        const r = new HTMLRewriter();
        build(r);
        out[prefix + name] = r.transform(html);
      } catch (e) {
        out[prefix + name] = "THROWS: " + e.message;
      }
    }
  };
  const observe = (prefix, cases) => {
    for (const [name, html, build] of cases) {
      const log = [];
      try {
        const r = new HTMLRewriter();
        build(r, log);
        r.transform(html);
        out[prefix + name] = log;
      } catch (e) {
        out[prefix + name] = "THROWS: " + e.message;
      }
    }
  };

  run("T:", corpus.CASES);
  observe("O:", corpus.OBSERVE);
  run("P:", corpus.PAGE_CASES);
  observe("Q:", corpus.PAGE_OBSERVE);

  for (const sel of [...corpus.BAD_SELECTORS, ...corpus.MORE_BAD_SELECTORS]) {
    try {
      new HTMLRewriter().on(sel, { element() {} }).transform("<p>x</p>");
      out["S:" + JSON.stringify(sel)] = "ACCEPTED";
    } catch (e) {
      out["S:" + JSON.stringify(sel)] = "THROWS: " + e.message;
    }
  }

  // The Response path, which is also the only one that may await a handler.
  try {
    const res = new HTMLRewriter()
      .on("p", { element(e) { e.setAttribute("z", "1"); } })
      .transform(new Response("<p>x</p>", { status: 201, headers: { "x-a": "1" } }));
    out["R:body"] = await res.text();
    out["R:meta"] = [res.status, res.headers.get("x-a")];
  } catch (e) {
    out["R:body"] = "THROWS: " + e.message;
  }
  try {
    const res = new HTMLRewriter()
      .on("p", { async element(e) { await new Promise((s) => setTimeout(s, 5)); e.setAttribute("async", "yes"); } })
      .transform(new Response("<p>x</p>"));
    out["R:async"] = await res.text();
  } catch (e) {
    out["R:async"] = "THROWS: " + e.message;
  }
  try {
    out["R:blob"] = String(new HTMLRewriter().transform(new Blob(["<p>x</p>"])));
  } catch (e) {
    out["R:blob"] = "THROWS: " + e.message;
  }
  try {
    const buf = new HTMLRewriter().on("p", { element(e) { e.setAttribute("z", "1"); } }).transform(new TextEncoder().encode("<p>x</p>"));
    out["R:bytes"] = [Object.prototype.toString.call(buf), new TextDecoder().decode(buf)];
  } catch (e) {
    out["R:bytes"] = "THROWS: " + e.message;
  }

  // The fuzz half: deterministic documents, so only the outputs need recording.
  const fuzz = [];
  for (let seed = 1; seed <= corpus.FUZZ_SEEDS; seed++) {
    const doc = corpus.makeDoc(corpus.rng(seed * 7919));
    for (const [, build] of corpus.RECIPES) {
      try {
        const r = new HTMLRewriter();
        build(r);
        fuzz.push(r.transform(doc));
      } catch (e) {
        fuzz.push("THROWS: " + e.message);
      }
    }
  }
  out["FUZZ"] = fuzz;
  return out;
}
