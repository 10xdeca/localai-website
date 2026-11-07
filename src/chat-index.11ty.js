// /chat-index.json: the site's content in small pieces, for the localAI chat to search (webllm-chat.js).
// The chat finds the pieces that match a question and gives them to the model next to it, so even a
// tiny model answers from what the site actually says.
const fs = require("fs");

// Markdown or HTML to plain text: drop front matter, tags, link targets and formatting marks
const plain = (s = "") =>
  String(s)
    .replace(/^---[\s\S]*?\n---\n/, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\{%[\s\S]*?%\}|\{\{[\s\S]*?\}\}/g, "")
    .replace(/^#+\s*/gm, "")
    .replace(/[*_`>|]/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

// Group paragraphs into pieces of about 600 characters, so one piece is one idea
function pieces(text, size = 600) {
  const out = [];
  let cur = "";
  for (const para of text.split(/\n\s*\n/).map((p) => p.replace(/\s*\n\s*/g, " ").trim()).filter(Boolean)) {
    if (cur && cur.length + para.length > size) {
      out.push(cur);
      cur = "";
    }
    cur = cur ? `${cur} ${para}` : para;
  }
  if (cur) out.push(cur);
  return out;
}

const body = (item) => {
  try {
    return plain(fs.readFileSync(item.inputPath, "utf8"));
  } catch {
    return "";
  }
};

class ChatIndex {
  data() {
    return { permalink: "/chat-index.json", eleventyExcludeFromCollections: true };
  }

  render({ collections, focusAreas, community, about, calculator, site }) {
    const docs = [];
    const add = (doc) => docs.push({ ...doc, text: doc.text.replace(/\s+/g, " ").trim() });

    add({ kind: "site", title: "What is localAI", url: "/about/", text: `localAI: ${site.description} ${about.whatIsLocalAI.title} ${about.whatIsLocalAI.lead}` });
    for (const f of about.facts || []) add({ kind: "about", title: f.title, url: "/about/", text: `${f.title}. ${f.body}` });
    for (const c of (about.whatWeDo && about.whatWeDo.cards) || []) add({ kind: "about", title: `localAI ${c.title}`, url: "/about/", text: `${c.title}: ${c.body}` });
    if (about.whoItsFor) add({ kind: "about", title: "Who localAI is for", url: "/about/", text: `${about.whoItsFor.title}. ${about.whoItsFor.lead}` });

    // Events: the date goes in machine form too, so the chat can tell upcoming from past when it runs
    for (const e of collections.events) {
      const d = e.data;
      const date = d.eventDate ? new Date(d.eventDate).toISOString().slice(0, 10) : null;
      const when = date ? `${new Date(`${date}T12:00:00`).toLocaleDateString("en-AU", { weekday: "long", day: "numeric", month: "long", year: "numeric" })}, ${d.startTime || ""} to ${d.endTime || ""}` : "Date to be announced";
      const where = (d.location || "").replace(/\n/g, ", ");
      add({ kind: "event", title: d.title, url: e.url, date, text: `Event: ${d.title}. When: ${when}. Where: ${where}. ${d.description || ""}` });
      for (const p of pieces(body(e))) add({ kind: "event-detail", title: d.title, url: e.url, date, text: p });
    }

    for (const p of collections.posts) {
      const d = p.data;
      add({ kind: "post", title: d.title, url: p.url, text: `Post: ${d.title}. ${d.description || ""}` });
      for (const t of pieces(body(p))) add({ kind: "post-detail", title: d.title, url: p.url, text: t });
    }

    for (const a of focusAreas.areas) {
      add({ kind: "guide", title: a.title, url: a.href, text: `Guide: ${a.title}. ${a.lead}` });
      for (const r of a.resources || []) {
        add({ kind: "tool", title: r.name, url: a.href, text: `${r.name} (in the ${a.title} guide${r.tags && r.tags.length ? `, ${r.tags.join(", ")}` : ""}): ${r.description}${r.website ? ` Website: ${r.website}` : ""}` });
      }
    }

    add({
      kind: "tool",
      title: calculator.page.title,
      url: "/resources/calculator/",
      text: `${calculator.page.title}: ${calculator.page.subtitle} ${calculator.page.lead} It detects your Mac, laptop or graphics card and lists which open models run well on it, for chat and coding, images, speech to text and text to speech.`,
    });
    add({
      kind: "tool",
      title: "localAI Chat",
      url: "/resources/chat/",
      text: "localAI Chat: a small AI model that runs in your web browser with WebLLM and WebGPU. Nothing to install, it works offline after the first download, and nothing you type leaves your computer.",
    });

    add({
      kind: "tool",
      title: "WebMCP on the localAI website",
      url: "/resources/chat/",
      text: "WebMCP: yes, the localAI website supports WebMCP, a way for AI agents in the browser to use a site's tools. The site offers tools to list events and posts, search the site, open pages, add events to a calendar, list resource guides and get the group chat links. localAI Chat uses these same tools.",
    });
    add({
      kind: "tool",
      title: "Where the localAI Chat model is stored",
      url: "/resources/chat/",
      text: "Storage and deleting the model: the model is saved inside your web browser on your computer, as site data, not as a file in your Downloads folder. It takes up about 300 MB to 5 GB, and models you switched away from stay saved too. It is not deleted automatically on a timer: it stays until you delete it or clear site data, though a browser can remove it if the disk gets very full, and Safari can clear it if you don't visit for a while. To delete it, open the model list in the chat and choose Delete next to the model, or clear this site's data in your browser settings. Your chats are saved in this browser too, never sent anywhere, and can be deleted in the chat's Settings.",
    });

    const chats = community.platforms.filter((p) => p.active);
    add({
      kind: "community",
      title: "localAI group chats",
      url: "/community/",
      text: `Join the localAI group chat on ${chats.map((p) => p.name).join(", ")}. The chats are bridged, so joining any one reaches everyone. Links: ${chats.map((p) => `${p.name} ${p.joinHref}`).join("; ")}.`,
    });
    if (community.subscribe) add({ kind: "community", title: "localAI newsletter", url: "/community/", text: `Newsletter: ${plain(community.subscribe.lead)} Sign up on the Community page.` });

    return JSON.stringify(docs.map((d, id) => ({ id, ...d })));
  }
}

module.exports = ChatIndex;
