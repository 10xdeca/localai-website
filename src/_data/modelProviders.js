// Model provider "latest release" is fetched from the Hugging Face API at build
// time. Raw "most recent upload" per org is too noisy to use directly (large labs
// dump research/tooling repos into the same namespace as their flagship chat
// models) so each provider carries a `namePattern` the release must match plus a
// shared BLOCKLIST of known noise (safety classifiers, ASR/audio, ONNX exports,
// etc). If the API is unreachable or nothing matches, we fall back to the
// last-known-good value baked in below so the build never breaks.

const BLOCKLIST = /guard|safety|classifier|tokenizer|audio|speech|asr|-tts|align|assistant|unquantized|rerank|-qat-|reward|bench|agentworld|labs-|proxy|-ocr|ground|world/i;
const NOISY_SUFFIX = /-(original|fp8|bf16|gptq|awq|int4|int8|nvfp4|w4a\d+|gguf|onnx)(-|$)/i;
const INSTRUCT_HINT = /instruct|-it$|-it-/i;

const PROVIDERS = [
  {
    name: "Meta",
    model: "Llama",
    country: "USA",
    flag: "🇺🇸",
    logo: "/assets/images/resources/providers/meta.png",
    website: "https://www.llama.com",
    hfUrl: "https://huggingface.co/meta-llama",
    hfAuthor: "meta-llama",
    namePattern: /^Llama-[34]/i,
    fallback: { display: "Llama 4 Scout 17B 16E Instruct", date: "2025-04-02", url: "https://huggingface.co/meta-llama/Llama-4-Scout-17B-16E-Instruct" },
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
    namePattern: /^Nemotron-\d/i,
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
  const clean = candidates.filter((m) => !NOISY_SUFFIX.test(m.id));
  const instructFirst = clean.filter((m) => INSTRUCT_HINT.test(m.id));
  const pick = instructFirst[0] || clean[0] || candidates[0];
  if (!pick) throw new Error("no matching release found");

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
