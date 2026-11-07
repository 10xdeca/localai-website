// /assets/js/webllm-chat.js: the localAI chat. A small open model runs in the visitor's own browser with
// WebLLM (WebGPU). Every question is answered from the site's own content (chat-index.json, searched here),
// and Qwen models can also act on the site with the same tools WebMCP agents get (webmcp.js).
// It lives on /resources/chat/ and, on laptops and desktops, as a floating chat on every other page. The
// model stays loaded in a service worker (webllm-sw.js) and the conversation in sessionStorage, so both
// carry on as the visitor moves around.
(function () {
  const WEBLLM = "https://cdn.jsdelivr.net/npm/@mlc-ai/web-llm@0.2.86/+esm";
  const STORE = "localai-chat";
  const PAGE_ROOT = document.getElementById("localai-chat");
  const DESKTOP = window.matchMedia("(min-width: 992px)");

  // Current models WebLLM ships, smallest first. `mb` is the real download on Hugging Face (16-bit version;
  // the 32-bit one for older graphics is a little bigger). `qwen` turns thinking off; `tools`: Qwen models from 2B up can use the site's tools (smaller ones misuse them).
  // `top_p` is what MLC recommends for each family; temperature stays low because answers come from site text.
  const MODELS = [
    { id: "Qwen3-0.6B", name: "Qwen3 0.6B", mb: 335, group: "Tiny", top_p: 0.8, qwen: true, short: true, note: "the smallest, quick but basic" },
    { id: "Qwen3.5-0.8B", name: "Qwen3.5 0.8B", mb: 424, group: "Tiny", top_p: 0.8, qwen: true, short: true, note: "small and quick" },
    { id: "Llama-3.2-1B-Instruct", name: "Llama 3.2 1B", mb: 695, group: "Small", top_p: 0.9, short: true, note: "Meta's smallest model" },
    { id: "SmolLM2-1.7B-Instruct", name: "SmolLM2 1.7B", mb: 963, group: "Small", top_p: 0.9, note: "fully open, training data included" },
    { id: "Qwen3.5-2B", name: "Qwen3.5 2B", mb: 1059, group: "Small", top_p: 0.8, qwen: true, tools: true, note: "a good balance of speed and smarts" },
    { id: "Llama-3.2-3B-Instruct", name: "Llama 3.2 3B", mb: 1807, group: "Medium", top_p: 0.9, note: "a solid all-rounder from Meta" },
    { id: "Ministral-3-3B-Instruct-2512-BF16", name: "Ministral 3 3B", mb: 1929, group: "Medium", top_p: 0.9, note: "Mistral AI's small model" },
    { id: "Phi-4-mini-instruct", name: "Phi-4 mini", mb: 2158, group: "Medium", top_p: 0.9, note: "Microsoft's, good at reasoning and maths" },
    { id: "Qwen3.5-4B", name: "Qwen3.5 4B", mb: 2367, group: "Medium", top_p: 0.8, qwen: true, tools: true, note: "smarter, for strong machines" },
    { id: "Phi-3.5-vision-instruct", name: "Phi-3.5 vision", mb: 2769, group: "Medium", top_p: 0.9, vision: true, note: "can read images you attach" },
    { id: "gemma-4-E2B-it", name: "Gemma 4 E2B", mb: 2798, group: "Medium", top_p: 0.95, note: "Google's small model" },
    { id: "Llama-3.1-8B-Instruct", name: "Llama 3.1 8B", mb: 4517, group: "Large", top_p: 0.9, note: "big and capable, needs a powerful machine" },
    { id: "Qwen3.5-9B", name: "Qwen3.5 9B", mb: 5038, group: "Large", top_p: 0.8, qwen: true, tools: true, note: "the smartest here, needs a powerful machine" },
  ];
  // What we pick for weak, typical and strong machines
  const PICKS = ["Qwen3.5-0.8B", "Qwen3.5-2B", "Qwen3.5-4B"];
  const SUGGESTIONS = ["What's on next?", "How do I start running AI on my laptop?", "What can my machine run?", "How do I join the group chat?"];

  // Keep everything inside the model's 4096-token window
  const MAX_TOOL_CHARS = 1500;
  const MAX_CONTEXT_CHARS = 2000;

  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const longDate = (d) => d.toLocaleDateString("en-AU", { weekday: "long", day: "numeric", month: "long", year: "numeric" });

  // ---------- Saved chats and settings ----------

  // Chats, settings and your prompts stay in this browser (localStorage). Nothing is sent anywhere.
  const DEFAULTS = { temperature: 0.3, top_p: null, max_tokens: null, presence_penalty: 0, frequency_penalty: null, history: 8, thinking: false, knowledge: true, fontSize: 15, sendKey: "Enter", instructions: "" };
  const makeChat = () => ({ id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, title: "", updated: Date.now(), history: [], links: [] });
  const load = () => {
    try {
      return JSON.parse(localStorage.getItem(STORE)) || {};
    } catch {
      return {};
    }
  };
  const app = Object.assign({ chats: [], current: null, model: null, started: false, settings: {}, prompts: [] }, load());
  if (!app.chats.length) app.chats.push(makeChat());
  if (!app.chats.some((c) => c.id === app.current)) app.current = app.chats[0].id;

  const currentChat = () => app.chats.find((c) => c.id === app.current);
  const setting = (key) => app.settings[key] ?? DEFAULTS[key];
  const chatTitle = (c) => c.title || (c.history.find((m) => m.role === "user" && !m.tool) || {}).content || "New chat";

  // The rest of the code reads state.history and friends; these point at the open chat
  const state = {
    get history() { return currentChat().history; },
    set history(v) { currentChat().history = v; },
    get links() { return currentChat().links; },
    set links(v) { currentChat().links = v; },
    get model() { return app.model; },
    set model(v) { app.model = v; },
    get started() { return app.started; },
    set started(v) { app.started = v; },
    // Whether the floating panel is open only matters within this tab
    get open() {
      try {
        return sessionStorage.getItem(`${STORE}-open`) === "1";
      } catch {
        return false;
      }
    },
    set open(v) {
      try {
        sessionStorage.setItem(`${STORE}-open`, v ? "1" : "");
      } catch {}
    },
  };
  const save = () => {
    currentChat().updated = Date.now();
    try {
      localStorage.setItem(STORE, JSON.stringify(app));
    } catch {}
  };

  // ---------- Picking a model for this machine ----------

  // Same trick as the hardware calculator: Chrome and Edge name the GPU, Safari, Firefox and Brave often don't
  function gpuName() {
    try {
      const gl = document.createElement("canvas").getContext("webgl");
      const ext = gl && gl.getExtension("WEBGL_debug_renderer_info");
      return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : "";
    } catch {
      return "";
    }
  }

  let hardware;
  async function detect() {
    if (hardware) return hardware;
    if (!navigator.gpu) return (hardware = { supported: false });
    let adapter;
    try {
      adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
    } catch {}
    if (!adapter) return (hardware = { supported: false });

    const info = adapter.info || {};
    const name = gpuName() || [info.vendor, info.architecture, info.description].filter(Boolean).join(" ");
    const mobile = (navigator.userAgentData && navigator.userAgentData.mobile) || /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent);
    const memory = navigator.deviceMemory; // rounded, and capped at 8 GB, so it only helps on small machines
    const apple = name.match(/Apple (M\d)(?: (Pro|Max|Ultra))?/i);

    let tier = 1;
    let why = "your browser keeps its hardware private";
    if (mobile || (memory && memory < 4)) {
      tier = 0;
      why = "a phone or a machine with little memory";
    } else if (apple) {
      tier = apple[2] ? 2 : 1;
      why = `an Apple ${apple[1].toUpperCase()}${apple[2] ? ` ${apple[2]}` : ""}`;
    } else if (/nvidia|geforce|rtx|gtx|radeon (rx|pro)|arc\(tm\) [ab]|arc [ab]\d/i.test(name)) {
      tier = 2;
      why = "a graphics card";
    } else if (name) {
      why = "built-in graphics";
    }
    return (hardware = { supported: true, f16: adapter.features.has("shader-f16"), tier, why });
  }

  const precision = () => (hardware && hardware.f16 ? "f16" : "f32");
  const modelId = (m) => `${m.id}-q4${precision()}_1-MLC`;
  const modelById = (id) => MODELS.find((m) => m.id === id) || MODELS.find((m) => m.id === PICKS[1]);
  const sizeText = (m) => (m.mb < 1000 ? `${m.mb} MB` : `${(m.mb / 1000).toFixed(1)} GB`);

  // ---------- Searching the site (retrieval for every answer) ----------

  const MAIN_PAGES = ["/", "/events/", "/posts/", "/resources/", "/resources/calculator/", "/resources/chat/", "/community/", "/about/", "/contact/"];
  const realPages = new Set(MAIN_PAGES);
  const STOP_WORDS = new Set("a an and are as at be by can could do does for from get got have how i if in is it its me my of on or our should so that the their there this to us was we what when where which who will with would you your about any some just like want".split(" "));
  const words = (s) => String(s).toLowerCase().replace(/[^a-z0-9.+#]+/g, " ").split(" ").filter((w) => w.length > 1 && !STOP_WORDS.has(w));

  const pageTitles = new Map();
  let index;
  const indexReady = fetch("/chat-index.json")
    .then((r) => r.json())
    .then((docs) => {
      // BM25 over title and text, titles counted twice
      const df = new Map();
      for (const d of docs) {
        d.terms = new Map();
        for (const w of [...words(d.title), ...words(d.title), ...words(d.text)]) d.terms.set(w, (d.terms.get(w) || 0) + 1);
        d.len = [...d.terms.values()].reduce((a, b) => a + b, 0);
        for (const w of d.terms.keys()) df.set(w, (df.get(w) || 0) + 1);
        if (d.url) {
          realPages.add(d.url);
          if (!pageTitles.has(d.url) || d.kind === "guide") pageTitles.set(d.url, d.title);
        }
      }
      const avg = docs.reduce((a, d) => a + d.len, 0) / docs.length;
      index = { docs, df, avg };
    })
    .catch(() => {});

  const EVENT_QUESTION = /what'?s on|\b(next|upcoming|events?|meetups?|workshops?|catch ?ups?|coming up|happening)\b/i;
  const PAST_QUESTION = /\b(past|last|previous|was|were|recap)\b/i;

  function retrieve(query) {
    if (!index) return [];
    const { docs, df, avg } = index;
    const terms = words(query);
    const today = new Date().toISOString().slice(0, 10);
    const scored = docs.map((d) => {
      let score = 0;
      for (const w of terms) {
        const tf = d.terms.get(w);
        if (!tf) continue;
        const idf = Math.log(1 + (docs.length - df.get(w) + 0.5) / (df.get(w) + 0.5));
        score += idf * ((tf * 2.2) / (tf + 1.2 * (0.25 + 0.75 * (d.len / avg))));
      }
      // Questions about what's on: upcoming events first, soonest first; past events only when asked
      if (d.date) {
        const upcoming = d.date >= today;
        if (EVENT_QUESTION.test(query) && upcoming && d.kind === "event") score += 6 - Math.min(5, (Date.parse(d.date) - Date.now()) / 864e5 / 30);
        if (!upcoming && !PAST_QUESTION.test(query)) score *= 0.3;
      }
      return { d, score };
    });
    // An events question gets event pieces, plus anything else only if it matches strongly
    const eventsOnly = EVENT_QUESTION.test(query);
    const picked = [];
    let chars = 0;
    scored.sort((a, b) => b.score - a.score);
    const best = scored.length ? scored[0].score : 0;
    for (const { d, score } of scored) {
      // Skip weak matches, and anything far weaker than the best one
      if (score < best * 0.45 || score < (eventsOnly ? 0.5 : 2) || picked.length >= 4 || chars + d.text.length > MAX_CONTEXT_CHARS) continue;
      if (eventsOnly && !d.date && score < 4) continue;
      picked.push(d);
      chars += d.text.length;
    }
    return picked;
  }

  // The retrieved pieces, written so a small model can quote them and link the right page
  function contextFor(query, skipKind) {
    const today = new Date().toISOString().slice(0, 10);
    const found = retrieve(query).filter((d) => d.kind !== skipKind);
    if (!found.length) return "";
    return found.map((d) => `${d.title}${d.date ? (d.date >= today ? " (upcoming)" : " (past event)") : ""}. Page: ${d.url}\n${d.text}`).join("\n\n");
  }

  // ---------- Going straight to the site's tools ----------

  const SHORT_QUESTION = 9; // words

  // Small models are unreliable at deciding to call a tool, so clear requests call the WebMCP tool directly,
  // for every model: actions run straight away, and lookups give the model fresh facts to answer from.
  const OPEN_REQUEST = /^\W*(please\s+)?(can|could|would) you\s+|^\W*(please\s+)/i;
  const OPEN_VERB = /^(take|bring|send|get)\s+me\s+(to|back to)\b|^(go|navigate|head)\s+(to|back to)\b|^open\b|^show me the\s+.*\bpage\b/i;
  const SHOW_EVENT = /\b(show|highlight|point out|find)\b.*\b(event|workshop|meetup|catch ?up)\b/i;
  const SEARCH_REQUEST = /^(search|look up|look for|find)\b(\s+(the|this)\s+(site|website))?(\s+for)?\s*/i;
  const NEXT_EVENT = /what'?s on|\b(next|upcoming|coming up|happening|any (events?|meetups?|workshops?))\b/i;
  const CHAT_QUESTION = /\b(group chats?|join|discord|telegram|signal|whatsapp|matrix)\b/i;
  const POST_QUESTION = /\b(posts?|news|recaps?|blog)\b/i;
  const TOOLS_QUESTION = /\bweb ?mcp\b|\b(what|which|any|have|your|got)\b.*\btools\b|\btools\b.*\byou\b|what can you do/i;

  const PLACES = [
    [/\bevents?\b|workshops?|meetups?/i, "/events/", "Events"],
    [/\bposts?\b|news|blog/i, "/posts/", "Posts"],
    [/calculator|what can i run/i, "/resources/calculator/", "the Hardware Calculator"],
    [/\bmodels?\b/i, "/resources/models/", "Models"],
    [/where to start|getting started|start/i, "/resources/getting-started/", "Where to Start"],
    [/resources?|guides?/i, "/resources/", "Resources"],
    [/community|group chat|newsletter|discord|telegram/i, "/community/", "Community"],
    [/about/i, "/about/", "About"],
    [/contact/i, "/contact/", "Contact"],
    [/home/i, "/", "the home page"],
  ];

  // An action to run instead of asking the model, or null
  function actionFor(question) {
    const q = question.trim().replace(OPEN_REQUEST, "");
    if (SHOW_EVENT.test(q) && tools().some((t) => t.name === "show-event")) return { name: "show-event", args: {} };
    if (SEARCH_REQUEST.test(q)) {
      const query = q.replace(SEARCH_REQUEST, "").replace(/[?.!]+$/, "").trim();
      if (query) return { name: "search-site", args: { query } };
    }
    if (!OPEN_VERB.test(q)) return null;
    const place = PLACES.find(([match]) => match.test(q));
    if (place) return { name: "go-to-page", args: { path: place[1] }, say: `Opening ${place[2]}.` };
    const found = retrieve(q)[0];
    return found ? { name: "go-to-page", args: { path: found.url }, say: `Opening ${found.title}.` } : null;
  }

  // Tools worth calling for this question, each with a way to turn its reply into plain facts
  function lookupsFor(question) {
    const list = [];
    if (NEXT_EVENT.test(question) || (EVENT_QUESTION.test(question) && !PAST_QUESTION.test(question))) {
      list.push({
        name: "list-events",
        args: { when: "upcoming" },
        facts: (r) => (r.events.length ? r.events.map((e) => `${e.title}: ${e.date}, ${e.startTime} to ${e.endTime}, ${e.location}. Page: ${e.url}`).join("\n") : "No upcoming events are announced yet. New ones go on the Events page, /events/."),
        heading: "Upcoming events",
        skip: "event",
        answer: (r) => (r.events.length ? `${r.events.length > 1 ? "Coming up:" : "Next up:"}\n${r.events.map((e) => `- **[${e.title.replace(/ \/ localAI.*$/, "")}](${e.url})**: ${e.date}, ${e.startTime} to ${e.endTime}, ${e.location}`).join("\n")}` : "Nothing's announced right now. New events go on the [Events](/events/) page."),
      });
    }
    if (CHAT_QUESTION.test(question)) {
      list.push({ name: "get-community-links", args: {}, facts: (r) => r.platforms.map((p) => `${p.name}: ${p.joinUrl}`).join("\n"), heading: "Group chats (bridged, so joining any one reaches everyone)", skip: "community", answer: (r) => `Join on whichever you already use. The chats are bridged, so one reaches everyone:\n${r.platforms.map((p) => `- [${p.name}](${p.joinUrl})`).join("\n")}` });
    }
    if (POST_QUESTION.test(question)) {
      list.push({ name: "list-posts", args: { limit: 5 }, facts: (r) => r.posts.map((p) => `${p.title} (${p.date}). Page: ${p.url}`).join("\n"), heading: "Latest posts", skip: "post", answer: (r) => `Latest from the site:\n${r.posts.map((p) => `- [${p.title}](${p.url}), ${p.date}`).join("\n")}` });
    }
    return list;
  }

  // Search results as links
  function searchAnswer(query, raw) {
    // The chat's own index is always current, so its matches come first, then the site search's
    const hits = retrieve(query).map((d) => ({ title: d.title, url: d.url }));
    try {
      hits.push(...JSON.parse(raw).filter((r) => isReal(r.url)).map((r) => ({ title: r.title, url: r.url })));
    } catch {}
    const unique = [...new Map(hits.reverse().map((h) => [h.url, h])).values()].reverse().slice(0, 5);
    return unique.length ? `Here's what I found:\n${unique.map((h) => `- [${h.title}](${h.url})`).join("\n")}` : `I couldn't find anything on the site for "${query}".`;
  }

  // What the chat can do, from the live tool list, so it can answer honestly about WebMCP and its tools
  function toolFacts() {
    const list = tools().map((t) => `${t.name}: ${t.description}`).join("\n");
    return `What you can do. This website supports WebMCP, and you can use its tools:\n${list}`;
  }

  // ---------- The engine ----------

  let webllm;
  let engine;
  let loadedId;
  let busy = false;

  // In a service worker the model survives page changes; a web worker is the fallback (and reloads per page)
  async function createEngine(id, onProgress) {
    if ("serviceWorker" in navigator) {
      try {
        await navigator.serviceWorker.register("/webllm-sw.js", { type: "module" });
        if (!navigator.serviceWorker.controller) {
          await new Promise((done) => {
            navigator.serviceWorker.addEventListener("controllerchange", done, { once: true });
            setTimeout(done, 4000);
          });
        }
        if (navigator.serviceWorker.controller) return await webllm.CreateServiceWorkerMLCEngine(id, { initProgressCallback: onProgress });
      } catch (err) {
        console.warn("localAI chat: running the model in a web worker instead of a service worker.", err);
      }
    }
    return webllm.CreateWebWorkerMLCEngine(new Worker("/assets/js/webllm-worker.js", { type: "module" }), id, { initProgressCallback: onProgress });
  }

  async function startEngine(model, onProgress) {
    webllm ||= await import(WEBLLM);
    const id = modelId(model);
    // Ask the browser not to clear the download when space runs low (it may say no)
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
    if (engine && loadedId === id) return;
    if (engine) {
      engine.setInitProgressCallback(onProgress);
      await engine.reload(id);
    } else {
      engine = await createEngine(id, onProgress);
    }
    loadedId = id;
  }

  async function isCached(model) {
    try {
      webllm ||= await import(WEBLLM);
      return await webllm.hasModelInCache(modelId(model));
    } catch {
      return false;
    }
  }

  // Models saved in this browser, read straight from Cache Storage so it doesn't need the WebLLM library
  async function savedModels() {
    try {
      if (!(await caches.has("webllm/model"))) return [];
      const urls = (await (await caches.open("webllm/model")).keys()).map((r) => r.url);
      // Counts the model data itself: a deleted model can leave a small index file behind
      return MODELS.filter((m) => urls.some((u) => u.includes(`/${modelId(m)}/`) && u.includes("params_shard")));
    } catch {
      return [];
    }
  }

  // Removes a model's files. If it's the one running, it has to be unloaded first.
  async function deleteModel(model) {
    webllm ||= await import(WEBLLM);
    const running = loadedId === modelId(model);
    if (running) {
      await engine.unload();
      engine = null;
      loadedId = null;
    }
    await webllm.deleteModelAllInfoInCache(modelId(model));
    // WebLLM leaves its small index file behind, so tidy that up too
    const cache = await caches.open("webllm/model");
    for (const request of await cache.keys()) {
      if (request.url.includes(`/${modelId(model)}/`)) await cache.delete(request);
    }
    return running;
  }

  // ---------- What the model sees ----------

  // The main pages are already in the prompt, so the overview tool would only cost a slow extra round
  const tools = () => (window.localaiTools || []).filter((t) => t.name !== "get-site-info");

  // Short on purpose: small models follow a few clear lines better than a long rulebook
  function systemPrompt(model) {
    const extra = setting("instructions").trim();
    return [corePrompt(model), extra].filter(Boolean).join("\n\n");
  }

  function corePrompt(model) {
    // With site knowledge off it's a plain general assistant
    if (!setting("knowledge")) return `You are a helpful AI model running in the visitor's web browser. Today is ${longDate(new Date())}.`;
    // Tiny models copy whatever is in their instructions, so they get a bare minimum with nothing quotable
    if (model.short) return "You are the localAI assistant, a small AI model running in the visitor's web browser. Keep answers short and friendly. If the question comes with website extracts, answer from them.";
    const base = `You are the localAI assistant, a small AI model running inside the visitor's web browser on the localAI website. localAI is a community in Australia for people who want to run AI on their own computer: offline, private and free. Today is ${longDate(new Date())}.

Keep answers short and friendly. When a question comes with website extracts, answer it from them, and link pages with their title and Page address, like [Page title](/page-address/). Answer anything else normally. If you don't know something, say so plainly. Write the community's name as "localAI".`;
    if (!model.tools) return base;

    const list = tools()
      .map((t) => JSON.stringify({ type: "function", function: { name: t.name, description: t.description, parameters: t.inputSchema } }))
      .join("\n");
    return `${base}

This website supports WebMCP, and the tools below are its WebMCP tools. Use them when the extracts aren't enough or to find something on the site.

# Tools

You may call one or more functions to assist with the user query.

You are provided with function signatures within <tools></tools> XML tags:
<tools>
${list}
</tools>

For each function call, return a json object with function name and arguments within <tool_call></tool_call> XML tags:
<tool_call>
{"name": <function-name>, "arguments": <args-json-object>}
</tool_call>`;
  }

  // Recent turns, with the site extracts placed right before the latest question (small models attend to them best there)
  function messages(model, context) {
    // Tiny models copy their own earlier answers, so they only see the latest question
    const keep = setting("history");
    const fromQuestion = state.history.map((m) => m.role === "user" && !m.tool).lastIndexOf(true);
    const recent = model.short && keep === DEFAULTS.history ? state.history.slice(fromQuestion) : state.history.slice(-keep);
    const turns = recent.map(({ role, content }) => ({ role, content }));
    for (let i = turns.length - 1; i >= 0; i--) {
      if (turns[i].role === "user" && !recent[i].tool) {
        const text = context ? `Website extracts:\n\n${context}\n\nQuestion: ${turns[i].content}` : turns[i].content;
        turns[i].content = model.vision && recent[i].image ? [{ type: "text", text }, { type: "image_url", image_url: { url: recent[i].image } }] : text;
        break;
      }
    }
    return [{ role: "system", content: systemPrompt(model) }, ...turns];
  }

  function toolCalls(text) {
    const calls = [];
    for (const match of text.matchAll(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g)) {
      try {
        const call = JSON.parse(match[1]);
        if (call && call.name) calls.push({ name: call.name, args: call.arguments || {} });
      } catch {}
    }
    return calls;
  }

  // Hide tool calls and any thinking from the visitor, including a tool call still being written
  const visible = (text) =>
    text
      .replace(/<think>[\s\S]*?(<\/think>|$)/g, "")
      .replace(/<tool_call>[\s\S]*?(<\/tool_call>|$)/g, "")
      .replace(/<\/?tool_call?[^>]*$/, "")
      .trim();

  // Small models sometimes get stuck saying the same thing; spot a line said three times and cut it there
  function repeating(text) {
    // A phrase looping right at the end, like "101-103, 101-103, 101-103"
    const tail = text.slice(-240).match(/(\S.{2,40}?)(\s*,?\s*\1){3,}$/s);
    if (tail) return tail[1].toLowerCase();
    const seen = new Map();
    const lines = text.split(/\n+|(?<=[.!?])\s+/).map((l) => l.replace(/^[\s\d.#*-]+/, "").trim().toLowerCase()).filter((l) => l.length > 12);
    for (const l of lines) {
      seen.set(l, (seen.get(l) || 0) + 1);
      if (seen.get(l) >= 3) return l;
    }
    return null;
  }
  function trimRepeat(text, line) {
    const lower = text.toLowerCase();
    const second = lower.indexOf(line, lower.indexOf(line) + line.length);
    return second > 0 ? text.slice(0, second).replace(/[\s\d.#*-]+$/, "").trim() : text;
  }

  async function runTool(call) {
    const tool = tools().find((t) => t.name === call.name);
    if (!tool) return `There is no tool called "${call.name}".`;
    try {
      const result = await tool.execute(call.args);
      const text = (result.content || []).map((c) => c.text).join("\n");
      return text.length > MAX_TOOL_CHARS ? `${text.slice(0, MAX_TOOL_CHARS)}... (cut short)` : text;
    } catch (err) {
      return `The tool failed: ${err.message}`;
    }
  }

  let stopped = false;

  async function reply(ui) {
    const model = modelById(state.model);
    const question = [...state.history].reverse().find((m) => m.role === "user" && !m.tool);
    await indexReady;
    busy = true;
    stopped = false;
    ui.setBusy(true);
    try {
      const asked = question ? question.content : "";
      const knowledge = setting("knowledge");
      // A clear request: do it straight away, no model needed
      const action = knowledge ? actionFor(asked) : null;
      if (action) {
        const result = await runTool(action);
        let text = action.say || "";
        if (action.name === "search-site") text = searchAnswer(action.args.query, result);
        if (action.name === "show-event") {
          const { events } = await window.localaiTools.find((t) => t.name === "list-events").execute({ when: "upcoming" }).then((r) => JSON.parse(r.content[0].text));
          const shown = (JSON.parse(result).shown && events.find((e) => e.slug === JSON.parse(result).shown)) || events[0];
          text = shown ? `Here it is: **${shown.title}**, ${shown.date}, ${shown.startTime} to ${shown.endTime}. [More details](${shown.url})` : "There's nothing upcoming on this page yet.";
        }
        state.history.push({ role: "assistant", content: text, tools: [action.name] });
        ui.fillAssistant(ui.addAssistant(), text, [action.name], true);
        save();
        if (action.name === "go-to-page") {
          state.open = true;
          save();
        }
        return;
      }

      // Otherwise gather facts: live ones from the site's tools, then matching pieces of the site
      const lookups = knowledge ? lookupsFor(asked) : [];
      const used = [];
      const live = [];
      const direct = [];
      for (const l of lookups) {
        const raw = await runTool({ name: l.name, args: l.args });
        try {
          const data = JSON.parse(raw);
          live.push(`${l.heading}:\n${l.facts(data)}`);
          direct.push(l.answer(data));
          used.push(l.name);
        } catch {}
      }

      // A short, clear question: the tool's reply is the answer, exact and instant, so skip the model
      if (direct.length === 1 && asked.trim().split(/\s+/).length <= SHORT_QUESTION) {
        noteLinks(direct[0]);
        state.history.push({ role: "assistant", content: direct[0], tools: used });
        ui.fillAssistant(ui.addAssistant(), direct[0], used, true);
        save();
        return;
      }
      if (knowledge && TOOLS_QUESTION.test(asked)) live.push(toolFacts());
      const context = knowledge ? [...live, contextFor(asked, lookups.length === 1 ? lookups[0].skip : undefined)].filter(Boolean).join("\n\n") : "";
      noteLinks(context);

      // A few rounds: the model may call tools, read the results, then answer. The last round has to answer.
      const rounds = model.tools && knowledge ? 4 : 1;
      for (let round = 0; round < rounds; round++) {
        if (rounds > 1 && round === rounds - 1) state.history.push({ role: "user", content: "Answer now in plain words with what you have. Don't call any more tools.", tool: true });
        let text = "";
        const bubble = ui.addAssistant();
        const stream = await engine.chat.completions.create({
          messages: messages(model, context),
          stream: true,
          stream_options: { include_usage: true },
          temperature: setting("temperature"),
          top_p: setting("top_p") ?? model.top_p,
          // Thinking uses up tokens before the answer starts, so it gets a bigger budget
          max_tokens: setting("max_tokens") ?? (model.qwen && setting("thinking") ? 1500 : model.short ? 300 : 600),
          presence_penalty: setting("presence_penalty"),
          frequency_penalty: setting("frequency_penalty") ?? (model.tools ? 0 : 0.3),
          // Qwen's thinking is off for quick replies unless asked for; other models would get a stray empty <think> block
          ...(model.qwen ? { extra_body: { enable_thinking: setting("thinking") } } : {}),
        });
        let usage;
        for await (const chunk of stream) {
          if (chunk.usage) usage = chunk.usage;
          text += (chunk.choices[0] && chunk.choices[0].delta.content) || "";
          const loop = repeating(visible(text));
          if (loop) {
            engine.interruptGenerate();
            text = trimRepeat(text, loop);
            break;
          }
          ui.fillAssistant(bubble, visible(text));
        }
        if (stopped) text = text.trim() ? `${text.trim()}\n\n(Stopped.)` : "(Stopped.)";
        const calls = stopped ? [] : toolCalls(text);
        const tags = [...used.splice(0), ...calls.map((c) => c.name)];
        state.history.push({ role: "assistant", content: text, tools: tags, stats: usage && { tokens: usage.completion_tokens, speed: usage.extra && Math.round(usage.extra.decode_tokens_per_s) } });
        ui.fillAssistant(bubble, visible(text), tags, true);
        save();
        if (!calls.length || stopped || round === rounds - 1) break;

        for (const call of calls) {
          const result = await runTool(call);
          noteLinks(result);
          state.history.push({ role: "user", content: `<tool_response>\n${result}\n</tool_response>`, tool: true });
        }
        save();
        // go-to-page reloads the page; the conversation carries on there
        const opened = calls.find((c) => c.name === "go-to-page");
        if (opened) {
          state.history.push({ role: "assistant", content: `Opening ${pageTitles.get(opened.args.path) || "that page"}.`, tools: [] });
          state.open = true;
          save();
          return;
        }
      }
    } catch (err) {
      ui.addError(`Something went wrong: ${err.message}`);
    } finally {
      busy = false;
      ui.setBusy(false);
    }
  }

  function stop() {
    if (!busy || !engine) return;
    stopped = true;
    engine.interruptGenerate();
  }

  // ---------- Formatting answers ----------

  // Outside links only count if the address came from the site (extracts or tool results), not from the model
  const fromSite = new Set(state.links || []);
  const noteLinks = (text) => {
    (String(text).match(/https:\/\/[^\s"'<>)\];,]+/g) || []).forEach((u) => fromSite.add(u.replace(/[.,!?]$/, "")));
    state.links = [...fromSite];
  };
  const isReal = (href) => (href.startsWith("https://") ? fromSite.has(href) : realPages.has(href.replace(/[#?].*$/, "").replace(/([^/])$/, "$1/")));

  // Bigger libraries load only when needed, then finished messages are drawn again
  const CDN = "https://cdn.jsdelivr.net/npm/";
  const LIBS = {
    marked: `${CDN}marked@12.0.2/marked.min.js`,
    purify: `${CDN}dompurify@3.1.6/dist/purify.min.js`,
    hljs: `${CDN}@highlightjs/cdn-assets@11.9.0/highlight.min.js`,
    katex: `${CDN}katex@0.16.11/dist/katex.min.js`,
    katexCss: `${CDN}katex@0.16.11/dist/katex.min.css`,
    mermaid: `${CDN}mermaid@10.9.1/dist/mermaid.min.js`,
    png: `${CDN}html-to-image@1.11.11/dist/html-to-image.js`,
  };
  const loaded = new Map();
  const redraws = new Set();
  function loadLib(src) {
    if (!loaded.has(src)) {
      loaded.set(
        src,
        new Promise((done, failed) => {
          const el = document.createElement(src.endsWith(".css") ? "link" : "script");
          if (el.tagName === "LINK") {
            el.rel = "stylesheet";
            el.href = src;
          } else el.src = src;
          el.onload = done;
          el.onerror = failed;
          document.head.append(el);
        }),
      );
      loaded.get(src).then(() => redraws.forEach((r) => r())).catch(() => {});
    }
    return loaded.get(src);
  }

  // Simple formatting, used until the Markdown library has loaded
  function plainFormat(text) {
    return esc(text.replace(/\n{2,}(?=\s*([-*]|\d+\.) )/g, "\n"))
      .replace(/^#{1,6}\s*(.+)$/gm, "<strong>$1</strong>")
      .replace(/\[([^\]]+)\]\(((?:\/|https:\/\/)[^)\s]*)\)/g, (_, label, href) => (isReal(href) ? `<a href="${href}"${href.startsWith("/") ? "" : ' target="_blank" rel="noopener"'}>${label}</a>` : label))
      .replace(/(^|[\s(])(https:\/\/[^\s<);,]+[^\s<).,;!?])/g, (all, pre, url) => (isReal(url.replace(/&amp;/g, "&")) ? `${pre}<a href="${url}" target="_blank" rel="noopener">${url}</a>` : all))
      .replace(/(^|[\s:]|(?<!\])\()(\/[a-z0-9][a-z0-9/-]*\/)(?=[\s).,;]|$)/gm, (all, pre, path) => (realPages.has(path) ? `${pre}<a href="${path}">${esc(pageTitles.get(path) || path)}</a>` : all))
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/^\s*[-*] (.+)$/gm, '<span class="lchat__li">$1</span>')
      // A list item is already its own line, so the line break after it would leave a gap
      .replace(/(class="lchat__li">.*<\/span>)\n/g, "$1")
      .replace(/\n{2,}/g, "<br><br>")
      .replace(/\n/g, "<br>");
  }

  // ---------- The chat UI, used by the page and the floating chat ----------

  // What each site tool did, in plain words

  // Full Markdown: tables, code with highlighting and a copy button, maths and Mermaid diagrams
  function format(text, final = true) {
    if (!window.marked || !window.DOMPurify) {
      loadLib(LIBS.marked);
      loadLib(LIBS.purify);
      return plainFormat(text);
    }
    // Keep maths away from the Markdown parser
    const maths = [];
    let src = text.replace(/\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]|\\\(([\s\S]+?)\\\)|(?<![\w$])\$([^\s$](?:[^$\n]*[^\s$])?)\$(?![\w$])/g, (raw, a, b, c, d) => {
      maths.push({ raw, tex: a || b || c || d, block: !!(a || b) });
      return `@@MATH${maths.length - 1}@@`;
    });
    // Bare site addresses become links with the page's title
    src = src.replace(/(^|[\s:]|(?<!\])\()(\/[a-z0-9][a-z0-9/-]*\/)(?=[\s).,;]|$)/gm, (all, pre, path) => (realPages.has(path) ? `${pre}[${pageTitles.get(path) || path}](${path})` : all));

    const box = document.createElement("div");
    box.innerHTML = window.DOMPurify.sanitize(window.marked.parse(src, { breaks: true, gfm: true }));

    box.querySelectorAll("a").forEach((a) => {
      const href = a.getAttribute("href") || "";
      // With site knowledge on, links the model made up show as plain text
      if (setting("knowledge") && !isReal(href)) a.replaceWith(a.textContent);
      else if (/^https?:/.test(href)) {
        a.target = "_blank";
        a.rel = "noopener";
      }
    });
    box.querySelectorAll("code").forEach((code) => (code.textContent = code.textContent.replace(/@@MATH(\d+)@@/g, (_, n) => maths[n].raw)));
    box.querySelectorAll("pre").forEach((pre) => {
      const code = pre.querySelector("code");
      const lang = code && (code.className.match(/language-([\w-]+)/) || [])[1];
      if (lang === "mermaid" && final) {
        const chart = document.createElement("div");
        chart.className = "lchat__mermaid";
        chart.textContent = code.textContent;
        pre.replaceWith(chart);
        loadLib(LIBS.mermaid);
        return;
      }
      if (code && final) {
        if (window.hljs) {
          code.innerHTML = lang && window.hljs.getLanguage(lang) ? window.hljs.highlight(code.textContent, { language: lang }).value : window.hljs.highlightAuto(code.textContent).value;
          code.classList.add("hljs");
        } else loadLib(LIBS.hljs);
      }
      const copy = document.createElement("button");
      copy.type = "button";
      copy.className = "lchat__code-copy";
      copy.title = "Copy code";
      copy.setAttribute("aria-label", "Copy code");
      copy.innerHTML = `<i class="bi bi-copy" aria-hidden="true"></i>`;
      pre.append(copy);
    });

    let html = box.innerHTML;
    if (maths.length) {
      if (window.katex) {
        html = html.replace(/@@MATH(\d+)@@/g, (_, n) => window.katex.renderToString(maths[n].tex, { displayMode: maths[n].block, throwOnError: false }));
      } else {
        loadLib(LIBS.katex);
        loadLib(LIBS.katexCss);
        html = html.replace(/@@MATH(\d+)@@/g, (_, n) => esc(maths[n].raw));
      }
    }
    return html;
  }

  function drawDiagrams(root) {
    const nodes = [...root.querySelectorAll(".lchat__mermaid:not([data-processed])")];
    if (!nodes.length || !window.mermaid) return;
    const dark = document.documentElement.getAttribute("data-bs-theme") === "dark";
    window.mermaid.initialize({ startOnLoad: false, theme: dark ? "dark" : "neutral", securityLevel: "strict" });
    window.mermaid.run({ nodes }).catch(() => {});
  }

  // The model's thinking, when thinking is switched on
  const thoughts = (text) => (text.match(/<think>([\s\S]*?)(<\/think>|$)/) || [])[1]?.trim() || "";

  // ---------- Exporting ----------

  function chatMarkdown(chat = currentChat()) {
    const lines = [`# ${chatTitle(chat)}`, ""];
    for (const m of chat.history) {
      if (m.tool) continue;
      const text = m.role === "user" ? m.content : visible(m.content);
      if (text) lines.push(`**${m.role === "user" ? "You" : "localAI Chat"}**`, "", text, "");
    }
    return lines.join("\n").trim();
  }

  function download(name, text, type) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([text], { type }));
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  const fileName = (ext) => `${chatTitle(currentChat()).toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40).replace(/^-|-$/g, "") || "localai-chat"}.${ext}`;

  async function saveImage(log) {
    await loadLib(LIBS.png);
    const bg = getComputedStyle(document.body).backgroundColor;
    const url = await window.htmlToImage.toPng(log, { backgroundColor: bg, height: log.scrollHeight, skipFonts: true, style: { height: `${log.scrollHeight}px`, overflow: "visible" } });
    const a = document.createElement("a");
    a.href = url;
    a.download = fileName("png");
    a.click();
  }

  const BUILT_IN_PROMPTS = [
    ["Explain simply", "Explain this in simple terms, as if I'm new to it: "],
    ["Summarise", "Summarise this in three short bullet points:\n\n"],
    ["Fix my writing", "Fix the spelling and grammar in this, and keep my tone:\n\n"],
    ["Make it shorter", "Rewrite this so it's about half as long:\n\n"],
    ["Translate", "Translate this into English:\n\n"],
    ["Explain this code", "Explain what this code does, step by step:\n\n"],
    ["Write an email", "Write a short, friendly email about: "],
    ["Brainstorm", "Give me ten ideas for: "],
  ];
  const COMMANDS = [
    ["new", "Start a new chat"],
    ["clear", "Clear this chat"],
    ["del", "Delete this chat"],
    ["next", "Next chat"],
    ["prev", "Previous chat"],
  ];

  const TOOL_LABELS = {
    "search-site": ["bi-search", "Searched the site"],
    "go-to-page": ["bi-box-arrow-in-right", "Opened a page"],
    "show-event": ["bi-calendar-event", "Showed an event"],
    "list-events": ["bi-calendar3", "Checked the events"],
    "get-event": ["bi-calendar-event", "Looked up an event"],
    "get-calendar-link": ["bi-calendar-plus", "Got a calendar link"],
    "open-calendar-menu": ["bi-calendar-plus", "Opened the calendar menu"],
    "list-posts": ["bi-journal-text", "Checked the posts"],
    "list-resources": ["bi-book", "Checked the resources"],
    "get-community-links": ["bi-people", "Got the community links"],
  };
  const toolTag = (name) => {
    const [icon, label] = TOOL_LABELS[name] || ["bi-tools", `Used ${name}`];
    return `<span class="lchat__tool" title="Site tool: ${esc(name)}"><i class="bi ${icon}" aria-hidden="true"></i>${esc(label)}</span>`;
  };

  const cap = (s) => s.replace(/^./, (c) => c.toUpperCase());

  let mounts = 0;
  function mount(root, { compact = false, title = "", actions = "" } = {}) {
    root.classList.add("lchat");
    if (compact) root.classList.add("lchat--compact");
    const id = `lchat${++mounts}`;
    root.innerHTML = `
      ${
        compact
          ? ""
          : `<aside class="lchat__side" data-side aria-label="Your chats">
        <button type="button" class="lchat__new" data-new><i class="bi bi-plus-lg" aria-hidden="true"></i>New chat</button>
        <input type="search" class="lchat__search" data-search placeholder="Search chats" aria-label="Search chats">
        <ul class="lchat__chats" data-chats></ul>
      </aside>`
      }
      <div class="lchat__main">
      <div class="lchat__bar">
        ${title ? `<strong class="lchat__title">${title}</strong>` : ""}
        ${compact ? "" : `<button type="button" class="lchat__icon-btn lchat__side-toggle lchat__ready-only" data-side-toggle title="Your chats" aria-label="Show your chats"><i class="bi bi-layout-sidebar" aria-hidden="true"></i></button>`}
        <button type="button" class="lchat__pill" data-pill aria-expanded="false" aria-controls="${id}-models" hidden><i class="bi bi-cpu" aria-hidden="true"></i><span data-pill-name></span><span class="visually-hidden">, change model</span><i class="bi bi-chevron-down" aria-hidden="true"></i></button>
        <span class="lchat__spacer"></span>
        ${compact ? `<button type="button" class="lchat__icon-btn lchat__ready-only" data-new title="New chat" aria-label="New chat"><i class="bi bi-plus-lg" aria-hidden="true"></i></button>` : ""}
        <div class="lchat__pop-wrap lchat__ready-only">
          <button type="button" class="lchat__icon-btn" data-export-btn aria-expanded="false" aria-controls="${id}-export" title="Copy or export this chat" aria-label="Copy or export this chat"><i class="bi bi-box-arrow-up" aria-hidden="true"></i></button>
          <div class="lchat__pop" id="${id}-export" data-export hidden>
            <button type="button" data-out="copy"><i class="bi bi-copy" aria-hidden="true"></i>Copy the whole chat</button>
            <button type="button" data-out="md"><i class="bi bi-markdown" aria-hidden="true"></i>Download as Markdown</button>
            <button type="button" data-out="json"><i class="bi bi-filetype-json" aria-hidden="true"></i>Download as JSON</button>
            <button type="button" data-out="png"><i class="bi bi-image" aria-hidden="true"></i>Save as an image</button>
          </div>
        </div>
        <button type="button" class="lchat__icon-btn lchat__ready-only" data-settings-btn aria-expanded="false" aria-controls="${id}-settings" title="Settings" aria-label="Settings"><i class="bi bi-gear" aria-hidden="true"></i></button>
        <button type="button" class="lchat__icon-btn" data-clear title="Clear this chat" aria-label="Clear this chat" hidden><i class="bi bi-arrow-counterclockwise" aria-hidden="true"></i></button>
        ${actions}
      </div>
      <div class="lchat__body">
        <div class="lchat__intro" data-intro><p class="lchat__muted">Checking what your machine can run...</p></div>
        <div class="lchat__log" data-log aria-live="polite" hidden></div>
        <button type="button" class="lchat__tobottom" data-bottom hidden aria-label="Go to the latest message"><i class="bi bi-arrow-down" aria-hidden="true"></i></button>
        <div class="lchat__models" id="${id}-models" data-models role="group" aria-labelledby="${id}-mt" hidden></div>
        <div class="lchat__models lchat__settings" id="${id}-settings" data-settings role="group" aria-label="Settings" hidden></div>
      </div>
      <div class="lchat__loading" data-loading hidden>
        <div class="lchat__loading-row"><span data-load-label>Getting ready...</span><span class="lchat__loading-amount" data-load-amount></span></div>
        <div class="lchat__progress" role="progressbar" aria-label="Loading the model" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><span></span></div>
        <p class="lchat__loading-note" data-load-note></p>
      </div>
      <div class="lchat__menu" data-menu role="listbox" aria-label="Prompts and commands" hidden></div>
      <div class="lchat__attached" data-attached hidden></div>
      <form class="lchat__form" data-form hidden>
        <input type="file" accept="image/*" data-file hidden>
        <button type="button" class="lchat__attach" data-attach title="Attach an image" aria-label="Attach an image" hidden><i class="bi bi-image" aria-hidden="true"></i></button>
        <label class="visually-hidden" for="${id}-input">Message</label>
        <textarea id="${id}-input" rows="1" placeholder="Ask about localAI, or type / for prompts" enterkeyhint="send"></textarea>
        <button type="submit" class="lchat__send" aria-label="Send"><i class="bi bi-arrow-up" aria-hidden="true"></i></button>
      </form>
      <p class="lchat__fine" data-fine hidden>Small models make mistakes, so check anything important.</p>
      <p class="lchat__toast" data-toast role="status" hidden></p>
      <p class="visually-hidden" role="status" data-status></p>
      </div>`;

    const $ = (sel) => root.querySelector(sel);
    const intro = $("[data-intro]");
    const log = $("[data-log]");
    const models = $("[data-models]");
    const settingsEl = $("[data-settings]");
    const exportEl = $("[data-export]");
    const menu = $("[data-menu]");
    const toastEl = $("[data-toast]");
    const toBottom = $("[data-bottom]");
    const loadingEl = $("[data-loading]");
    const form = $("[data-form]");
    const input = $("textarea");
    const send = $(".lchat__send");
    const pill = $("[data-pill]");
    const clearBtn = $("[data-clear]");
    const announce = (text) => ($("[data-status]").textContent = text);

    let hw;
    let picked;
    let chosen;
    let loading = false;
    let opener;
    let attached = null;
    let toastTimer;
    let menuItems = [];
    let menuAt = 0;

    function toast(text, undo) {
      clearTimeout(toastTimer);
      toastEl.innerHTML = `${esc(text)}${undo ? ` <button type="button" class="lchat__link" data-undo>Undo</button>` : ""}`;
      toastEl.hidden = false;
      if (undo) toastEl.querySelector("[data-undo]").onclick = () => {
        undo();
        toastEl.hidden = true;
      };
      toastTimer = setTimeout(() => (toastEl.hidden = true), undo ? 7000 : 2500);
    }

    const typing = `<span class="lchat__typing" aria-label="Thinking"><span></span><span></span><span></span></span>`;
    const ui = {
      addAssistant() {
        const el = document.createElement("div");
        el.className = "lchat__msg lchat__msg--ai";
        el.setAttribute("aria-busy", "true");
        el.innerHTML = typing;
        log.appendChild(el);
        scroll();
        return el;
      },
      // `done` once the answer is complete: then it gets a copy button and screen readers read it
      fillAssistant(el, text, used = [], done = false) {
        const tags = used.map(toolTag).join("");
        el.innerHTML =
          (tags ? `<div class="lchat__tools">${tags}</div>` : "") +
          (text ? `<div class="lchat__text">${format(text, done)}</div>` : tags ? "" : typing);
        el.dataset.text = text;
        el.setAttribute("aria-busy", String(!done));
        el.classList.toggle("lchat__msg--toolonly", !text && used.length > 0);
        scroll();
      },
      addError(text) {
        const el = document.createElement("p");
        el.className = "lchat__error";
        el.textContent = text;
        log.appendChild(el);
        scroll(true);
      },
      // While answering, the send button becomes a stop button
      setBusy(on) {
        input.disabled = on;
        clearBtn.disabled = on;
        pill.disabled = on;
        root.classList.toggle("is-busy", on);
        send.innerHTML = on ? `<i class="bi bi-stop-fill" aria-hidden="true"></i>` : `<i class="bi bi-arrow-up" aria-hidden="true"></i>`;
        send.setAttribute("aria-label", on ? "Stop" : "Send");
        send.type = on ? "button" : "submit";
        if (!on) {
          redraw();
          input.focus();
        }
      },
    };

    // Follow new text, unless the visitor has scrolled up to read
    function scroll(force) {
      if (force || log.scrollHeight - log.scrollTop - log.clientHeight < 120) log.scrollTop = log.scrollHeight;
      showBottom();
    }
    function showBottom() {
      toBottom.hidden = log.hidden || log.scrollHeight - log.scrollTop - log.clientHeight < 160;
    }

    const actionBtn = (act, icon, label) => `<button type="button" data-act="${act}" title="${label}" aria-label="${label}"><i class="bi ${icon}" aria-hidden="true"></i></button>`;

    // Draw the open chat: messages, the tools each answer used, and what you can do with each message
    function redraw() {
      log.innerHTML = "";
      state.history.forEach((m, i) => {
        if (m.tool) return;
        if (m.role === "user") {
          const el = document.createElement("div");
          el.className = "lchat__msg lchat__msg--you";
          el.dataset.i = i;
          el.innerHTML = `${m.image ? `<img class="lchat__msg-img" src="${esc(m.image)}" alt="Attached image">` : ""}<div class="lchat__you-text"></div><div class="lchat__acts">${actionBtn("copy", "bi-copy", "Copy")}${actionBtn("edit", "bi-pencil", "Edit and send again")}${actionBtn("delete", "bi-trash3", "Delete")}</div>`;
          el.querySelector(".lchat__you-text").textContent = m.content;
          log.appendChild(el);
          return;
        }
        const text = visible(m.content);
        const thought = thoughts(m.content);
        if (!text && !thought && !(m.tools || []).length) return;
        const el = ui.addAssistant();
        ui.fillAssistant(el, text, m.tools || [], true);
        el.dataset.i = i;
        if (thought) el.insertAdjacentHTML("afterbegin", `<details class="lchat__think"><summary>Thinking</summary><p></p></details>`), (el.querySelector(".lchat__think p").textContent = thought);
        if (text || thought) {
          const stats = m.stats && m.stats.tokens ? `<span class="lchat__stats">${m.stats.tokens} tokens${m.stats.speed ? `, ${m.stats.speed} tok/s` : ""}</span>` : "";
          el.insertAdjacentHTML("beforeend", `<div class="lchat__acts">${actionBtn("copy", "bi-copy", "Copy")}${actionBtn("retry", "bi-arrow-repeat", "Try again")}${actionBtn("delete", "bi-trash3", "Delete")}${stats}</div>`);
        }
      });
      if (!state.history.length) {
        log.innerHTML = `<div class="lchat__welcome">
          <p>Hi! I'm a small AI model running right here in your browser. Ask me about localAI events, guides, or getting started with AI on your own computer.</p>
          <div class="lchat__suggest">${SUGGESTIONS.map((s) => `<button type="button" class="lchat__chip">${esc(s)}</button>`).join("")}</div>
        </div>`;
      }
      clearBtn.hidden = !state.history.length;
      drawDiagrams(log);
      drawChats();
      scroll(true);
    }
    redraws.add(() => {
      if (!busy && !log.hidden) redraw();
    });

    // ---- Your chats ----

    function drawChats() {
      const list = $("[data-chats]");
      if (!list) return;
      const find = $("[data-search]").value.trim().toLowerCase();
      const chats = [...app.chats].sort((a, b) => b.updated - a.updated).filter((c) => !find || chatTitle(c).toLowerCase().includes(find) || c.history.some((m) => String(m.content).toLowerCase().includes(find)));
      list.innerHTML = chats
        .map((c) => {
          const count = c.history.filter((m) => !m.tool).length;
          return `<li class="lchat__chat${c.id === app.current ? " is-on" : ""}" data-id="${c.id}">
            <button type="button" class="lchat__chat-open" data-open${c.id === app.current ? ' aria-current="true"' : ""}><span class="lchat__chat-title">${esc(chatTitle(c))}</span><span class="lchat__chat-meta">${count} message${count === 1 ? "" : "s"}</span></button>
            <span class="lchat__chat-acts"><button type="button" data-rename title="Rename" aria-label="Rename ${esc(chatTitle(c))}"><i class="bi bi-pencil" aria-hidden="true"></i></button><button type="button" data-remove title="Delete" aria-label="Delete ${esc(chatTitle(c))}"><i class="bi bi-trash3" aria-hidden="true"></i></button></span>
          </li>`;
        })
        .join("") || `<li class="lchat__muted lchat__small">No chats found.</li>`;
    }

    function openChat(id) {
      if (busy) return;
      app.current = id;
      fromSite.clear();
      (state.links || []).forEach((u) => fromSite.add(u));
      save();
      closePanels();
      root.classList.remove("show-side");
      redraw();
      if (root.classList.contains("is-ready")) input.focus();
    }

    function newChat() {
      if (busy) return;
      // An empty chat is already a new chat
      if (state.history.length) {
        const chat = makeChat();
        app.chats.push(chat);
        app.current = chat.id;
      }
      openChat(app.current);
    }

    function removeChat(id) {
      if (busy) return;
      const at = app.chats.findIndex((c) => c.id === id);
      const [gone] = app.chats.splice(at, 1);
      const wasOpen = id === app.current;
      if (!app.chats.length) app.chats.push(makeChat());
      if (wasOpen) app.current = app.chats.reduce((a, b) => (b.updated > a.updated ? b : a)).id;
      openChat(app.current);
      toast("Chat deleted", () => {
        app.chats.splice(at, 0, gone);
        openChat(gone.id);
      });
    }

    function step(by) {
      const sorted = [...app.chats].sort((a, b) => b.updated - a.updated);
      const next = sorted[sorted.findIndex((c) => c.id === app.current) + by];
      if (next) openChat(next.id);
    }

    function renameChat(item) {
      const chat = app.chats.find((c) => c.id === item.dataset.id);
      const field = document.createElement("input");
      field.className = "lchat__rename";
      field.value = chatTitle(chat);
      field.setAttribute("aria-label", "Chat name");
      item.replaceChildren(field);
      field.select();
      const done = (keep) => {
        if (keep && field.value.trim()) chat.title = field.value.trim();
        try {
          localStorage.setItem(STORE, JSON.stringify(app));
        } catch {}
        drawChats();
      };
      field.addEventListener("keydown", (e) => {
        if (e.key === "Enter") done(true);
        if (e.key === "Escape") {
          e.stopPropagation();
          done(false);
        }
      });
      field.addEventListener("blur", () => done(true), { once: true });
    }

    // ---- Each message ----

    function actOn(act, btn) {
      const el = btn.closest("[data-i]");
      const i = Number(el.dataset.i);
      const m = state.history[i];
      if (act === "copy") return copyText(m.role === "user" ? m.content : visible(m.content), btn);
      if (busy) return;
      if (act === "delete") {
        // An answer goes with the tool results that led to it
        let from = i;
        while (m.role === "assistant" && from > 0 && state.history[from - 1].tool) from--;
        const removed = state.history.splice(from, i - from + 1);
        save();
        redraw();
        toast("Message deleted", () => {
          state.history.splice(from, 0, ...removed);
          save();
          redraw();
        });
      }
      if (act === "retry") {
        let q = i;
        while (q >= 0 && !(state.history[q].role === "user" && !state.history[q].tool)) q--;
        if (q < 0) return;
        state.history = state.history.slice(0, q + 1);
        save();
        redraw();
        reply(ui);
      }
      if (act === "edit") {
        el.innerHTML = `<textarea class="lchat__edit" aria-label="Edit your message"></textarea><div class="lchat__edit-acts"><button type="button" class="lchat__link" data-edit-cancel>Cancel</button><button type="button" class="btn btn-primary lchat__start" data-edit-send>Send</button></div>`;
        const box = el.querySelector("textarea");
        box.value = m.content;
        box.focus();
        el.querySelector("[data-edit-cancel]").onclick = redraw;
        el.querySelector("[data-edit-send]").onclick = () => {
          if (!box.value.trim()) return;
          state.history = state.history.slice(0, i + 1);
          state.history[i].content = box.value.trim();
          save();
          redraw();
          reply(ui);
        };
      }
    }

    function copyText(text, btn) {
      const done = () => {
        announce("Copied");
        if (!btn) return toast("Copied");
        const was = btn.innerHTML;
        btn.innerHTML = `<i class="bi bi-check2" aria-hidden="true"></i>`;
        setTimeout(() => (btn.innerHTML = was), 1500);
      };
      if (navigator.clipboard) navigator.clipboard.writeText(text).then(done, () => toast("Couldn't copy. Try downloading instead."));
    }

    // ---- Export ----

    async function exportChat(kind) {
      exportEl.hidden = true;
      if (!state.history.length) return toast("Nothing to export yet");
      if (kind === "copy") copyText(chatMarkdown());
      if (kind === "md") download(fileName("md"), chatMarkdown(), "text/markdown");
      if (kind === "json") download(fileName("json"), JSON.stringify({ title: chatTitle(currentChat()), model: state.model, messages: state.history.filter((m) => !m.tool).map(({ role, content }) => ({ role, content: role === "user" ? content : visible(content) })) }, null, 2), "application/json");
      if (kind === "png") {
        toast("Making the image...");
        try {
          await saveImage(log);
          toast("Image saved");
        } catch {
          toast("Couldn't make the image. Try Markdown instead.");
        }
      }
    }

    // ---- Settings ----

    const slider = (key, label, min, max, stepBy, fallback, hint) => {
      const value = setting(key) ?? fallback;
      return `<label class="lchat__set"><span class="lchat__set-name">${label}<output>${value}</output></span><input type="range" data-set="${key}" min="${min}" max="${max}" step="${stepBy}" value="${value}"><span class="lchat__opt-note">${hint}</span></label>`;
    };
    const toggle = (key, label, hint) => `<label class="lchat__set lchat__set--check"><input type="checkbox" data-set="${key}"${setting(key) ? " checked" : ""}><span><span class="lchat__set-name">${label}</span><span class="lchat__opt-note">${hint}</span></span></label>`;

    function renderSettings() {
      const m = modelById(state.model);
      settingsEl.innerHTML = `
        <h3 class="lchat__models-title">Settings</h3>
        <h4 class="lchat__set-group">The chat</h4>
        ${toggle("knowledge", "Answer from the localAI website", "Uses the site's content and tools. Turn off for a general assistant.")}
        ${m.qwen ? toggle("thinking", "Let the model think first", "Slower, but better at hard questions, and you can read its thinking. Not every model uses this.") : ""}
        <label class="lchat__set"><span class="lchat__set-name">Your instructions</span><textarea data-set="instructions" rows="3" placeholder="For example: always answer in French.">${esc(setting("instructions"))}</textarea><span class="lchat__opt-note">Added to what the model is told in every chat.</span></label>
        <label class="lchat__set"><span class="lchat__set-name">Send with</span><select data-set="sendKey"><option value="Enter"${setting("sendKey") === "Enter" ? " selected" : ""}>Enter</option><option value="Ctrl"${setting("sendKey") === "Ctrl" ? " selected" : ""}>Ctrl or Cmd + Enter</option></select></label>
        ${slider("fontSize", "Text size", 13, 20, 1, 15, "Size of the chat text.")}
        <h4 class="lchat__set-group">How the model writes</h4>
        ${slider("temperature", "Temperature", 0, 1.5, 0.1, 0.3, "Higher is more creative, lower is more focused.")}
        ${slider("top_p", "Top P", 0.1, 1, 0.05, m.top_p, "How wide a range of words it considers.")}
        ${slider("max_tokens", "Longest answer", 100, 2000, 50, m.short ? 300 : 600, "In tokens. About three quarters of a word each.")}
        ${slider("presence_penalty", "Presence penalty", 0, 2, 0.1, 0, "Higher pushes it towards new topics.")}
        ${slider("frequency_penalty", "Frequency penalty", 0, 2, 0.1, m.tools ? 0 : 0.3, "Higher makes it repeat itself less.")}
        ${slider("history", "Messages it remembers", 1, 20, 1, 8, "How much of the chat it sees with each question.")}
        <button type="button" class="lchat__link" data-reset>Reset these settings</button>
        <h4 class="lchat__set-group">Your prompts</h4>
        <p class="lchat__muted lchat__small">Type / in the chat to use them.</p>
        <ul class="lchat__saved-list" data-prompts></ul>
        <div class="lchat__prompt-add">
          <input type="text" data-prompt-name placeholder="Name" aria-label="Prompt name">
          <textarea data-prompt-text rows="2" placeholder="The text it fills in" aria-label="Prompt text"></textarea>
          <button type="button" class="lchat__link" data-prompt-add>Add prompt</button>
        </div>
        <h4 class="lchat__set-group">Your data</h4>
        <p class="lchat__muted lchat__small">Chats and settings are saved only in this browser.</p>
        <div class="lchat__data">
          <button type="button" class="lchat__link" data-data="export">Back up all chats</button>
          <button type="button" class="lchat__link" data-data="import">Restore from a backup</button>
          <button type="button" class="lchat__link lchat__link--danger" data-data="clear">Delete all chats and settings</button>
          <input type="file" accept="application/json" data-import hidden>
        </div>
        <div class="lchat__models-foot"><button type="button" class="btn btn-primary lchat__start" data-settings-close>Done</button></div>`;
      drawPrompts();
    }

    function drawPrompts() {
      const list = settingsEl.querySelector("[data-prompts]");
      if (!list) return;
      list.innerHTML = app.prompts.length ? app.prompts.map((p, i) => `<li><span>${esc(p[0])}</span><span></span><button type="button" class="lchat__link" data-prompt-del="${i}">Delete</button></li>`).join("") : "";
      list.hidden = !app.prompts.length;
    }

    function applyLook() {
      root.style.setProperty("--lchat-font", `${setting("fontSize")}px`);
    }

    function setSetting(el) {
      const key = el.dataset.set;
      let value = el.type === "checkbox" ? el.checked : el.value;
      if (el.type === "range") {
        value = Number(value);
        el.closest("label").querySelector("output").textContent = value;
      }
      app.settings[key] = value;
      save();
      applyLook();
    }

    function openSettings() {
      closePanels();
      renderSettings();
      settingsEl.hidden = false;
      $("[data-settings-btn]").setAttribute("aria-expanded", "true");
      settingsEl.querySelector("input, select, textarea").focus();
    }
    function closeSettings() {
      settingsEl.hidden = true;
      $("[data-settings-btn]").setAttribute("aria-expanded", "false");
    }
    function closePanels() {
      closeModels(false);
      closeSettings();
      exportEl.hidden = true;
      closeMenu();
    }

    async function dataAction(kind, btn) {
      if (kind === "export") download("localai-chats.json", JSON.stringify({ chats: app.chats, prompts: app.prompts, settings: app.settings }, null, 2), "application/json");
      if (kind === "import") settingsEl.querySelector("[data-import]").click();
      if (kind === "clear") {
        if (!btn.dataset.armed) {
          btn.dataset.armed = "1";
          btn.textContent = "Sure? This can't be undone";
          return;
        }
        app.chats = [makeChat()];
        app.current = app.chats[0].id;
        app.settings = {};
        app.prompts = [];
        fromSite.clear();
        save();
        applyLook();
        closeSettings();
        redraw();
        toast("All chats and settings deleted");
      }
    }

    // ---- Prompts and commands, from the message box ----

    function closeMenu() {
      menu.hidden = true;
      menuItems = [];
    }
    function drawMenu() {
      menu.innerHTML = menuItems.map((m, i) => `<button type="button" role="option" aria-selected="${i === menuAt}" data-menu-i="${i}"><strong>${esc(m.label)}</strong><span>${esc(m.hint)}</span></button>`).join("");
      menu.hidden = !menuItems.length;
      const on = menu.querySelector('[aria-selected="true"]');
      if (on) on.scrollIntoView({ block: "nearest" });
    }
    function updateMenu() {
      const value = input.value;
      menuAt = 0;
      if (/^\/[^\n]*$/.test(value)) {
        const q = value.slice(1).toLowerCase();
        menuItems = [...app.prompts, ...BUILT_IN_PROMPTS].filter((p) => p[0].toLowerCase().includes(q)).map((p) => ({ label: p[0], hint: p[1].trim().slice(0, 60), run: () => {
          input.value = p[1];
          resize();
          input.focus();
        } }));
      } else if (/^:[a-z]*$/.test(value)) {
        menuItems = COMMANDS.filter((c) => c[0].startsWith(value.slice(1))).map((c) => ({ label: `:${c[0]}`, hint: c[1], run: () => {
          input.value = "";
          resize();
          if (c[0] === "new") newChat();
          if (c[0] === "clear") clearChat();
          if (c[0] === "del") removeChat(app.current);
          if (c[0] === "next") step(1);
          if (c[0] === "prev") step(-1);
        } }));
      } else menuItems = [];
      drawMenu();
    }
    function runMenu(i) {
      const item = menuItems[i];
      closeMenu();
      if (item) item.run();
    }

    // ---- Attaching an image (vision models) ----

    function drawAttached() {
      const box = $("[data-attached]");
      box.hidden = !attached;
      box.innerHTML = attached ? `<img src="${esc(attached)}" alt="Image to send"><button type="button" class="lchat__link" data-unattach>Remove</button>` : "";
    }

    // Shrink it first: images are saved with the chat, and browser storage is small
    function attachFile(file) {
      if (!file || !file.type.startsWith("image/")) return;
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, 768 / Math.max(img.width, img.height));
        const canvas = document.createElement("canvas");
        canvas.width = Math.round(img.width * scale);
        canvas.height = Math.round(img.height * scale);
        canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
        attached = canvas.toDataURL("image/jpeg", 0.8);
        URL.revokeObjectURL(img.src);
        drawAttached();
      };
      img.src = URL.createObjectURL(file);
    }

    function clearChat() {
      if (busy) return;
      const before = state.history;
      const links = state.links;
      state.history = [];
      state.links = [];
      fromSite.clear();
      save();
      redraw();
      toast("Chat cleared", () => {
        state.history = before;
        state.links = links;
        links.forEach((u) => fromSite.add(u));
        save();
        redraw();
      });
      announce("Chat cleared");
      input.focus();
    }

    // ---- Before the chat starts: one model, one button ----

    function showCard(error = "") {
      const m = chosen;
      const why = m === picked ? pickedFor() : cap(m.note);
      intro.innerHTML = `
        <div class="lchat__card">
          <p class="lchat__lead">Chat with a small AI model that runs on your own computer. Ask about events, guides or getting started.</p>
          <div class="lchat__choice">
            <i class="bi bi-cpu" aria-hidden="true"></i>
            <span class="lchat__choice-text"><strong>${m.name}</strong><span>${esc(why)}</span></span>
            <button type="button" class="lchat__link" data-change aria-expanded="false" aria-controls="${id}-models">Change<span class="visually-hidden"> model</span></button>
          </div>
          ${error ? `<p class="lchat__error" role="alert">${esc(error)}</p>` : ""}
          <button type="button" class="btn btn-primary lchat__start" data-start>Start the chat</button>
          <p class="lchat__muted lchat__small" data-card-fine>A one-time ${sizeText(m)} download, saved in your browser (<a href="/resources/chat/#storage">where?</a>). Then it works offline, and nothing you type leaves your computer.</p>
        </div>`;
      // Nothing to download if it's already saved
      savedModels().then((saved) => {
        const fine = intro.querySelector("[data-card-fine]");
        if (fine && saved.includes(m)) fine.innerHTML = `Already saved in your browser (<a href="/resources/chat/#storage">where?</a>), so it starts quickly. It works offline, and nothing you type leaves your computer.`;
      });
    }

    // Why we picked it, in a few words
    function pickedFor() {
      if (hw.tier === 0) return "Picked for a phone or a small machine";
      if (/private/.test(hw.why)) return "Picked to run well on most laptops";
      return `Picked for ${hw.why.replace(/^an? /, "your ")}`;
    }

    function showUnsupported() {
      root.classList.add("is-unsupported");
      intro.innerHTML = `
        <div class="lchat__card">
          <i class="bi bi-gpu-card lchat__card-icon" aria-hidden="true"></i>
          <p class="lchat__lead"><strong>This browser can't run the chat yet.</strong></p>
          <p class="lchat__muted">It needs WebGPU. Try Chrome or Edge, or Safari 26 or newer, on a laptop or desktop. Or run AI in an app: see <a href="/resources/getting-started/">Where to Start</a>.</p>
        </div>`;
    }

    // ---- Picking a model ----

    function renderModels() {
      const current = engine && state.model;
      const sel = current || chosen.id;
      models.innerHTML = `
        <h3 class="lchat__models-title" id="${id}-mt">Choose a model</h3>
        <p class="lchat__muted lchat__small">Bigger models are smarter, but slower and a bigger download. <i class="bi bi-tools" aria-hidden="true"></i> means it can also decide to use the site's tools by itself.</p>
        <div class="lchat__saved" data-saved hidden></div>
        <div class="lchat__opts">${MODELS.map(
          (m) => `<label class="lchat__opt">
            <input type="radio" name="${id}-model" value="${m.id}"${m.id === sel ? " checked" : ""}>
            <span class="lchat__opt-text"><span class="lchat__opt-name">${m.name}${m === picked ? ` <span class="lchat__badge">Best fit</span>` : ""}${m.id === current ? ` <span class="lchat__badge lchat__badge--on">In use</span>` : ""}</span><span class="lchat__opt-note">${cap(m.note)}</span></span>
            <span class="lchat__opt-size">${m.tools ? `<i class="bi bi-tools" aria-hidden="true"></i><span class="visually-hidden">Can use site tools, </span>` : ""}${sizeText(m)}</span>
          </label>`,
        ).join("")}</div>
        <div class="lchat__models-foot">
          <button type="button" class="btn btn-primary lchat__start" data-use></button>
          <button type="button" class="lchat__link" data-models-close>Cancel</button>
        </div>`;
      useLabel();
      showSaved();
    }

    // What's taking up space, with a way to remove it. Switching models keeps the old one, so these add up.
    async function showSaved() {
      const saved = await savedModels();
      const box = models.querySelector("[data-saved]");
      if (!box) return;
      box.hidden = !saved.length;
      const total = saved.reduce((sum, m) => sum + m.mb, 0);
      box.innerHTML = `
        <h4 class="lchat__saved-title">Saved in this browser <span>${sizeText({ mb: total })}</span></h4>
        <ul class="lchat__saved-list">${saved
          .map(
            (m) => `<li><span>${m.name}${engine && m.id === state.model ? ` <span class="lchat__badge lchat__badge--on">In use</span>` : ""}</span>
              <span class="lchat__opt-size">${sizeText(m)}</span>
              <button type="button" class="lchat__link" data-delete="${m.id}" aria-label="Delete ${m.name}">Delete</button></li>`,
          )
          .join("")}</ul>
        <p class="lchat__muted lchat__small">They stay until you delete them. <a href="/resources/chat/#storage">Where are they stored?</a></p>`;
    }

    // Two clicks, so a 2 GB download can't go with one slip
    async function removeModel(btn) {
      const model = modelById(btn.dataset.delete);
      if (!btn.dataset.armed) {
        btn.dataset.armed = "1";
        btn.textContent = `Delete ${sizeText(model)}?`;
        setTimeout(() => {
          if (btn.isConnected && btn.dataset.armed) {
            delete btn.dataset.armed;
            btn.textContent = "Delete";
          }
        }, 4000);
        return;
      }
      btn.disabled = true;
      btn.textContent = "Deleting...";
      try {
        const wasRunning = await deleteModel(model);
        announce(`${model.name} deleted`);
        if (wasRunning) backToStart();
        else showSaved();
      } catch (err) {
        announce(`Couldn't delete ${model.name}`);
        btn.disabled = false;
        btn.textContent = "Try again";
        delete btn.dataset.armed;
      }
    }

    // The running model was deleted: back to the start card, keeping the conversation for next time
    function backToStart() {
      state.model = null;
      state.started = false;
      save();
      closeModels(false);
      chosen = picked;
      root.classList.remove("is-ready");
      log.hidden = true;
      form.hidden = true;
      pill.hidden = true;
      clearBtn.hidden = true;
      $("[data-fine]").hidden = true;
      intro.hidden = false;
      showCard();
      const startBtn = intro.querySelector("[data-start]");
      if (startBtn) startBtn.focus();
    }

    function selected() {
      const r = models.querySelector("input:checked");
      return modelById(r ? r.value : chosen.id);
    }
    function useLabel() {
      const m = selected();
      const btn = models.querySelector("[data-use]");
      const inUse = engine && m.id === state.model;
      btn.disabled = inUse;
      btn.textContent = inUse ? `${m.name} is in use` : engine ? `Switch to ${m.name}` : `Start ${m.name}`;
    }

    function openModels(from) {
      opener = from;
      renderModels();
      models.hidden = false;
      from.setAttribute("aria-expanded", "true");
      (models.querySelector("input:checked") || models.querySelector("input")).focus();
    }
    function closeModels(focusBack = true) {
      if (models.hidden) return;
      models.hidden = true;
      if (opener) {
        opener.setAttribute("aria-expanded", "false");
        if (focusBack && opener.isConnected) opener.focus();
      }
    }

    // ---- Loading a model ----

    async function start(model = chosen) {
      if (loading) return;
      loading = true;
      chosen = model;
      closeModels(false);
      const switching = root.classList.contains("is-ready");
      // A strip above the input when switching, otherwise in place of the start card
      if (switching) form.before(loadingEl);
      else {
        intro.innerHTML = "";
        intro.append(loadingEl);
      }
      root.classList.add("is-loading");
      input.disabled = true;
      send.disabled = true;
      clearBtn.disabled = true;
      pill.disabled = true;
      loadingEl.hidden = false;
      const bar = loadingEl.querySelector(".lchat__progress");
      const label = loadingEl.querySelector("[data-load-label]");
      const amount = loadingEl.querySelector("[data-load-amount]");
      const note = loadingEl.querySelector("[data-load-note]");
      bar.firstElementChild.style.width = "0";
      label.textContent = switching ? `Switching to ${model.name}...` : "Getting ready...";
      amount.textContent = "";
      note.textContent = "";
      announce(`Loading ${model.name}`);
      try {
        await startEngine(model, (p) => {
          const pct = Math.round((p.progress || 0) * 100);
          // WebLLM says "Fetching" while downloading and "Loading model from cache" once it's saved
          const cached = /loading model from cache/i.test(p.text);
          bar.firstElementChild.style.width = `${pct}%`;
          bar.setAttribute("aria-valuenow", pct);
          label.textContent = p.progress >= 1 ? `Starting ${model.name}...` : `${cached ? "Loading" : "Downloading"} ${model.name}`;
          amount.textContent = p.progress >= 1 ? "" : cached ? `${pct}%` : `${pct}% of ${sizeText(model)}`;
          note.textContent = cached ? "It's saved in your browser, so this is quick." : "This only happens once. After that it works offline.";
        });
        state.model = model.id;
        state.started = true;
        save();
        announce(`${model.name} is ready`);
        ready();
        input.focus();
      } catch (err) {
        const text = `Couldn't load ${model.name}: ${err.message}. Try a smaller model.`;
        if (switching) {
          ready();
          ui.addError(text);
        } else showCard(text);
        announce(text);
      } finally {
        loading = false;
        root.classList.remove("is-loading");
        loadingEl.hidden = true;
        send.disabled = false;
        clearBtn.disabled = false;
        pill.disabled = false;
      }
    }

    function ready() {
      root.classList.add("is-ready");
      intro.hidden = true;
      log.hidden = false;
      form.hidden = false;
      $("[data-fine]").hidden = false;
      pill.hidden = false;
      $("[data-attach]").hidden = !modelById(state.model).vision;
      $("[data-pill-name]").textContent = modelById(state.model).name;
      pill.title = `${modelById(state.model).name}, running on your computer. Change model`;
      input.disabled = false;
      send.disabled = false;
      redraw();
    }

    async function ask(text) {
      if (!text.trim() || busy || loading || !engine) return;
      state.history.push({ role: "user", content: text.trim(), ...(attached ? { image: attached } : {}) });
      save();
      input.value = "";
      attached = null;
      drawAttached();
      closeMenu();
      resize();
      redraw();
      await reply(ui);
    }

    function resize() {
      input.style.height = "auto";
      input.style.height = `${Math.min(input.scrollHeight, 160)}px`;
    }

    form.addEventListener("submit", (e) => {
      e.preventDefault();
      ask(input.value);
    });
    send.addEventListener("click", (e) => {
      if (busy) {
        e.preventDefault();
        stop();
      }
    });
    input.addEventListener("keydown", (e) => {
      if (menuItems.length) {
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
          e.preventDefault();
          menuAt = (menuAt + (e.key === "ArrowDown" ? 1 : -1) + menuItems.length) % menuItems.length;
          return drawMenu();
        }
        if (e.key === "Enter" || e.key === "Tab") {
          e.preventDefault();
          return runMenu(menuAt);
        }
        if (e.key === "Escape") {
          e.stopPropagation();
          return closeMenu();
        }
      }
      const wantsCtrl = setting("sendKey") === "Ctrl";
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing && (!wantsCtrl || e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        ask(input.value);
      }
    });
    input.addEventListener("input", () => {
      resize();
      updateMenu();
    });
    menu.addEventListener("click", (e) => {
      const b = e.target.closest("[data-menu-i]");
      if (b) runMenu(Number(b.dataset.menuI));
    });
    log.addEventListener("scroll", showBottom);
    toBottom.addEventListener("click", () => scroll(true));
    intro.addEventListener("click", (e) => {
      if (e.target.closest("[data-start]")) start();
      const change = e.target.closest("[data-change]");
      if (change) openModels(change);
    });
    log.addEventListener("click", (e) => {
      const chip = e.target.closest(".lchat__chip");
      if (chip) ask(chip.textContent);
      const act = e.target.closest("[data-act]");
      if (act) actOn(act.dataset.act, act);
      const code = e.target.closest(".lchat__code-copy");
      if (code) copyText(code.closest("pre").querySelector("code").textContent, code);
    });
    // The bar, your chats and the panels
    root.addEventListener("click", (e) => {
      const t = e.target;
      if (t.closest("[data-new]")) newChat();
      if (t.closest("[data-side-toggle]")) root.classList.toggle("show-side");
      const item = t.closest(".lchat__chat");
      if (item && t.closest("[data-open]")) openChat(item.dataset.id);
      if (item && t.closest("[data-rename]")) renameChat(item);
      if (item && t.closest("[data-remove]")) removeChat(item.dataset.id);
      if (t.closest("[data-export-btn]")) {
        const open = exportEl.hidden;
        closePanels();
        exportEl.hidden = !open;
        $("[data-export-btn]").setAttribute("aria-expanded", String(open));
      } else if (!t.closest("[data-export]")) exportEl.hidden = true;
      const out = t.closest("[data-out]");
      if (out) exportChat(out.dataset.out);
      if (t.closest("[data-settings-btn]")) (settingsEl.hidden ? openSettings() : closeSettings());
      if (t.closest("[data-settings-close]")) {
        closeSettings();
        redraw();
      }
      if (t.closest("[data-reset]")) {
        const keep = { knowledge: app.settings.knowledge, instructions: app.settings.instructions, sendKey: app.settings.sendKey, thinking: app.settings.thinking };
        app.settings = keep;
        Object.keys(keep).forEach((k) => keep[k] === undefined && delete keep[k]);
        save();
        applyLook();
        renderSettings();
      }
      const data = t.closest("[data-data]");
      if (data) dataAction(data.dataset.data, data);
      if (t.closest("[data-prompt-add]")) {
        const name = settingsEl.querySelector("[data-prompt-name]");
        const text = settingsEl.querySelector("[data-prompt-text]");
        if (name.value.trim() && text.value.trim()) {
          app.prompts.push([name.value.trim(), text.value]);
          name.value = "";
          text.value = "";
          save();
          drawPrompts();
        }
      }
      const del = t.closest("[data-prompt-del]");
      if (del) {
        app.prompts.splice(Number(del.dataset.promptDel), 1);
        save();
        drawPrompts();
      }
      if (t.closest("[data-attach]")) $("[data-file]").click();
      if (t.closest("[data-unattach]")) {
        attached = null;
        drawAttached();
      }
    });
    settingsEl.addEventListener("input", (e) => {
      if (e.target.dataset.set) setSetting(e.target);
    });
    settingsEl.addEventListener("change", (e) => {
      if (e.target.matches("[data-import]")) {
        const file = e.target.files[0];
        if (!file) return;
        file.text().then((raw) => {
          try {
            const data = JSON.parse(raw);
            const known = new Set(app.chats.map((c) => c.id));
            (data.chats || []).filter((c) => c.id && Array.isArray(c.history) && !known.has(c.id)).forEach((c) => app.chats.push({ links: [], ...c }));
            app.prompts.push(...(data.prompts || []).filter((p) => Array.isArray(p) && p.length === 2));
            save();
            closeSettings();
            redraw();
            toast("Chats restored");
          } catch {
            toast("That file isn't a chat backup");
          }
        });
      }
    });
    settingsEl.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        closeSettings();
        $("[data-settings-btn]").focus();
      }
    });
    $("[data-file]").addEventListener("change", (e) => {
      attachFile(e.target.files[0]);
      e.target.value = "";
    });
    const search = $("[data-search]");
    if (search) search.addEventListener("input", drawChats);
    applyLook();
    pill.addEventListener("click", () => (models.hidden ? openModels(pill) : closeModels()));
    models.addEventListener("change", useLabel);
    models.addEventListener("click", (e) => {
      if (e.target.closest("[data-models-close]")) closeModels();
      if (e.target.closest("[data-use]")) start(selected());
      const del = e.target.closest("[data-delete]");
      if (del) removeModel(del);
    });
    // Escape closes the model list first, then (in the floating chat) the panel
    models.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        closeModels();
      }
    });
    clearBtn.addEventListener("click", clearChat);

    // Pick a model for this machine, or explain why it can't run here
    (async () => {
      hw = await detect();
      if (!hw.supported) return showUnsupported();
      picked = modelById(PICKS[hw.tier]);
      chosen = state.model ? modelById(state.model) : picked;
      // Already loaded on this page, or downloaded before: carry straight on without asking again
      if (engine) ready();
      else if (state.started && (await isCached(chosen))) start(chosen);
      else showCard();
    })();

    return { focus: () => (root.classList.contains("is-ready") ? input : $("[data-start]") || $(".lchat__bar button:not([hidden]), .lchat__bar a") || root).focus() };
  }

  // ---------- Floating chat on laptops and desktops ----------

  function floating() {
    const wrap = document.createElement("div");
    wrap.className = "lchat-float";
    wrap.innerHTML = `
      <div class="lchat-float__panel" id="lchat-panel" role="dialog" aria-label="localAI chat" hidden></div>
      <button type="button" class="lchat-float__button" aria-expanded="false" aria-controls="lchat-panel"><i class="bi bi-chat-dots-fill" aria-hidden="true"></i><span>Ask localAI</span></button>`;
    document.body.appendChild(wrap);

    const panel = wrap.querySelector(".lchat-float__panel");
    const button = wrap.querySelector(".lchat-float__button");
    let chat;
    const close = () => {
      setOpen(false);
      button.focus();
    };
    const setOpen = (open) => {
      if (open && !chat) {
        chat = mount(panel, {
          compact: true,
          title: "Ask localAI",
          actions: `<a href="/resources/chat/" class="lchat__icon-btn" title="Open the full chat page"><i class="bi bi-arrows-angle-expand" aria-hidden="true"></i><span class="visually-hidden">Open the full chat page</span></a>
            <button type="button" class="lchat__icon-btn" data-close title="Close"><i class="bi bi-x-lg" aria-hidden="true"></i><span class="visually-hidden">Close the chat</span></button>`,
        });
        panel.querySelector("[data-close]").addEventListener("click", close);
      }
      panel.hidden = !open;
      button.setAttribute("aria-expanded", String(open));
      wrap.classList.toggle("is-open", open);
      state.open = open;
      save();
      if (open) setTimeout(() => chat.focus(), 50);
    };
    button.addEventListener("click", () => setOpen(panel.hidden));
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !panel.hidden) close();
    });
    // Reopen after a tool moved the visitor to another page
    if (state.open) setOpen(true);
  }

  // ---------- Start ----------

  // "Where?" links open the storage answers on the chat page
  const openStorage = () => {
    const box = location.hash === "#storage" && document.getElementById("storage");
    if (box) {
      box.open = true;
      box.scrollIntoView();
    }
  };
  window.addEventListener("hashchange", openStorage);
  openStorage();

  // The chat page fills the screen under the navbar
  if (PAGE_ROOT) {
    const nav = document.getElementById("navbar-main");
    const app = PAGE_ROOT.closest(".chat-app");
    const setTop = () => app && app.style.setProperty("--chat-top", `${nav ? nav.offsetHeight : 0}px`);
    setTop();
    window.addEventListener("resize", setTop);
    mount(PAGE_ROOT);
  } else if (DESKTOP.matches) floating();
})();
