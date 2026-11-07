// /assets/js/webmcp.js: the site's tools. In-browser AI agents get them through WebMCP, and the
// localAI chat (webllm-chat.js) uses the same list as window.localaiTools.
(function () {
  const path = location.pathname;

  // Each tool can say where an agent should see it (`page`, default everywhere) and whether it
  // works on the page itself (`needsPage`), which the chat can only use when it's that page
  const tools = [];
  const add = (tool) => tools.push(tool);

  // Every tool replies in the MCP format: a list of text pieces
  const reply = (value) => ({ content: [{ type: "text", text: JSON.stringify(value) }] });
  const fail = (message) => ({ content: [{ type: "text", text: message }], isError: true });

  // Site data built by Eleventy (src/webmcp-data.11ty.js), fetched once and shared by all tools
  let dataPromise;
  const getData = () => (dataPromise ||= fetch("/webmcp-data.json").then((r) => r.json()));

  const isUpcoming = (event) => new Date(event.end) > new Date();
  // Spell the date out, weekday included, so a model doesn't have to work the day out itself
  const longDate = (d) => (d ? new Date(`${d}T12:00:00`).toLocaleDateString("en-AU", { weekday: "long", day: "numeric", month: "long", year: "numeric" }) : null);
  const eventSummary = (e) => ({ slug: e.slug, title: e.title, date: longDate(e.date), startTime: e.startTime, endTime: e.endTime, location: e.location, url: e.url });

  // On /events/<slug>/ the page itself tells us which event the visitor is looking at
  const currentEventSlug = (path.match(/^\/events\/([^/]+)\/?$/) || [])[1];

  // ---------- Every page ----------

  add({
    name: "get-site-info",
    description: "Get an overview of the localAI community website and links to its main pages.",
    inputSchema: { type: "object", properties: {} },
    async execute() {
      return reply({
        name: "localAI",
        about: "A community for people curious about running AI on their own computer. Offline, private, and free.",
        pages: {
          events: "/events/ (meetups and workshops)",
          posts: "/posts/ (news and recaps)",
          resources: "/resources/ (curated guides and tools)",
          community: "/community/ (group chats and newsletter)",
          contact: "/contact/"
        }
      });
    }
  });

  add({
    name: "search-site",
    description: "Search the localAI website (events, posts, resource guides) and return the best matching pages.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "What to search for, e.g. \"obsidian\" or \"canberra catchup\"." }
      },
      required: ["query"]
    },
    async execute({ query }) {
      try {
        const pagefind = await import("/pagefind/pagefind.js");
        const search = await pagefind.search(query);
        const results = await Promise.all(search.results.slice(0, 5).map((r) => r.data()));
        return reply(results.map((r) => ({ title: r.meta.title, url: r.url, excerpt: r.excerpt.replace(/<[^>]+>/g, "") })));
      } catch {
        return fail("Search is unavailable on this copy of the site (the search index is only built in production).");
      }
    }
  });

  add({
    name: "go-to-page",
    description: "Open a page on the localAI website, e.g. /events/, /community/, or an event or post URL from another tool. The page reloads, so this page's tools are replaced by the new page's tools.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Site path starting with /, e.g. \"/events/\" or \"/events/localai-catchup-canberra-aug15/\"." }
      },
      required: ["path"]
    },
    async execute({ path: to }) {
      if (!to.startsWith("/") || to.startsWith("//")) return fail("Only pages on this site are allowed. Use a path starting with /.");
      // Reply first, then navigate; navigating straight away would unload the page before the reply is sent
      setTimeout(() => { location.href = to; }, 100);
      return reply({ navigating: to });
    }
  });

  // ---------- Pages with event cards (home, events) ----------

  const eventCard = (slug) => {
    const link = document.querySelector(`.cosmos-event-card a[href="/events/${slug}/"]`);
    return link && link.closest(".cosmos-event-card");
  };

  {
    add({
      name: "show-event",
      page: () => !!document.querySelector(".cosmos-event-card"),
      needsPage: true,
      description: "Scroll to an event card on this page and highlight it so the visitor can see it. Leave the slug out to show the next upcoming event.",
      inputSchema: {
        type: "object",
        properties: {
          slug: { type: "string", description: "The event's slug from list-events, e.g. \"building-an-obsidian-brain\". Leave out for the next upcoming event." }
        }
      },
      async execute({ slug } = {}) {
        let card = slug && eventCard(slug);
        // No slug, or one that isn't on this page: fall back to the soonest upcoming event that is
        if (!card) {
          const { events } = await getData();
          const next = events.filter(isUpcoming).sort((a, b) => new Date(a.start) - new Date(b.start)).find((e) => eventCard(e.slug));
          if (next) {
            slug = next.slug;
            card = eventCard(slug);
          }
        }
        if (!card) return fail(`"${slug}" isn't on this page. Use go-to-page with "/events/${slug}/" to open it instead.`);
        document.querySelectorAll(".webmcp-highlight").forEach((el) => el.classList.remove("webmcp-highlight"));
        card.scrollIntoView({ behavior: "smooth", block: "center" });
        card.classList.add("webmcp-highlight");
        return reply({ shown: slug });
      }
    });
  }

  // ---------- Events pages ----------

  {
    const onEvents = () => path.startsWith("/events/");
    add({
      name: "list-events",
      page: onEvents,
      description: "List localAI community events (meetups, catchups, workshops) with date, time and location.",
      inputSchema: {
        type: "object",
        properties: {
          when: { type: "string", enum: ["upcoming", "past", "all"], description: "Which events to list. Defaults to upcoming." }
        }
      },
      async execute({ when = "upcoming" } = {}) {
        const { events } = await getData();
        const picked = when === "all" ? events : events.filter((e) => isUpcoming(e) === (when === "upcoming"));
        if (!picked.length) return reply({ events: [], note: `No ${when} events right now. Check /events/ or join the community chat for news.` });
        return reply({ events: picked.map(eventSummary) });
      }
    });

    add({
      name: "get-event",
      page: onEvents,
      description: "Get full details for one event. Use the slug from list-events, or leave it out on an event's own page.",
      inputSchema: {
        type: "object",
        properties: {
          slug: { type: "string", description: "The event's slug, e.g. \"localai-catchup-canberra-aug15\"." }
        }
      },
      async execute({ slug = currentEventSlug } = {}) {
        const { events } = await getData();
        if (!slug) return fail("Which event? Pass a slug from list-events.");
        const event = events.find((e) => e.slug === slug);
        if (!event) return fail(`No event found with slug "${slug}". Call list-events with when "all" to see valid slugs.`);
        const { googleCalendarUrl, icsDataUri, ...details } = event;
        return reply({ ...details, date: longDate(details.date), status: isUpcoming(event) ? "upcoming" : "past" });
      }
    });

    add({
      name: "get-calendar-link",
      page: onEvents,
      description: "Get links to add an event to a calendar (Google Calendar, or an .ics file for Apple Calendar and Outlook).",
      inputSchema: {
        type: "object",
        properties: {
          slug: { type: "string", description: "The event's slug. Leave it out on an event's own page." }
        }
      },
      async execute({ slug = currentEventSlug } = {}) {
        const { events } = await getData();
        if (!slug) return fail("Which event? Pass a slug from list-events.");
        const event = events.find((e) => e.slug === slug);
        if (!event) return fail(`No event found with slug "${slug}". Call list-events with when "all" to see valid slugs.`);
        if (!event.googleCalendarUrl) return fail(`"${event.title}" has no date and time set, so it can't be added to a calendar yet.`);
        return reply({ title: event.title, googleCalendar: event.googleCalendarUrl, icsFile: event.icsDataUri });
      }
    });

    const calendarMenu = document.querySelector(".cosmos-add-to-calendar");
    {
      add({
        name: "open-calendar-menu",
        page: () => onEvents() && !!calendarMenu,
        needsPage: true,
        description: "Open this event's \"Add to calendar\" menu on the page so the visitor can pick Google Calendar or Apple/Outlook.",
        inputSchema: { type: "object", properties: {} },
        async execute() {
          calendarMenu.open = true;
          calendarMenu.scrollIntoView({ behavior: "smooth", block: "center" });
          return reply({ opened: "Add to calendar menu. The visitor can now choose Google Calendar or Apple/Outlook (.ics)." });
        }
      });
    }
  }

  // ---------- Posts pages ----------

  {
    add({
      name: "list-posts",
      page: () => path.startsWith("/posts/"),
      description: "List posts from the localAI website (news, event recaps), newest first.",
      inputSchema: {
        type: "object",
        properties: {
          limit: { type: "integer", minimum: 1, maximum: 50, description: "How many posts to return. Defaults to 10." }
        }
      },
      async execute({ limit = 10 } = {}) {
        const { posts } = await getData();
        return reply({ posts: posts.slice(0, limit) });
      }
    });
  }

  // ---------- Resources pages ----------

  {
    add({
      name: "list-resources",
      page: () => path.startsWith("/resources/"),
      description: "List the curated local AI resource guides (getting started, models, coding, speech, home labbing and more) and the tools each one recommends.",
      inputSchema: {
        type: "object",
        properties: {
          guide: { type: "string", description: "Only return one guide, by slug, e.g. \"getting-started\" or \"models\". Leave out to list every guide." }
        }
      },
      async execute({ guide } = {}) {
        const { resources } = await getData();
        if (!guide) return reply({ guides: resources.map(({ resources: tools, ...g }) => ({ ...g, toolCount: tools.length })) });
        const match = resources.find((g) => g.slug === guide);
        if (!match) return fail(`No guide "${guide}". Valid guides: ${resources.map((g) => g.slug).join(", ")}.`);
        return reply(match);
      }
    });
  }

  // ---------- Community page ----------

  {
    add({
      name: "get-community-links",
      page: () => path.startsWith("/community/"),
      description: "Get the links to join the localAI group chat. The chats are bridged, so joining on any one platform reaches everyone.",
      inputSchema: {
        type: "object",
        properties: {
          platform: { type: "string", description: "Only return the link for this platform, e.g. \"Discord\" or \"Signal\"." }
        }
      },
      async execute({ platform } = {}) {
        const { community } = await getData();
        const platforms = community.platforms.filter((p) => p.active && (!platform || p.name.toLowerCase() === platform.toLowerCase()));
        if (!platforms.length) return fail(`${platform} isn't available yet.`);
        return reply({ platforms });
      }
    });
  }

  // ---------- Hand the tools out ----------

  const onThisPage = (t) => !t.page || t.page();
  const strip = ({ page, needsPage, ...tool }) => tool;

  // The chat runs on every page, so it gets every tool except ones that act on a different page
  window.localaiTools = tools.filter((t) => !t.needsPage || onThisPage(t)).map(strip);

  const mc = document.modelContext;
  if (mc) tools.filter(onThisPage).forEach((t) => mc.registerTool(strip(t)));
})();
