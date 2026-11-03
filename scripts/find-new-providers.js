// scripts/find-new-providers.js: lists labs releasing popular open models that the
// Model Providers section (src/_data/modelProviders.js) doesn't track yet.
// Prints a Markdown report, or nothing if there's nothing new. Run: node scripts/find-new-providers.js
const { PROVIDERS, QUANTISED } = require("../src/_data/modelProviders.js");

const DAYS = 30;
const MIN_LIKES = 50;
const PIPELINES = ["text-generation", "image-text-to-text"];
// Community remixes of someone else's model, not a new lab
const REMIX = /uncensor|abliterat|obliterat|heretic|humaniz|merge|distill|-lora|roleplay/i;

const tracked = new Set(PROVIDERS.map((p) => p.hfAuthor.toLowerCase()));
const since = new Date(Date.now() - DAYS * 86400000).toISOString();
const authorOf = (id) => id.split("/")[0];

async function getJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`${url} responded ${res.status}`);
  return res.json();
}

// A fine-tune lists its base model; if that comes from a lab we track (or anyone else), it's not a new lab
function isFineTuneOfOthers(model) {
  const base = (model.cardData && model.cardData.base_model) || [];
  return [].concat(base).some((b) => authorOf(b).toLowerCase() !== authorOf(model.id).toLowerCase());
}

// Organisations have an overview page, individual people don't
const orgCache = new Map();
async function isOrg(author) {
  if (!orgCache.has(author)) {
    const res = await fetch(`https://huggingface.co/api/organizations/${author}/overview`, { signal: AbortSignal.timeout(20000) });
    orgCache.set(author, res.ok);
  }
  return orgCache.get(author);
}

async function main() {
  const lists = await Promise.all(
    PIPELINES.map((tag) =>
      getJson(`https://huggingface.co/api/models?pipeline_tag=${tag}&sort=trendingScore&limit=300&expand[]=createdAt&expand[]=likes&expand[]=cardData`)
    )
  );

  const seen = new Set();
  const candidates = lists.flat().filter((m) => {
    if (seen.has(m.id)) return false;
    seen.add(m.id);
    return (
      m.createdAt >= since &&
      m.likes >= MIN_LIKES &&
      !tracked.has(authorOf(m.id).toLowerCase()) &&
      !QUANTISED.test(m.id) &&
      !REMIX.test(m.id) &&
      !isFineTuneOfOthers(m)
    );
  });

  // One row per lab, showing its most liked recent model
  const labs = new Map();
  for (const m of candidates) {
    const author = authorOf(m.id);
    const lab = labs.get(author) || { author, models: [] };
    lab.models.push(m);
    labs.set(author, lab);
  }

  const rows = [];
  for (const lab of labs.values()) {
    if (!(await isOrg(lab.author))) continue;
    lab.models.sort((a, b) => b.likes - a.likes);
    rows.push(lab);
  }
  rows.sort((a, b) => b.models[0].likes - a.models[0].likes);
  if (!rows.length) return;

  const lines = [
    `Labs with open models that got ${MIN_LIKES}+ likes on Hugging Face in the last ${DAYS} days, not yet in \`src/_data/modelProviders.js\`.`,
    "",
    "| Lab | Top model | Likes | Released | Other models |",
    "|---|---|---|---|---|",
    ...rows.map(({ author, models: [top, ...others] }) =>
      `| [${author}](https://huggingface.co/${author}) | [${top.id.split("/")[1]}](https://huggingface.co/${top.id}) | ${top.likes} | ${top.createdAt.slice(0, 10)} | ${others.length} |`
    ),
    "",
    "Add the ones worth tracking to `PROVIDERS`, then close this issue. It's updated every Monday.",
  ];
  console.log(lines.join("\n"));
}

main().catch((err) => {
  console.error(`find-new-providers: ${err.message}`);
  process.exit(1);
});
