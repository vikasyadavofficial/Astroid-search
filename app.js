// Asteroid Explorer v1.0 - app.js
// Reads what the visitor typed, asks the Cloudflare Worker, and draws the answer.
// All text from the server is inserted with textContent (never innerHTML), so it cannot inject code.

(function () {
  "use strict";

  var cfg = window.ASTEROID_EXPLORER_CONFIG || {};
  var API_BASE = (cfg.apiBase || "").replace(/\/+$/, "");
  var FETCH_TIMEOUT_MS = 12000;

  var form = document.getElementById("search-form");
  var input = document.getElementById("search-input");
  var statusEl = document.getElementById("status");
  var resultEl = document.getElementById("result");
  var examples = document.getElementById("examples");
  var themeBtn = document.getElementById("theme-toggle");

  // A real record for 433 Eros (orbit fields only), so the page can be previewed before the
  // Worker is deployed. It is always labelled as a sample on screen.
  var SAMPLE = {
    status: "ok",
    sample: true,
    object: { fullname: "433 Eros (A898 PA)", shortname: "433 Eros", des: "433", kind: "an", neo: true, pha: false,
              orbit_class: { code: "AMO", name: "Amor" }, spkid: "20000433" },
    orbit: {
      epoch: "2461200.5", equinox: "J2000", source: "JPL", first_obs: "1893-10-29", last_obs: "2021-05-13",
      data_arc: "46582", n_obs_used: 9130, condition_code: "0", moid: "0.149", rms: "0.3",
      elements: [
        { name: "e", title: "eccentricity", value: "0.223", sigma: "9.4e-09", units: null },
        { name: "a", title: "semi-major axis", value: "1.46", sigma: "1.5e-10", units: "au" },
        { name: "q", title: "perihelion distance", value: "1.13", sigma: "1.4e-08", units: "au" },
        { name: "i", title: "inclination", value: "10.8", sigma: "1.2e-06", units: "deg" },
        { name: "om", title: "longitude of the ascending node", value: "304", sigma: "3.6e-06", units: "deg" },
        { name: "w", title: "argument of perihelion", value: "179", sigma: "4e-06", units: "deg" },
        { name: "per", title: "sidereal orbital period", value: "643", sigma: "1e-07", units: "d" },
        { name: "ad", title: "aphelion distance", value: "1.78", sigma: "1.9e-10", units: "au" }
      ]
    },
    phys_par: [],
    api_version: "1.3",
    jpl_url: "https://ssd.jpl.nasa.gov/tools/sbdb_lookup.html#/?sstr=433"
  };

  /* ------------------------------------------------------------------ helpers */

  function el(tag, props, children) {
    var node = document.createElement(tag);
    if (props) {
      Object.keys(props).forEach(function (k) {
        if (k === "class") node.className = props[k];
        else if (k === "text") node.textContent = props[k];
        else node.setAttribute(k, props[k]);
      });
    }
    (children || []).forEach(function (c) {
      if (c) node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
    });
    return node;
  }

  function isMissing(v) { return v === null || v === undefined || v === ""; }

  var UNIT_WORDS = { au: "au", deg: "°", d: "days", "deg/d": "°/day", km: "km", "km/s": "km/s", h: "hours", mag: "mag", TDB: "" };
  function unitText(u) { return isMissing(u) ? "" : (u in UNIT_WORDS ? UNIT_WORDS[u] : u); }

  // "1.2e-06" -> "1.2 × 10⁻⁶"; plain numbers pass through unchanged.
  var SUP = { "-": "⁻", "0": "⁰", "1": "¹", "2": "²", "3": "³", "4": "⁴", "5": "⁵", "6": "⁶", "7": "⁷", "8": "⁸", "9": "⁹" };
  function prettyNumber(s) {
    var m = /^(-?\d+(?:\.\d+)?)e([+-]?)(\d+)$/i.exec(String(s));
    if (!m) return String(s);
    var exp = (m[2] === "-" ? "-" : "") + String(parseInt(m[3], 10));
    return m[1] + " × 10" + exp.split("").map(function (c) { return SUP[c] || c; }).join("");
  }

  function julianToDate(jd) {
    var n = parseFloat(jd);
    if (!isFinite(n)) return null;
    var d = new Date((n - 2440587.5) * 86400000);
    return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
  }

  function plural(n, one, many) { return n + " " + (n === 1 ? one : many); }

  /* ------------------------------------------------------------------ status */

  function clearAll() { statusEl.replaceChildren(); resultEl.replaceChildren(); resultEl.hidden = true; }

  function showLoading(term) {
    clearAll();
    statusEl.appendChild(el("div", { class: "note" }, [
      el("span", { class: "spinner", "aria-hidden": "true" }),
      "Looking up “" + term + "” at NASA/JPL…"
    ]));
  }

  function showNote(title, lines, warn, buttons) {
    clearAll();
    var box = el("div", { class: "note" + (warn ? " warn" : "") }, [el("h3", { text: title })]);
    lines.forEach(function (l) { box.appendChild(el("p", { text: l })); });
    (buttons || []).forEach(function (b) {
      var btn = el("button", { type: "button", class: "btn", text: b.label });
      btn.addEventListener("click", b.onClick);
      box.appendChild(btn);
    });
    statusEl.appendChild(box);
  }

  function showMultiple(list, term) {
    clearAll();
    var ul = el("ul", { class: "match-list" });
    list.forEach(function (item) {
      var btn = el("button", { type: "button", text: item.name });
      btn.addEventListener("click", function () { input.value = item.pdes; search({ des: item.pdes }); });
      ul.appendChild(el("li", null, [btn]));
    });
    statusEl.appendChild(el("div", { class: "note" }, [
      el("h3", { text: plural(list.length, "object matches", "objects match") + " “" + term + "”" }),
      el("p", { text: "Pick the one you mean:" }),
      ul
    ]));
  }

  /* ------------------------------------------------------------------ rendering */

  function row(label, hint, valueNodes) {
    var dt = el("dt", null, [label, hint ? el("small", { text: hint }) : null]);
    var dd = el("dd", null, valueNodes);
    return el("div", { class: "row" }, [dt, dd]);
  }

  function valueWithUnit(value, units, sigma) {
    var nodes = [prettyNumber(value)];
    var u = unitText(units);
    if (u) nodes.push(el("span", { class: "unit", text: u }));
    if (!isMissing(sigma)) nodes.push(el("span", { class: "sigma", text: "± " + prettyNumber(sigma) + (u ? " " + u : "") + " (1-sigma uncertainty)" }));
    return nodes;
  }

  function notAvailable() { return [el("span", { class: "na", text: "Not available" })]; }

  var ELEMENT_INFO = {
    a:  ["Semi-major axis", "Average distance from the Sun. Earth is 1 au."],
    e:  ["Eccentricity", "How stretched the orbit is. 0 is a circle; closer to 1 is a long oval."],
    i:  ["Inclination", "Tilt of the orbit compared with Earth's orbit plane."],
    per:["Orbital period", "Time to go once around the Sun."],
    q:  ["Closest point to the Sun", "Perihelion distance."],
    ad: ["Farthest point from the Sun", "Aphelion distance."],
    om: ["Longitude of ascending node", "Where the orbit crosses Earth's orbit plane going north."],
    w:  ["Argument of perihelion", "Angle from that crossing to the closest point to the Sun."]
  };
  var ELEMENT_ORDER = ["a", "e", "i", "per", "q", "ad", "om", "w"];
  var PRIMARY = ["a", "e", "i", "per"];

  function describeKind(o) {
    var base = o.neo ? "Near-Earth asteroid" : "Asteroid";
    if (o.kind && o.kind.charAt(0) === "c") base = o.neo ? "Near-Earth comet" : "Comet";
    return o.orbit_class && o.orbit_class.name ? base + " · " + o.orbit_class.name + " class" : base;
  }

  var PHYS_LABELS = {
    H: ["Absolute magnitude (H)", "Brightness if seen from 1 au from both Sun and observer. Lower numbers mean brighter, and usually larger."],
    diameter: ["Diameter", "Size, where it has been measured or estimated."],
    albedo: ["Albedo", "How much sunlight the surface reflects (0 to 1)."],
    rot_per: ["Rotation period", "How long one spin takes."],
    extent: ["Shape (extent)", "Dimensions of the overall shape."],
    GM: ["GM (gravity strength)", "Mass times the gravitational constant."],
    density: ["Density", ""],
    spec_B: ["Spectral type (SMASSII)", "Type of surface material suggested by its colours."],
    spec_T: ["Spectral type (Tholen)", "Type of surface material suggested by its colours."],
    G: ["Slope parameter (G)", "Used with H to describe how brightness changes with viewing angle."]
  };

  function renderResult(data) {
    clearAll();
    var o = data.object || {}, orbit = data.orbit || {};

    // --- identity panel
    var head = el("section", { class: "panel result-head" });
    var h2 = el("h2", { text: o.fullname || o.shortname || "Unnamed object", tabindex: "-1" });
    head.appendChild(h2);
    head.appendChild(el("p", { class: "subtitle", text: describeKind(o) }));
    var badges = el("div", { class: "badges" });
    if (o.neo === true) badges.appendChild(el("span", { class: "badge", text: "Near-Earth object" }));
    badges.appendChild(el("span", { class: "badge", text: o.pha === true ? "Classed as potentially hazardous" : "Not classed as potentially hazardous" }));
    head.appendChild(badges);
    if (data.sample) head.appendChild(el("p", { class: "demo-banner", text: "Sample data for preview. Real searches appear once the page is connected to the Worker." }));
    resultEl.appendChild(head);

    // --- orbit panel
    var byName = {};
    (orbit.elements || []).forEach(function (e) { byName[e.name] = e; });
    var epochDate = julianToDate(orbit.epoch);
    var orbitPanel = el("section", { class: "panel" }, [
      el("h3", { text: "Orbit" }),
      el("p", { class: "caption", text: "Prediction fitted to observations" + (epochDate ? " · values are for " + epochDate + " (epoch JD " + orbit.epoch + ")" : "") })
    ]);
    var dlMain = el("dl", { class: "rows" });
    var dlMore = el("dl", { class: "rows" });
    ELEMENT_ORDER.forEach(function (key) {
      var info = ELEMENT_INFO[key];
      var e = byName[key];
      var nodes = e && !isMissing(e.value) ? valueWithUnit(e.value, e.units, e.sigma) : notAvailable();
      (PRIMARY.indexOf(key) >= 0 ? dlMain : dlMore).appendChild(row(info[0], info[1], nodes));
    });
    if (!isMissing(orbit.moid)) {
      dlMain.appendChild(row("Closest the orbits get to Earth", "Smallest gap between this asteroid's path and Earth's path. It says nothing about where either body is at any given time.",
        valueWithUnit(orbit.moid, "au", null)));
    }
    orbitPanel.appendChild(dlMain);
    var more = el("details", { class: "more" }, [el("summary", { text: "More orbit details" }), dlMore]);
    orbitPanel.appendChild(more);
    resultEl.appendChild(orbitPanel);

    // --- physical panel
    var physPanel = el("section", { class: "panel" }, [
      el("h3", { text: "Physical properties" }),
      el("p", { class: "caption", text: "Collected from outside studies. Many asteroids have little or none of this." })
    ]);
    var dlPhys = el("dl", { class: "rows" });
    var phys = Array.isArray(data.phys_par) ? data.phys_par : [];
    if (phys.length === 0) {
      dlPhys.appendChild(row("Size, spin and brightness", "", notAvailable()));
    } else {
      phys.forEach(function (p) {
        var lab = PHYS_LABELS[p.name] || [p.title || p.name, ""];
        var nodes = !isMissing(p.value) ? valueWithUnit(p.value, p.units, p.sigma) : notAvailable();
        if (!isMissing(p.value) && !isMissing(p.ref)) nodes.push(el("span", { class: "extra", text: "Source: " + p.ref }));
        dlPhys.appendChild(row(lab[0], lab[1], nodes));
      });
    }
    physPanel.appendChild(dlPhys);
    resultEl.appendChild(physPanel);

    // --- data quality panel
    var q = el("section", { class: "panel" }, [el("h3", { text: "How well is this orbit known?" })]);
    var dlq = el("dl", { class: "rows" });
    if (!isMissing(orbit.n_obs_used)) dlq.appendChild(row("Observations used", "Telescope and radar measurements behind the fit.", [String(orbit.n_obs_used)]));
    if (orbit.first_obs && orbit.last_obs) dlq.appendChild(row("Observed from – to", "", [orbit.first_obs + "  to  " + orbit.last_obs]));
    if (!isMissing(orbit.data_arc)) dlq.appendChild(row("Observation span", "", [orbit.data_arc + " days (≈ " + (parseFloat(orbit.data_arc) / 365.25).toFixed(1) + " years)"]));
    if (!isMissing(orbit.condition_code)) dlq.appendChild(row("Orbit condition code", "JPL's 0 – 9 scale. 0 means very well known; 9 means very uncertain.", [String(orbit.condition_code)]));
    if (!dlq.children.length) dlq.appendChild(row("Orbit quality", "", notAvailable()));
    q.appendChild(dlq);
    var src = el("p", { class: "small link-row" }, ["Source: NASA/JPL Small-Body Database" + (data.api_version ? " (API v" + data.api_version + ")" : "") + ". "]);
    if (data.jpl_url) src.appendChild(el("a", { href: data.jpl_url, target: "_blank", rel: "noopener noreferrer", text: "See the full record at JPL" }));
    q.appendChild(src);
    resultEl.appendChild(q);

    resultEl.hidden = false;
    h2.focus({ preventScroll: true });
    head.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
  }

  /* ------------------------------------------------------------------ search */

  var currentRequest = 0;

  function notConnected() {
    showNote("Not connected to the data service yet",
      ["The page is ready, but the Worker address has not been added to config.js. Until then you can preview the layout with sample data."],
      true,
      [{ label: "Show sample (Eros)", onClick: function () { renderResult(SAMPLE); } }]);
  }

  function search(params) {
    var term = (params.q !== undefined ? params.q : params.des || "").trim();
    if (!term) {
      showNote("Please type something to search", ["Try a name such as Eros, a number such as 433, or a designation such as 2003 CP20."], false);
      input.focus();
      return;
    }
    if (!API_BASE) { notConnected(); return; }

    var myId = ++currentRequest;
    showLoading(term);

    var qs = params.des !== undefined ? "des=" + encodeURIComponent(term) : "q=" + encodeURIComponent(term);
    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, FETCH_TIMEOUT_MS);

    fetch(API_BASE + "/api/asteroid?" + qs, { signal: ctrl.signal, headers: { Accept: "application/json" } })
      .then(function (res) {
        return res.json().catch(function () { return null; }).then(function (body) { return { res: res, body: body }; });
      })
      .then(function (r) {
        if (myId !== currentRequest) return; // a newer search replaced this one
        var b = r.body;
        if (!b || !b.status) throw new Error("bad reply");
        switch (b.status) {
          case "ok": renderResult(b); break;
          case "multiple": showMultiple(b.list || [], term); break;
          case "notfound":
            showNote("No asteroid found for “" + term + "”",
              ["Check the spelling, or try its number (for example 433) or its designation (for example 2003 CP20). Very new discoveries may not be in the database yet."], false);
            break;
          case "bad_request":
            showNote("That search can't be used", [b.message || "Please use letters, numbers and spaces only."], false);
            break;
          case "forbidden":
            showNote("This website isn't allowed to use the data service", ["The Worker's allowed-websites list needs this site's address. See the setup steps."], true);
            break;
          default:
            showNote("NASA/JPL's data isn't reachable right now",
              [b.message || "The service may be busy or down.", "This is usually temporary. Please try again in a minute."], true,
              [{ label: "Try again", onClick: function () { search(params); } }]);
        }
      })
      .catch(function () {
        if (myId !== currentRequest) return;
        showNote("Couldn't get an answer",
          ["Check your internet connection, then try again. If it keeps happening, the data service may be down."], true,
          [{ label: "Try again", onClick: function () { search(params); } }]);
      })
      .then(function () { clearTimeout(timer); });
  }

  form.addEventListener("submit", function (e) { e.preventDefault(); search({ q: input.value }); });
  examples.addEventListener("click", function (e) {
    var b = e.target.closest("button[data-q]");
    if (!b) return;
    input.value = b.getAttribute("data-q");
    search({ q: input.value });
  });

  /* ------------------------------------------------------------------ theme toggle */

  themeBtn.addEventListener("click", function () {
    var root = document.documentElement;
    var current = root.getAttribute("data-theme") ||
      (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
    var next = current === "dark" ? "light" : "dark";
    root.setAttribute("data-theme", next);
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", next === "dark" ? "#121212" : "#d9d9d9");
    try { localStorage.setItem("asteroid-explorer-theme", next); } catch (e) {}
  });

  // Allow a shareable link such as  index.html?q=Eros
  try {
    var preset = new URLSearchParams(location.search).get("q");
    if (preset) { input.value = preset; search({ q: preset }); }
  } catch (e) {}
})();
