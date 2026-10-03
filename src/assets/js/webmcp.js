// /assets/js/webmcp.js: exposes site tools to in-browser AI agents via WebMCP
(function () {
  const mc = document.modelContext;
  if (!mc) return;

  const path = location.pathname;

  // Every tool replies in the MCP format: a list of text pieces
  const reply = (value) => ({ content: [{ type: "text", text: JSON.stringify(value) }] });
  const fail = (message) => ({ content: [{ type: "text", text: message }], isError: true });

  // Site data built by Eleventy (src/webmcp-data.11ty.js), fetched once and shared by all tools
  let dataPromise;
  const getData = () => (dataPromise ||= fetch("/webmcp-data.json").then((r) => r.json()));

  const isUpcoming = (event) => new Date(event.end) > new Date();
  const eventSummary = (e) => ({ slug: e.slug, title: e.title, date: e.date, startTime: e.startTime, endTime: e.endTime, location: e.location, url: e.url });

  // On /events/<slug>/ the page itself tells us which event the visitor is looking at
  const currentEventSlug = (path.match(/^\/events\/([^/]+)\/?$/) || [])[1];

  // ---------- Every page ----------

  mc.registerTool({
    name: "get-site-info",
    description: "Get an overview of the local AI community website and links to its main pages.",
    inputSchema: { type: "object", properties: {} },
    async execute() {
      return reply({
        name: "local AI",
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

  mc.registerTool({
    name: "search-site",
    description: "Search the local AI website (events, posts, resource guides) and return the best matching pages.",
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

  mc.registerTool({
    name: "go-to-page",
    description: "Open a page on the local AI website, e.g. /events/, /community/, or an event or post URL from another tool. The page reloads, so this page's tools are replaced by the new page's tools.",
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

  if (document.querySelector(".cosmos-event-card")) {
    mc.registerTool({
      name: "show-event",
      description: "Scroll to an event card on this page and highlight it so the visitor can see it.",
      inputSchema: {
        type: "object",
        properties: {
          slug: { type: "string", description: "The event's slug, e.g. \"building-an-obsidian-brain\"." }
        },
        required: ["slug"]
      },
      async execute({ slug }) {
        const card = eventCard(slug);
        if (!card) return fail(`"${slug}" isn't on this page. Use go-to-page with "/events/${slug}/" to open it instead.`);
        document.querySelectorAll(".webmcp-highlight").forEach((el) => el.classList.remove("webmcp-highlight"));
        card.scrollIntoView({ behavior: "smooth", block: "center" });
        card.classList.add("webmcp-highlight");
        return reply({ shown: slug });
      }
    });
  }

  // ---------- Events pages ----------

  if (path.startsWith("/events/")) {
    mc.registerTool({
      name: "list-events",
      description: "List local AI community events (meetups, catchups, workshops) with date, time and location.",
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

    mc.registerTool({
      name: "get-event",
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
        return reply({ ...details, status: isUpcoming(event) ? "upcoming" : "past" });
      }
    });

    mc.registerTool({
      name: "get-calendar-link",
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
    if (calendarMenu) {
      mc.registerTool({
        name: "open-calendar-menu",
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

  if (path.startsWith("/posts/")) {
    mc.registerTool({
      name: "list-posts",
      description: "List posts from the local AI website (news, event recaps), newest first.",
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

  if (path.startsWith("/resources/")) {
    mc.registerTool({
      name: "list-resources",
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

  if (path.startsWith("/community/")) {
    mc.registerTool({
      name: "get-community-links",
      description: "Get the links to join the local AI group chat. The chats are bridged, so joining on any one platform reaches everyone.",
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
})();
