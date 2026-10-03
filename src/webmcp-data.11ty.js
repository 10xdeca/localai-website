// /webmcp-data.json: site data for the WebMCP tools in /assets/js/webmcp.js, generated at build time
class WebMCPData {
  data() {
    return {
      permalink: "/webmcp-data.json",
      eleventyExcludeFromCollections: true
    };
  }

  render({ collections, focusAreas, community }) {
    const events = collections.events.map(e => {
      const d = e.data;
      return {
        slug: e.fileSlug,
        title: d.title,
        description: d.description,
        date: this.formatDate(d.eventDate, "YYYY-MM-DD"),
        startTime: d.startTime || null,
        endTime: d.endTime || null,
        start: this.eventStartISO(d.eventDate, d.startTime),
        end: this.eventEndISO(d.eventDate, d.startTime, d.endTime),
        location: d.location ? d.location.replace(/\n/g, ", ") : null,
        url: e.url,
        googleCalendarUrl: this.googleCalendarUrl(d.title, d.description, d.location, d.eventDate, d.startTime, d.endTime, e.url) || null,
        icsDataUri: this.icsDataUri(d.title, d.description, d.location, d.eventDate, d.startTime, d.endTime, e.url, e.fileSlug) || null
      };
    });

    const posts = collections.posts.map(p => ({
      title: p.data.title,
      description: p.data.description,
      date: this.formatDate(p.data.postDate, "YYYY-MM-DD"),
      author: p.data.author || null,
      url: p.url
    }));

    const resources = focusAreas.areas.map(a => ({
      slug: a.slug,
      title: a.title,
      summary: a.lead,
      url: a.href,
      resources: (a.resources || []).map(r => ({
        name: r.name,
        description: r.description,
        tags: r.tags || [],
        website: r.website || null
      }))
    }));

    const platforms = community.platforms.map(p => ({
      name: p.name,
      joinUrl: p.active ? p.joinHref : null,
      active: !!p.active
    }));

    return JSON.stringify({ events, posts, resources, community: { platforms } }, null, 2);
  }
}

module.exports = WebMCPData;
