// Model provider "latest release" is fetched from the Hugging Face API at build
// time. Raw "most recent upload" per org is too noisy to use directly (large labs
// dump research/tooling repos into the same namespace as their flagship chat
// models) so each provider carries a `namePattern` the release must match plus a
// shared BLOCKLIST of known noise (safety classifiers, ASR/audio, ONNX exports,
// etc). If the API is unreachable or nothing matches, we fall back to the
// last-known-good value baked in below so the build never breaks.

// Not a release people would run: helper models (draft models for speculative decoding,
// probes, parsers), safety and audio models, and on-device export formats
const BLOCKLIST = /guard|safety|classifier|tokenizer|audio|speech|asr|transcribe|-tts|align|assistant|unquantized|rerank|embed|-qat-|reward|bench|agentworld|labs-|proxy|-ocr|parse|ground|world|dspark|dflash|eagle|probe|executorch|-pte/i;
// Quantised or converted copies of a release; the original upload is preferred
const QUANTISED = /-(fp8|gptq|awq|int4|int8|nvfp4|mxfp4|w4a\d+|gguf|onnx|mlx|\d+bit|q\d(_k_m)?)(-|$)/i;
// Stripped from display names only (bf16 is often how the original weights are published)
const NOISY_SUFFIX = /-(original|bf16|fp8|gptq|awq|int4|int8|nvfp4|w4a\d+|gguf|onnx)(-|$)/i;
const BASE = /-base(-|$)/i;
const INSTRUCT_HINT = /instruct|-it$|-it-/i;
// An instruct model only wins over a newer release if it came out within this many days of it
const INSTRUCT_WINDOW_DAYS = 14;

