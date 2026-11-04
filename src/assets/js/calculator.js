// /assets/js/calculator.js: "what can my machine run?" Guesses the visitor's hardware where the browser
// allows, then estimates which models fit in memory and how fast they'll run. Everything stays in the browser.
(function () {
  const root = document.getElementById("calculator");
  if (!root) return;

  const data = JSON.parse(document.getElementById("calculator-data").textContent);
  const form = root.querySelector("form");
  const results = root.querySelector("[data-results]");
  const detected = root.querySelector("[data-detected]");

  // ---------- Estimates ----------

  // GB per billion parameters: 4-bit (Q4_K_M, MLX 4-bit) is the usual sweet spot, 8-bit and 16-bit for small models
  const Q4 = 0.6;
  const Q8 = 1.07;
  const F16 = 2;
  // Context, runtime and a few other apps: what a model needs beyond its weights
  const OVERHEAD = 1.5;
  // Real-world share of memory bandwidth a runtime actually gets when generating
  const BANDWIDTH_EFFICIENCY = 0.55;

  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const gb = (n) => (n < 10 ? n.toFixed(1) : Math.round(n)) + " GB";

  // What the machine can give a model: fast memory (unified or VRAM), plus slow system RAM a PC can spill into
  function machine(state) {
    if (state.platform === "mac") {
      const chip = data.macChips.find((c) => c.id === state.chip) || data.macChips[0];
      // macOS lets the GPU use about two thirds of memory up to 36 GB, three quarters above that
      const fast = state.ram * (state.ram <= 36 ? 0.67 : 0.75);
      return { fast, slow: 0, bandwidth: chip.bandwidth, cpuBandwidth: chip.bandwidth, label: `${chip.name}, ${state.ram} GB` };
    }
    if (state.platform === "gpu") {
      const gpu = data.gpus.find((g) => g.id === state.gpu);
      const vram = gpu ? gpu.vram : state.vram;
      const bandwidth = gpu ? gpu.bandwidth : 400;
      return { fast: vram - 0.5, slow: Math.max(state.ram - 8, 0), bandwidth, cpuBandwidth: data.cpuBandwidth, label: `${gpu ? gpu.name : `${vram} GB GPU`}, ${state.ram} GB RAM` };
    }
    return { fast: 0, slow: Math.max(state.ram - 6, 2), bandwidth: data.cpuBandwidth, cpuBandwidth: data.cpuBandwidth, label: `CPU only, ${state.ram} GB RAM` };
  }

  // Bigger is smarter, roughly. A mixture-of-experts model sits between its active and total size;
  // an "effective" model (Gemma's E2B, E4B) is as smart as its active size, the rest is lookup tables.
  const smarts = (m) => (m.effective ? m.active : m.active ? Math.sqrt(m.params * m.active) : m.params);
  // When ranking, a model that fits comfortably beats a slightly bigger one that's a squeeze
  const FIT_WEIGHT = { good: 1, tight: 0.8, spill: 0.6, cpu: 1 };
  const rank = (r) => smarts(r.model) * FIT_WEIGHT[r.fit];

  function estimate(m, hw) {
    let need;
    if (m.modality === "text") need = m.params * Q4 + OVERHEAD;
    else if (m.modality === "image") need = (m.params + m.encoder) * Q8 + OVERHEAD;
    else need = m.params * F16 + 0.5;

    // Image models also come as 4-bit GGUF files, which roughly halves what they need
    const needSmall = m.modality === "image" ? (m.params + m.encoder) * Q4 + OVERHEAD : need;

    const total = hw.fast + hw.slow;
    let fit = "no";
    let quant = m.modality === "image" ? "8-bit" : m.modality === "text" ? "4-bit" : "full size";
    if (hw.fast && need <= hw.fast * 0.85) fit = "good";
    else if (hw.fast && need <= hw.fast) fit = "tight";
    else if (hw.fast && needSmall <= hw.fast) { fit = "tight"; quant = "4-bit GGUF"; need = needSmall; }
    else if (need <= total) fit = hw.fast ? "spill" : "cpu";
    else if (needSmall <= total) { fit = hw.fast ? "spill" : "cpu"; quant = "4-bit GGUF"; need = needSmall; }

    // Generating each token reads every active weight once, so speed is bandwidth over active size.
    // Whatever spills out of VRAM is read at system RAM speed.
    let speed = null;
    if (m.modality === "text" && fit !== "no") {
      const bytes = (m.active || m.params) * Q4;
      const onFast = hw.fast ? Math.min(1, hw.fast / need) : 0;
      const seconds = (bytes * onFast) / hw.bandwidth + (bytes * (1 - onFast)) / hw.cpuBandwidth;
      speed = (BANDWIDTH_EFFICIENCY / seconds);
    }
    return { model: m, need, fit, quant, speed };
  }

  // Verdicts that say it all; their reason only shows in the details
  const SELF_EXPLAINING = ["Works, a bit slow", "Works, spills into RAM", "Too big"];

  const LICENCES = { "apache-2.0": "Apache 2.0", mit: "MIT", "cc-by-4.0": "CC BY 4.0", "openrail++": "OpenRAIL++", openrail: "OpenRAIL", "cc-by-nc-4.0": "CC BY-NC 4.0 (non-commercial)", openmdw: "OpenMDW" };

  // One honest verdict per model: [label, tone, reason]. "Works" is not the same as "worth it".
  function verdict(r, state) {
    if (r.fit === "no") return ["Too big", "muted", `Needs ~${gb(r.need)}`];
    if (r.speed != null && r.speed < 5) return ["Works, not recommended", "warn", "Under 5 tokens/s, very slow"];
    // Spilling into system RAM only matters when it makes the model slow, which the speed checks catch.
    // MoE models often still run well, since only a few experts are read per token.
    if (r.fit === "spill" && r.speed != null && r.speed < 12) return ["Works, not recommended", "warn", "Spills into system RAM, so it's slow"];
    if (r.fit === "cpu" && state.modality === "image") return ["Works, not recommended", "warn", "Minutes per image without a GPU"];
    if (r.fit === "tight") return ["Works, but tight", "warn", "Close other apps first"];
    if (r.speed != null && r.speed < 12) return ["Works, a bit slow", "warn", "Slower than you read, but usable"];
    if (r.fit === "spill") return ["Works, spills into RAM", "warn", "Part of it runs from system RAM, which is slower"];
    return ["Runs well", "good", r.speed ? (r.speed >= 30 ? "Fast replies" : "Good speed") : "Plenty of room"];
  }

  // ---------- Picking ----------

  function recommend(state) {
    const hw = machine(state);
    const pool = data.models
      .filter((m) => m.modality === state.modality)
      .filter((m) => state.modality !== "text" || m.uses.includes(state.use))
      .map((m) => estimate(m, hw));

    const runs = pool.filter((r) => r.fit !== "no");
    // A "Best match" we'd tell you not to use is no match, so only fall back to those if nothing else runs
    const worthIt = runs.filter((r) => !verdict(r, state)[0].endsWith("not recommended"));
    const candidates = worthIt.length ? worthIt : runs;
    const fast = state.mode === "fast";
    let picks;

    if (state.modality === "text") {
      // Fast wants quick replies, Smart wants the cleverest model that's still bearable to use
      const floors = fast ? [25, 12, 0] : [6, 3, 0];
      for (const floor of floors) {
        picks = candidates.filter((r) => r.speed >= floor);
        if (picks.length) break;
      }
      picks.sort((a, b) => rank(b) - rank(a));
    } else {
      picks = candidates.filter((r) => !fast || r.model.fast);
      if (!picks.length) picks = candidates;
      picks.sort((a, b) => (fast && state.modality !== "image" ? a.model.params - b.model.params : rank(b) - rank(a)));
    }

    const top = picks.slice(0, 3);
    const rest = runs.filter((r) => !top.includes(r)).sort((a, b) => smarts(b.model) - smarts(a.model));
    const tooBig = pool.filter((r) => r.fit === "no").sort((a, b) => a.need - b.need);
    return { hw, top, rest, tooBig };
  }

  // ---------- Rendering ----------

  const hfUrl = (id) => `https://huggingface.co/${id}`;
  // Every quantised upload of a model (GGUF, MLX and so on) is tagged with its base model on Hugging Face
  const quantsUrl = (id, library) => `https://huggingface.co/models?other=base_model:quantized:${id}${library ? `&library=${library}` : ""}&sort=downloads`;
  const sizeText = (m) => (m.active ? `${m.params}B, ${m.active}B active` : m.params < 1 ? Math.round(m.params * 1000) + "M" : m.params + "B");
  // A speed bar is full at 60 tokens/s: faster than anyone reads
  const SPEED_FULL = 60;
  // Tokens per second in plain words. People read about 4 to 5 words (6 tokens) a second.
  // Same cut-offs as the verdicts: under 12 is "a bit slow", under 5 isn't recommended.
  const speedWord = (t) => (t >= 30 ? "Very fast" : t >= 12 ? "Fast" : t >= 5 ? "Reading pace" : "Very slow");

  function logo(m) {
    const org = m.id.split("/")[0];
    const lab = data.labs[org];
    return lab
      ? `<span class="calc-row__logo"><img src="${lab.logo}" alt="" width="24" height="24" loading="lazy"></span>`
      : `<span class="calc-row__logo calc-row__logo--blank" aria-hidden="true">${esc(org[0].toUpperCase())}</span>`;
  }

  const thirdLabel = (modality) => (modality === "text" ? "Speed" : modality === "image" ? "Steps" : "Size");

  // What a text model can do beyond plain chat: [icon, short tag, longer explanation]
  const CAPS = {
    vision: ["bi-eye", "Images", "Reads photos, screenshots, charts and scanned pages, including the text in them (OCR)."],
    tools: ["bi-tools", "Tools", "Can call tools, so apps can let it search, run code or work as an agent."],
    thinking: ["bi-lightbulb", "Reasoning", "Can think step by step before answering. Slower, but better at hard problems."],
    coding: ["bi-code-slash", "Coding", "Trained for writing and fixing code."],
  };
  const caps = (m) => (m.modality === "text" ? Object.keys(CAPS).filter((k) => m.uses.includes(k)) : []);
  const ext = `<i class="bi bi-box-arrow-up-right" aria-hidden="true"></i>`;
  const extLink = (href, text, label) => `<a class="calc-ext" href="${href}" target="_blank" rel="noopener" aria-label="${esc(label)} (opens in a new tab)">${text}${ext}</a>`;

  function details(r, state) {
    const m = r.model;
    const [label, , reason] = verdict(r, state);
    const org = m.id.split("/")[0];
    const lab = data.labs[org];
    const facts = [
      ["Made by", esc(lab ? lab.name : org)],
      ["Size", `${sizeText(m)} parameters${m.active ? ". Only the active part is read for each word, so it's fast for its size" : ""}`],
      ["How it runs", `${label}. ${reason}.`],
      ...(r.speed != null ? [["Speed", `About ${Math.round(r.speed * 0.75)} words a second (${Math.round(r.speed)} tokens/s)`]] : []),
      ["Needs", `About ${gb(r.need)} of memory at ${r.quant}`],
      ["Licence", `${LICENCES[m.license] || "Custom, check the model page"}${m.fullyOpen ? ", and the training data is open too" : ""}`],
    ];
    const can = caps(m);
    let abilities = "";
    if (m.modality === "text") {
      const list = [["bi-chat-text", "Chat and writing", "Text in, text out."], ...can.map((k) => CAPS[k])];
      abilities = `<ul class="calc-abilities">${list.map(([i, t, d]) => `<li><i class="bi ${i}" aria-hidden="true"></i><span><b>${t}</b> ${d}</span></li>`).join("")}</ul>
        <p class="calc-detail__files"><b>Attachments:</b> ${can.includes("vision") ? "images and documents." : "documents, not images."} Apps like LM Studio and Open WebUI pull the text out of PDFs and text files${can.includes("vision") ? ", and pass images straight to the model." : ". Images and scanned pages need a model that reads images."}</p>`;
    }
    return `<div class="calc-detail__grid">
      <div>${abilities}${m.note ? `<p class="calc-detail__note">${esc(m.note)}</p>` : ""}</div>
      <dl class="calc-detail__facts">${facts.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("")}</dl>
    </div>
    <p class="calc-detail__links">${extLink(hfUrl(m.id), "Model page on Hugging Face", `${m.name} on Hugging Face`)}</p>`;
  }

  function row(r, state, best) {
    const m = r.model;
    const [label, tone, reason] = verdict(r, state);
    const key = m.id.replace(/[^a-z0-9]/gi, "-");
    const open = openDetails.has(m.id);

    let third = `<span class="calc-row__muted">${sizeText(m)}</span>`;
    if (r.speed != null) third = `<span class="calc-speed calc-speed--${r.speed < 12 ? "warn" : "good"}"><span class="calc-speed__word">${speedWord(r.speed)}</span><span class="calc-speed__line"><span class="calc-speed__bar" aria-hidden="true"><span style="width:${Math.max(Math.min(r.speed / SPEED_FULL, 1) * 100, 3)}%"></span></span><span class="calc-speed__num" title="Tokens per second. A token is about three quarters of a word.">${Math.round(r.speed)} tok/s</span></span></span>`;
    else if (m.steps) third = `${esc(m.steps)} steps`;
    if (r.fit === "no") third = `<span class="calc-row__muted" aria-label="Not applicable">n/a</span>`;

    // Every row has the ability the list is filtered by, so that tag would only be noise
    const tags = caps(m).filter((k) => state.modality !== "text" || k !== state.use).map((k) => `<span class="calc-tag" title="${CAPS[k][2]}"><i class="bi ${CAPS[k][0]}" aria-hidden="true"></i>${CAPS[k][1]}</span>`);
    const downloads = [];
    if (m.modality === "text" && r.fit !== "no") {
      if (state.platform === "mac") downloads.push(extLink(quantsUrl(m.id, "mlx"), "MLX", `MLX downloads of ${m.name}`));
      downloads.push(extLink(quantsUrl(m.id, "gguf"), "GGUF", `GGUF downloads of ${m.name}`));
    }

    return `<tr class="calc-row${best ? " calc-row--best" : ""}${r.fit === "no" ? " calc-row--off" : ""}${open ? " is-open" : ""}">
      <td><div class="calc-row__model">${logo(m)}<div>
        <span class="calc-row__head"><a class="calc-row__name" href="${hfUrl(m.id)}" target="_blank" rel="noopener">${esc(m.name)}</a>${best ? `<span class="calc-row__best">Best match</span>` : ""}${downloads.length ? `<span class="calc-row__get">${downloads.join("")}</span>` : ""}</span>
        ${tags.length ? `<span class="calc-row__line">${tags.join("")}</span>` : ""}
      </div></div></td>
      <td class="calc-row__need" data-label="Needs">~${gb(r.need)}</td>
      <td class="calc-row__speed" data-label="${thirdLabel(state.modality)}">${third}</td>
      <td class="calc-row__verdict"><span class="calc-verdict calc-verdict--${tone}">${label}</span>${tone === "good" || SELF_EXPLAINING.includes(label) ? "" : `<span class="calc-row__muted">${reason}</span>`}</td>
      <td class="calc-row__more"><button type="button" class="calc-more" data-more="${esc(m.id)}" aria-expanded="${open}" aria-controls="detail-${key}" aria-label="More about ${esc(m.name)}"><i class="bi bi-chevron-down" aria-hidden="true"></i></button></td>
    </tr>
    <tr class="calc-detail" id="detail-${key}" ${open ? "" : "hidden"}><td colspan="5">${details(r, state)}</td></tr>`;
  }


  // A label with an (i) that opens a plain-English explanation underneath
  const info = (id, label, text) => ({
    label: `${label}<button type="button" class="calc-info" data-info="${id}" aria-expanded="${openInfo.has(id)}" aria-controls="info-${id}" aria-label="What is ${label.toLowerCase()}?"><i class="bi bi-info-circle" aria-hidden="true"></i><i class="bi bi-info-circle-fill" aria-hidden="true"></i></button>`,
    text: `<p class="calc-info__text" id="info-${id}" ${openInfo.has(id) ? "" : "hidden"}>${text}</p>`,
  });

  // What the settings add up to, with the reasoning one click away
  function readout(state, hw) {
    const usable = hw.fast || hw.slow;
    const total = state.platform === "mac" ? state.ram : state.platform === "gpu" ? hw.fast + 0.5 : state.ram;
    const reserved = Math.max(total - usable, 0);
    const reserveLabel = state.platform === "mac" ? "macOS and apps" : state.platform === "gpu" ? "the display" : "the system and apps";
    // The biggest dense model that fits comfortably, using the same sums as the table
    const maxB = Math.max(Math.floor((usable * 0.85 - 1.5) / 0.6), 1);

    const memText = state.platform === "gpu"
      ? "Your graphics card's own memory (VRAM). A model has to fit here to run at full speed."
      : state.platform === "mac"
        ? "The part of your memory the Mac lets its GPU use. A model has to fit here to run well. macOS keeps the rest for itself and your apps."
        : "System RAM left over after the operating system and your apps. A model has to fit here to run.";
    const rows = [
      [info("mem", "Memory for AI", memText), `~${gb(usable)}`, `<div class="calc-bar" role="img" aria-label="${gb(usable)} for AI, ${gb(reserved)} for ${reserveLabel}"><span style="width:${(usable / total) * 100}%"></span></div><div class="calc-bar__key"><span>${gb(usable)} for AI</span><span>${gb(reserved)} for ${reserveLabel}</span></div>`],
      [info("bw", "Bandwidth", "How fast the chip can read its memory. Writing each word means reading the whole model once, so more bandwidth means faster replies. It matters more than the processor."), `${hw.bandwidth} GB/s`, ""],
    ];
    if (hw.fast && hw.slow) rows.push([info("spill", "Spill-over RAM", "System RAM a model can overflow into when it doesn't fit on the graphics card. It works, but that part runs much slower."), gb(hw.slow), ""]);
    rows.push([info("size", "Recommended size", `The biggest models that fit comfortably, in billions of parameters (B). Bigger is smarter but slower. Mixture-of-experts models, like Qwen3.6 35B A3B, can be bigger than this and still run, because they only read a few billion at a time.`), `Up to ${maxB}B`, ""]);

    return `<summary class="calc-machine__title"><h3>Your AI stats</h3><span class="calc-machine__peek">~${gb(usable)} for AI, up to ${maxB}B</span><i class="bi bi-chevron-down" aria-hidden="true"></i></summary>` + rows.map(([i, v, extra]) => `<div class="calc-machine__row"><span class="calc-machine__label">${i.label}</span><span class="calc-machine__value">${v}</span>${i.text}${extra}</div>`).join("");
  }

  // What Fast and Smart mean for the top picks, right where their effect shows
  const pickNote = (s) => (s.modality === "text"
    ? (s.mode === "fast" ? "Quick replies first" : "The cleverest models that are still usable")
    : (s.mode === "fast" ? "Quicker models first" : "Best quality first"));

  const ready = (s) => s.platform && s.ram && (s.platform !== "mac" || s.chip) && (s.platform !== "gpu" || s.gpu);

  function render() {
    const state = readForm();
    if (!configured || !ready(state)) {
      readoutEl.innerHTML = "";
      summary.textContent = "";
      const where = `<span class="calc-where--side">on the left</span><span class="calc-where--top">above</span>`;
      results.innerHTML = `<div class="calc-results__empty"><i class="bi bi-cpu calc-results__icon" aria-hidden="true"></i><p>${configured ? `Finish setting up your device ${where} to see which models run on it.` : `Set up your device ${where} and the models that run on it show up here, best first.`}</p>${configured ? "" : `<button type="button" class="btn btn-primary" data-detect><i class="bi bi-magic me-2" aria-hidden="true"></i>Detect my device</button>`}</div>`;
      return;
    }

    const { hw, top, rest, tooBig } = recommend(state);
    // Within "Also runs", the ones that run well come before the ones that only just work
    // and those are ordered fastest first, so the least painful ones come first
    const tier = (r) => (verdict(r, state)[1] === "good" ? 0 : 1);
    rest.sort((a, b) => tier(a) - tier(b) || (tier(a) && a.speed != null && b.speed != null ? b.speed - a.speed : 0));
    readoutEl.innerHTML = readout(state, hw);
    // Open beside the results; folded when it would push them down a phone screen, unless opened
    readoutEl.open = statsOpen != null ? statsOpen : wide.matches;

    const warnings = [];
    if (state.platform === "mac" && state.ram <= 8) warnings.push("8 GB Macs can run small models, but close your browser tabs first: macOS and Safari share the same memory.");

    const third = thirdLabel(state.modality);
    const cols = `<colgroup><col><col class="calc-col--need"><col class="calc-col--speed"><col class="calc-col--verdict"><col class="calc-col--more"></colgroup>`;
    const head = `<thead><tr><th scope="col">Model</th><th scope="col">Needs</th><th scope="col">${third}</th><th scope="col">How it runs</th><th scope="col"><span class="visually-hidden">Details</span></th></tr></thead>`;
    // One block per group, with a gap between: top picks open, the others behind a full-width header
    const block = (key, title, list, collapsible) => {
      if (!list.length) return "";
      const shown = !collapsible || openGroups.has(key);
      const header = collapsible
        ? `<button type="button" class="calc-block__head" data-group="${key}" aria-expanded="${shown}" aria-controls="calc-${key}"><span>${title} <span class="calc-block__count">${list.length}</span></span><span class="calc-block__action">${shown ? "Hide" : "Show"}<i class="bi bi-chevron-down" aria-hidden="true"></i></span></button>`
        : `<h3 class="calc-block__head">${title}<span class="calc-block__note">${pickNote(state)}</span></h3>`;
      return `<section class="calc-block${collapsible ? " calc-block--more" : ""}${shown ? " is-open" : ""}">${header}
        <div class="calc-table-wrap" id="calc-${key}" ${shown ? "" : "hidden"}><table class="calc-table">
          <caption class="visually-hidden">${title}, ${esc(hw.label)}</caption>${cols}${head}
          <tbody>${list.map((r) => row(r, state, r === top[0])).join("")}</tbody>
        </table></div></section>`;
    };
    results.innerHTML = `
      ${warnings.map((w) => `<p class="calc-results__warning"><i class="bi bi-exclamation-triangle me-2" aria-hidden="true"></i>${esc(w)}</p>`).join("")}
      ${top.length ? "" : `<p class="calc-results__warning"><i class="bi bi-exclamation-triangle me-2" aria-hidden="true"></i>Nothing on our list runs on this machine for that yet. Try another kind of task.</p>`}
      ${block("top", "Top picks", top, false)}
      ${block("rest", "Also works", rest, true)}
      ${block("toobig", "Too big for this machine", tooBig, true)}
    `;
    const count = top.length + rest.length;
    summary.textContent = count ? `${count} ${count === 1 ? "model runs" : "models run"} on ${hw.label}. Best match: ${top[0].model.name}.` : `Nothing on our list runs on ${hw.label} for that yet.`;
  }

  // ---------- Form ----------

  const field = (name) => form.elements[name];
  let configured = false;
  let ramGuessed = false;
  const openGroups = new Set();
  const openDetails = new Set();
  const openInfo = new Set();
  const readoutEl = root.querySelector("[data-readout]");
  const summary = root.querySelector("[data-summary]");
  // Wide enough for the sidebar layout; the stats card stays open there
  const wide = matchMedia("(min-width: 992px)");
  let statsOpen = null;
  // Remember a visitor's own open or close (the click lands before the details toggles)
  readoutEl.addEventListener("click", (e) => {
    if (e.target.closest("summary")) statsOpen = !readoutEl.open;
  });

  function readForm() {
    const fd = new FormData(form);
    return {
      platform: fd.get("platform"),
      chip: fd.get("chip"),
      gpu: fd.get("gpu"),
      vram: Number(fd.get("vram")) || 8,
      ram: Number(fd.get("ram")) || null,
      mode: fd.get("mode"),
      modality: fd.get("modality"),
      use: fd.get("use"),
    };
  }

  // Memory sizes worth offering: the ones a Mac chip actually came with, or common PC sizes
  const PC_RAM = [8, 16, 32, 64, 128];
  function ramChoices({ platform, chip }) {
    if (platform !== "mac") return PC_RAM;
    const c = data.macChips.find((x) => x.id === chip);
    return c ? c.ram : [...new Set(data.macChips.flatMap((x) => x.ram))].sort((a, b) => a - b);
  }

  const PLATFORMS = { mac: ["bi-apple", "Mac"], cpu: ["bi-laptop", "Laptop or PC, no graphics card"], gpu: ["bi-gpu-card", "Graphics card"] };
  const choose = `<span class="calc-set__missing">Choose one</span>`;

  // Show each setting's current value, and only the settings that matter for this device
  function sync() {
    const state = readForm();
    root.querySelectorAll("[data-show-for]").forEach((el) => {
      el.hidden = !el.dataset.showFor.split(" ").every((rule) => {
        const [key, values] = rule.split(":");
        return values.split(",").includes(state[key] || "none");
      });
    });

    // Hide impossible memory sizes, and move the choice to the closest real one
    const choices = ramChoices(state);
    form.querySelectorAll('[name="ram"]').forEach((r) => {
      const ok = choices.includes(Number(r.value));
      r.hidden = !ok;
      r.nextElementSibling.hidden = !ok;
    });
    if (state.ram && !choices.includes(state.ram)) {
      const closest = choices.reduce((a, b) => (Math.abs(b - state.ram) < Math.abs(a - state.ram) ? b : a));
      setValue("ram", String(closest));
      state.ram = closest;
    }

    const chip = data.macChips.find((c) => c.id === state.chip);
    const gpu = data.gpus.find((g) => g.id === state.gpu);
    const values = {
      platform: state.platform ? `<span class="calc-set__with-icon"><i class="bi ${PLATFORMS[state.platform][0]}" aria-hidden="true"></i><span>${PLATFORMS[state.platform][1]}</span></span>` : choose,
      chip: chip ? `Apple ${chip.name}` : choose,
      gpu: gpu ? `${gpu.name} <small>${gpu.vram} GB</small>` : state.gpu === "other" ? `Another card <small>${state.vram} GB</small>` : choose,
      ram: state.ram ? `${state.ram} GB${ramGuessed ? ` <small class="calc-set__guess"><i class="bi bi-question-circle" aria-hidden="true"></i> A guess <button type="button" class="calc-confirm" data-confirm-ram><i class="bi bi-check-lg" aria-hidden="true"></i>That's right</button></small>` : ""}` : choose,
    };
    for (const [k, v] of Object.entries(values)) root.querySelector(`[data-value="${k}"]`).innerHTML = v;

    root.querySelector("[data-ram-label]").textContent = state.platform === "mac" ? "Memory" : "System RAM";
    root.querySelector("[data-ram-hint]").textContent = state.platform === "mac" ? "Only the sizes your chip came with. Apple menu, then About This Mac." : "Settings, then About, on most computers.";

    // Task buttons in the main column mirror the hidden inputs
    root.querySelectorAll("[data-pick]").forEach((b) => b.setAttribute("aria-pressed", String(state[b.dataset.pick] === b.dataset.val)));
    root.querySelectorAll("[data-pick-select]").forEach((s) => (s.value = state[s.dataset.pickSelect]));
  }

  function setOpen(set, open) {
    const choices = set.querySelector("[data-choices]");
    const edit = set.querySelector("[data-edit]");
    if (!choices) return;
    choices.hidden = !open;
    edit.setAttribute("aria-expanded", String(open));
    set.classList.toggle("is-open", open);
  }

  // Anything still unknown starts open, so it's obvious what's left to pick
  function openMissing() {
    const state = readForm();
    const missing = { platform: !state.platform, chip: state.platform === "mac" && !state.chip, gpu: state.platform === "gpu" && !state.gpu, ram: !!state.platform && !state.ram };
    for (const [k, open] of Object.entries(missing)) if (open) setOpen(root.querySelector(`[data-set="${k}"]`), true);
  }

  // Keep the choices in the address bar, so a link shares the exact result (handy at workshops)
  function saveToUrl() {
    if (!configured) return;
    const params = new URLSearchParams(new FormData(form));
    const p = params.get("platform");
    if (p !== "mac") params.delete("chip");
    if (p !== "gpu") params.delete("gpu");
    if (p !== "gpu" || params.get("gpu") !== "other") params.delete("vram");
    if (params.get("modality") !== "text") params.delete("use");
    history.replaceState(null, "", `${location.pathname}?${params}`);
  }

  function setValue(name, value) {
    const el = field(name);
    if (!el || value == null) return;
    if (el instanceof RadioNodeList || el.type === "radio") {
      [...form.querySelectorAll(`[name="${name}"]`)].forEach((r) => (r.checked = r.value === String(value)));
    } else {
      el.value = value;
    }
  }

  function clearDevice() {
    form.querySelectorAll('[name="platform"], [name="chip"], [name="gpu"], [name="ram"]').forEach((r) => (r.checked = false));
  }

  // Once a device is set, the big button becomes "Detect again" and the "or pick" line goes
  function showSettings() {
    configured = true;
    root.classList.add("is-configured");
    root.querySelector("[data-detect-label]").textContent = "Detect again";
    root.querySelector(".calc-start__btn").classList.add("calc-start__btn--quiet");
    root.querySelector("[data-or]").hidden = true;
  }

  function update() {
    sync();
    render();
    saveToUrl();
  }

  // ---------- Detection ----------

  // The GPU name comes from WebGL. Chrome and Edge usually give the real name (e.g. "Apple M2 Pro" or
  // "NVIDIA GeForce RTX 4070"); Safari, Firefox and Brave often hide it, so everything stays editable.
  function gpuName() {
    try {
      const gl = document.createElement("canvas").getContext("webgl");
      const ext = gl && gl.getExtension("WEBGL_debug_renderer_info");
      return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : "";
    } catch {
      return "";
    }
  }

  function detect() {
    clearDevice();
    root.querySelectorAll("[data-set]").forEach((s) => setOpen(s, false));
    const found = [];
    const renderer = gpuName();
    const platform = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || "";

    if (/mac/i.test(platform)) {
      setValue("platform", "mac");
      const m = renderer.match(/Apple (M\d)(?: (Pro|Max|Ultra))?/i);
      const id = m && `${m[1]}${m[2] ? `-${m[2]}` : ""}`.toLowerCase();
      if (id && data.macChips.some((c) => c.id === id)) {
        setValue("chip", id);
        found.push(`an Apple ${data.macChips.find((c) => c.id === id).name}`);
      } else found.push("a Mac");
    } else if (renderer) {
      const gpu = data.gpus.find((g) => new RegExp(g.match, "i").test(renderer));
      if (gpu) {
        setValue("platform", "gpu");
        setValue("gpu", gpu.id);
        found.push(gpu.name);
      } else if (/nvidia|radeon|arc/i.test(renderer)) {
        setValue("platform", "gpu");
        setValue("gpu", "other");
        found.push(`a graphics card (${renderer.replace(/^ANGLE \(|\)$/g, "")})`);
      } else if (/intel|uhd|iris|microsoft basic|llvmpipe|swiftshader/i.test(renderer)) {
        setValue("platform", "cpu");
        found.push("built-in graphics only");
      }
    }

    // Browsers can't really see memory: Chrome rounds it and caps it at 8 GB, Brave makes it up.
    // So below 8 GB use it as a hint, otherwise guess 16 GB, the most common size. Either way
    // sync() moves it to the nearest size this machine came in, and it's marked as a guess.
    const state = readForm();
    if (state.platform) {
      const hint = navigator.deviceMemory && navigator.deviceMemory < 8 ? navigator.deviceMemory : 16;
      const choices = ramChoices(state);
      setValue("ram", String(choices.reduce((a, b) => (Math.abs(b - hint) < Math.abs(a - hint) ? b : a))));
      ramGuessed = true;
    }

    showSettings();
    status.textContent = found.length ? `Found ${found.join(", ")}. Browsers can't see everything, so check the rest.` : "Your browser keeps your hardware private, so pick it below.";
    sync();
    openMissing();
    render();
    saveToUrl();
  }

  // ---------- Start ----------

  const status = root.querySelector("[data-detected]");

  // Navbar height, so the sidebar sits right under it
  const nav = document.getElementById("navbar-main");
  const setTop = () => root.style.setProperty("--calc-top", `${nav ? nav.offsetHeight : 0}px`);
  setTop();
  window.addEventListener("resize", setTop);

  // Clicking anywhere on a model's row opens its details, except on its links and buttons
  results.addEventListener("click", (e) => {
    const tr = e.target.closest("tr.calc-row");
    if (!tr || e.target.closest("a, button") || getSelection().toString()) return;
    tr.querySelector("[data-more]").click();
  });

  root.addEventListener("click", (e) => {
    const t = e.target.closest("button");
    if (!t) return;
    if (t.matches("[data-detect]")) detect();
    else if (t.matches("[data-edit]")) {
      const set = t.closest("[data-set]");
      setOpen(set, set.querySelector("[data-choices]").hidden);
    } else if (t.matches("[data-pick]")) {
      setValue(t.dataset.pick, t.dataset.val);
      update();
    } else if (t.matches("[data-confirm-ram]")) {
      ramGuessed = false;
      update();
      root.querySelector('[data-set="ram"] [data-edit]').focus();
    } else if (t.matches("[data-more]")) {
      const id = t.dataset.more;
      openDetails.has(id) ? openDetails.delete(id) : openDetails.add(id);
      const open = openDetails.has(id);
      t.setAttribute("aria-expanded", String(open));
      t.closest("tr").classList.toggle("is-open", open);
      document.getElementById(t.getAttribute("aria-controls")).hidden = !open;
    } else if (t.matches("[data-info]")) {
      const id = t.dataset.info;
      openInfo.has(id) ? openInfo.delete(id) : openInfo.add(id);
      t.setAttribute("aria-expanded", String(openInfo.has(id)));
      document.getElementById(`info-${id}`).hidden = !openInfo.has(id);
    } else if (t.matches("[data-group]")) {
      const key = t.dataset.group;
      openGroups.has(key) ? openGroups.delete(key) : openGroups.add(key);
      render();
      results.querySelector(`[data-group="${key}"]`).focus();
    }
  });

  // Clicking a setting's label or value opens it too, not just the pencil
  form.addEventListener("click", (e) => {
    const row = e.target.closest(".calc-set__row");
    if (!row || e.target.closest("button, input, label")) return;
    const set = row.closest("[data-set]");
    if (set && set.querySelector("[data-choices]")) setOpen(set, set.querySelector("[data-choices]").hidden);
  });

  root.addEventListener("change", (e) => {
    const s = e.target.closest("[data-pick-select]");
    if (!s) return;
    setValue(s.dataset.pickSelect, s.value);
    update();
  });

  form.addEventListener("submit", (e) => e.preventDefault());
  form.addEventListener("change", (e) => {
    if (e.target.name === "ram") ramGuessed = false;
    if (!configured) showSettings();
    update();
    openMissing();
  });
  // A pick closes its setting, even when it's the one already chosen (that fires no change event).
  // Arrow keys also "click" radios, so only a pointer click on the label or Enter/Space closes it.
  function closeAfterPick(set, refocus) {
    setTimeout(() => {
      // Picking the guessed memory size again confirms it
      if (set.dataset.set === "ram" && ramGuessed) {
        ramGuessed = false;
        update();
      }
      setOpen(set, false);
      openMissing();
      if (refocus) set.querySelector("[data-edit]").focus();
    });
  }
  form.addEventListener("click", (e) => {
    const set = e.target.closest("[data-set]");
    if (set && e.target.closest("label") && e.target.closest("[data-choices]")) closeAfterPick(set, false);
  });
  form.addEventListener("keydown", (e) => {
    const set = e.target.closest("[data-set]");
    if (set && e.target.matches('input[type="radio"]') && (e.key === "Enter" || e.key === " ")) {
      e.preventDefault();
      e.target.checked = true;
      e.target.dispatchEvent(new Event("change", { bubbles: true }));
      closeAfterPick(set, true);
    }
  });

  const query = new URLSearchParams(location.search);
  if (query.has("platform")) {
    for (const [k, v] of query) setValue(k, v);
    showSettings();
    status.textContent = "Loaded from a shared link.";
  }
  sync();
  if (configured) openMissing();
  render();
})();