const PROVIDERS = [
  {
    name: "Meta",
    model: "Muse",
    country: "USA",
    flag: "🇺🇸",
    logo: "/assets/images/resources/providers/meta.png",
    website: "https://ai.meta.com",
    hfUrl: "https://huggingface.co/meta-models",
    hfAuthor: "meta-models",
    namePattern: /^Muse-/i,
    fallback: { display: "Muse Spark Open 816B A42B", date: "2026-09-15", url: "https://huggingface.co/meta-models/Muse-Spark-Open-816B-A42B" },
  },
  {
    name: "Mistral AI",
    model: "Mistral",
    country: "France",
    flag: "🇫🇷",
    logo: "/assets/images/resources/providers/mistral.png",
    website: "https://mistral.ai",
    hfUrl: "https://huggingface.co/mistralai",
    hfAuthor: "mistralai",
    namePattern: /^Mistral-/i,
    fallback: { display: "Mistral Large 3 675B Instruct", date: "2025-11-28", url: "https://huggingface.co/mistralai/Mistral-Large-3-675B-Instruct-2512" },
  },
  {
    name: "Alibaba",
    model: "Qwen",
    country: "China",
    flag: "🇨🇳",
    logo: "/assets/images/resources/providers/alibaba.png",
    website: "https://qwen.ai",
    hfUrl: "https://huggingface.co/Qwen",
    hfAuthor: "Qwen",
    namePattern: /^Qwen[\d.]+-/i,
    fallback: { display: "Qwen3.6 27B", date: "2026-04-21", url: "https://huggingface.co/Qwen/Qwen3.6-27B" },
  },
  {
    name: "DeepSeek",
    model: "DeepSeek",
    country: "China",
    flag: "🇨🇳",
    logo: "/assets/images/resources/providers/deepseek.png",
    website: "https://www.deepseek.com",
    hfUrl: "https://huggingface.co/deepseek-ai",
    hfAuthor: "deepseek-ai",
    namePattern: /^DeepSeek-V\d/i,
    fallback: { display: "DeepSeek V4 Pro DSpark", date: "2026-06-27", url: "https://huggingface.co/deepseek-ai/DeepSeek-V4-Pro-DSpark" },
  },
  {
    name: "Google",
    model: "Gemma",
    country: "USA",
    flag: "🇺🇸",
    logo: "/assets/images/resources/providers/google.png",
    website: "https://deepmind.google/models/gemma/",
    hfUrl: "https://huggingface.co/google",
    hfAuthor: "google",
    hfSearch: "Gemma",
    namePattern: /^gemma-\d/i,
    fallback: { display: "Gemma 4 12B it", date: "2026-05-23", url: "https://huggingface.co/google/gemma-4-12B-it" },
  },
  {
    name: "Moonshot AI",
    model: "Kimi",
    country: "China",
    flag: "🇨🇳",
    logo: "/assets/images/resources/providers/moonshot.png",
    website: "https://www.moonshot.ai",
    hfUrl: "https://huggingface.co/moonshotai",
    hfAuthor: "moonshotai",
    hfSearch: "Kimi",
    namePattern: /^Kimi-/i,
    fallback: { display: "Kimi Linear 48B A3B Instruct", date: "2025-10-30", url: "https://huggingface.co/moonshotai/Kimi-Linear-48B-A3B-Instruct" },
  },
  {
    name: "Z.AI",
    model: "GLM",
    country: "China",
    flag: "🇨🇳",
    logo: "/assets/images/resources/providers/zai.png",
    website: "https://z.ai",
    hfUrl: "https://huggingface.co/zai-org",
    hfAuthor: "zai-org",
    namePattern: /^GLM-\d/i,
    fallback: { display: "GLM-5.2", date: "2026-06-16", url: "https://huggingface.co/zai-org/GLM-5.2" },
  },
  {
    name: "NVIDIA",
    model: "Nemotron",
    country: "USA",
    flag: "🇺🇸",
    logo: "/assets/images/resources/providers/nvidia.png",
    website: "https://www.nvidia.com/en-us/ai-data-science/foundation-models/nemotron/",
    hfUrl: "https://huggingface.co/nvidia",
    hfAuthor: "nvidia",
    hfSearch: "Nemotron",
    namePattern: /^(NVIDIA-)?Nemotron-\d/i,
    fallback: { display: "Nemotron 3 Nano Omni 30B A3B Reasoning", date: "2026-04-24", url: "https://huggingface.co/nvidia/Nemotron-3-Nano-Omni-30B-A3B-Reasoning-FP8" },
  },
  {
    name: "Microsoft",
    model: "Phi",
    country: "USA",
    flag: "🇺🇸",
    logo: "/assets/images/resources/providers/microsoft.png",
    website: "https://azure.microsoft.com/en-us/products/phi",
    hfUrl: "https://huggingface.co/microsoft",
    hfAuthor: "microsoft",
    hfSearch: "Phi",
    namePattern: /^Phi-\d/i,
    fallback: { display: "Phi-4 multimodal instruct", date: "2025-02-24", url: "https://huggingface.co/microsoft/Phi-4-multimodal-instruct" },
  },
  {
    name: "IBM",
    model: "Granite",
    country: "USA",
    flag: "🇺🇸",
    logo: "/assets/images/resources/providers/ibm.png",
    website: "https://www.ibm.com/granite",
    hfUrl: "https://huggingface.co/ibm-granite",
    hfAuthor: "ibm-granite",
    hfSearch: "granite",
    namePattern: /^granite-[\d.]/i,
    fallback: { display: "Granite 4.1 30B", date: "2026-04-06", url: "https://huggingface.co/ibm-granite/granite-4.1-30b-base" },
  },
  {
    name: "OpenAI",
    model: "gpt-oss",
    country: "USA",
    flag: "🇺🇸",
    logo: "/assets/images/resources/providers/openai.png",
    website: "https://openai.com/open-models",
    hfUrl: "https://huggingface.co/openai",
    hfAuthor: "openai",
    namePattern: /^gpt-oss/i,
    fallback: { display: "Gpt oss 120b", date: "2025-08-04", url: "https://huggingface.co/openai/gpt-oss-120b" },
  },
  {
    name: "Liquid AI",
    model: "LFM",
    country: "USA",
    flag: "🇺🇸",
    logo: "/assets/images/resources/providers/liquid.png",
    website: "https://www.liquid.ai",
    hfUrl: "https://huggingface.co/LiquidAI",
    hfAuthor: "LiquidAI",
    hfSearch: "LFM",
    namePattern: /^LFM\d/i,
    fallback: { display: "LFM3 1.7B", date: "2026-10-23", url: "https://huggingface.co/LiquidAI/LFM3-1.7B" },
  },
  {
    name: "Ai2",
    model: "Olmo",
    country: "USA",
    flag: "🇺🇸",
    logo: "/assets/images/resources/providers/ai2.png",
    website: "https://allenai.org/olmo",
    hfUrl: "https://huggingface.co/allenai",
    hfAuthor: "allenai",
    hfSearch: "Olmo",
    namePattern: /^Olmo-\d/i,
    fallback: { display: "Olmo 3.1 32B Think", date: "2025-12-10", url: "https://huggingface.co/allenai/Olmo-3.1-32B-Think" },
  },
  {
    name: "JetBrains",
    model: "Mellum",
    country: "Czech Republic",
    flag: "🇨🇿",
    logo: "/assets/images/resources/providers/jetbrains.png",
    website: "https://www.jetbrains.com/ai",
    hfUrl: "https://huggingface.co/JetBrains",
    hfAuthor: "JetBrains",
    hfSearch: "Mellum",
    namePattern: /^Mellum/i,
    fallback: { display: "Mellum2.1 12B A2.5B Thinking", date: "2026-09-20", url: "https://huggingface.co/JetBrains/Mellum2.1-12B-A2.5B-Thinking" },
  },
  {
    name: "Nanbeige",
    model: "Nanbeige",
    country: "China",
    flag: "🇨🇳",
    logo: "/assets/images/resources/providers/nanbeige.png",
    website: "https://huggingface.co/Nanbeige",
    hfUrl: "https://huggingface.co/Nanbeige",
    hfAuthor: "Nanbeige",
    namePattern: /^Nanbeige\d/i,
    fallback: { display: "Nanbeige4.3 33B", date: "2026-10-24", url: "https://huggingface.co/Nanbeige/Nanbeige4.3-33B" },
  },
  {
    name: "inclusionAI",
    model: "Ling",
    country: "China",
    flag: "🇨🇳",
    logo: "/assets/images/resources/providers/inclusionai.png",
    website: "https://huggingface.co/inclusionAI",
    hfUrl: "https://huggingface.co/inclusionAI",
    hfAuthor: "inclusionAI",
    hfSearch: "Ling",
    namePattern: /^Ling-\d/i,
    fallback: { display: "Ling 3.1 flash 1019", date: "2026-10-27", url: "https://huggingface.co/inclusionAI/Ling-3.1-flash-1019" },
  },
];

function toDisplayName(repoId) {
  const name = repoId.split("/").slice(1).join("/");
  const cleaned = name.replace(NOISY_SUFFIX, "").replace(/-/g, " ");
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}

async function fetchLatest(provider) {
  const params = new URLSearchParams({
    author: provider.hfAuthor,
    sort: "createdAt",
    direction: "-1",
    limit: "40",
  });
  if (provider.hfSearch) params.set("search", provider.hfSearch);

  const res = await fetch(`https://huggingface.co/api/models?${params}`, {
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`HF API responded ${res.status}`);
  const data = await res.json();

  const candidates = data.filter((m) => {
    const name = m.id.split("/").slice(1).join("/");
    return provider.namePattern.test(name) && !BLOCKLIST.test(m.id);
  });
  // Prefer the original upload of a finished model: not a quantised copy, not a base checkpoint
  const originals = candidates.filter((m) => !QUANTISED.test(m.id));
  const finished = originals.filter((m) => !BASE.test(m.id));
  const pool = finished.length ? finished : originals.length ? originals : candidates;
  const newest = pool[0];
  if (!newest) throw new Error("no matching release found");

  // An instruct version beats the newest release only if it's from the same launch
  const windowStart = new Date(newest.createdAt) - INSTRUCT_WINDOW_DAYS * 86400000;
  const pick = pool.find((m) => INSTRUCT_HINT.test(m.id) && new Date(m.createdAt) >= windowStart) || newest;

  return {
    display: toDisplayName(pick.id),
    date: pick.createdAt.slice(0, 10),
    url: `https://huggingface.co/${pick.id}`,
  };
}

module.exports = async function () {
  const results = await Promise.all(
    PROVIDERS.map(async ({ fallback, namePattern, ...provider }) => {
      try {
        const latest = await fetchLatest({ ...provider, namePattern });
        return { ...provider, latest };
      } catch (err) {
        console.warn(`[modelProviders] ${provider.name}: falling back (${err.message})`);
        return { ...provider, latest: { ...fallback, stale: true } };
      }
    })
  );
  return results.sort((a, b) => (a.latest.date < b.latest.date ? 1 : -1));
};

// The tracked list, for scripts/find-new-providers.js
module.exports.PROVIDERS = PROVIDERS;
module.exports.QUANTISED = QUANTISED;
