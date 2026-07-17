const dayjs = require('dayjs');
const advancedFormat = require('dayjs/plugin/advancedFormat');
const isSameOrAfter = require('dayjs/plugin/isSameOrAfter');
const isSameOrBefore = require('dayjs/plugin/isSameOrBefore');
const utc = require('dayjs/plugin/utc');
const timezone = require('dayjs/plugin/timezone');
const customParseFormat = require('dayjs/plugin/customParseFormat');
const fs = require('fs');
const path = require('path');
const markdownIt = require('markdown-it');
const md = markdownIt({ html: true, linkify: true });

dayjs.extend(advancedFormat);
dayjs.extend(isSameOrAfter);
dayjs.extend(isSameOrBefore);
dayjs.extend(utc);
dayjs.extend(timezone);
dayjs.extend(customParseFormat);

module.exports = function (eleventyConfig) {
  // Load site data for timezone and date format
  const siteData = JSON.parse(fs.readFileSync('./src/_data/site.json', 'utf8'));
  const SITE_TIMEZONE = siteData.timezone || 'Australia/Sydney';
  const DEFAULT_DATE_FORMAT = siteData.dateFormat || 'dddd, Do MMMM YYYY';
  const SITE_URL = 'https://localai.xdeca.com';

  // Parse an event date + a "1:00 PM" / "9:00AM" / "13:00" style time string
  // into a timezone-aware dayjs instant, in the configured SITE_TIMEZONE.
  function parseEventDateTime(eventDate, timeStr) {
    if (!eventDate) return null;
    const dateOnly = dayjs.utc(eventDate).format('YYYY-MM-DD');

    if (!timeStr) {
      const dayStart = dayjs.tz(dateOnly, 'YYYY-MM-DD', SITE_TIMEZONE);
      return dayStart.isValid() ? dayStart : null;
    }

    // Normalise "9:00AM" -> "9:00 AM" so the "h:mm A" format matches
    const ts = timeStr.toString().trim().replace(/(\d)(am|pm)$/i, '$1 $2');
    let candidate = dayjs.tz(`${dateOnly} ${ts}`, 'YYYY-MM-DD h:mm A', SITE_TIMEZONE);
    if (!candidate.isValid()) {
      candidate = dayjs.tz(`${dateOnly} ${ts}`, 'YYYY-MM-DD H:mm', SITE_TIMEZONE);
    }
    return candidate.isValid() ? candidate : null;
  }

  function formatICSDateTime(d) {
    return d.utc().format('YYYYMMDD[T]HHmmss[Z]');
  }

  function escapeICSText(str) {
    return String(str || '')
      .replace(/\\/g, '\\\\')
      .replace(/;/g, '\\;')
      .replace(/,/g, '\\,')
      .replace(/\r\n|\n|\r/g, '\\n');
  }

  // RFC5545 line folding: continuation lines are prefixed with a space
  function foldICSLine(line) {
    const maxLen = 74;
    if (line.length <= maxLen) return line;
    let result = '';
    let i = 0;
    while (i < line.length) {
      const len = i === 0 ? maxLen : maxLen - 1;
      const chunk = line.slice(i, i + len);
      result += (i === 0 ? '' : '\r\n ') + chunk;
      i += chunk.length;
    }
    return result;
  }

  function buildICS({ title, description, location, pageUrl, start, end, uid }) {
    const lines = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//local AI//events//EN',
      'CALSCALE:GREGORIAN',
      'METHOD:PUBLISH',
      'BEGIN:VEVENT',
      `UID:${uid}@localai.xdeca.com`,
      `DTSTAMP:${formatICSDateTime(dayjs.utc())}`,
      `DTSTART:${formatICSDateTime(start)}`,
      `DTEND:${formatICSDateTime(end)}`,
      `SUMMARY:${escapeICSText(title)}`,
    ];
    if (description) lines.push(`DESCRIPTION:${escapeICSText(description)}`);
    if (location) lines.push(`LOCATION:${escapeICSText(location.replace(/\n/g, ', '))}`);
    if (pageUrl) lines.push(`URL:${SITE_URL}${pageUrl}`);
    lines.push('END:VEVENT', 'END:VCALENDAR');
    return lines.map(foldICSLine).join('\r\n');
  }

  // An event isn't "past" until this long after its end time, since the
  // site is a static build and shouldn't flip an event to "past" the
  // instant it ends.
  const PAST_EVENT_GRACE_HOURS = 1;

  // Helper function to get event end date/time, in SITE_TIMEZONE, with the
  // grace period applied. Reuses parseEventDateTime so events are always
  // interpreted in the site's configured timezone rather than whatever
  // timezone the machine building the site happens to be in.
  function getEventEndDateTime(event) {
    if (!event.data.eventDate) return null;

    if (event.data.endTime) {
      const endTime = parseEventDateTime(event.data.eventDate, event.data.endTime);
      if (endTime) return endTime.add(PAST_EVENT_GRACE_HOURS, 'hour');
      console.warn(`Invalid endTime for event: ${event.data.title || 'Unknown'} - ${event.data.endTime}`);
    }

    // No endTime (or invalid): treat the event as lasting the whole day,
    // in the site's timezone.
    const dateOnly = dayjs.utc(event.data.eventDate).format('YYYY-MM-DD');
    const dayEnd = dayjs.tz(dateOnly, 'YYYY-MM-DD', SITE_TIMEZONE).endOf('day');
    if (!dayEnd.isValid()) {
      console.warn(`Invalid eventDate for event: ${event.data.title || 'Unknown'} - ${event.data.eventDate}`);
      return null;
    }
    return dayEnd.add(PAST_EVENT_GRACE_HOURS, 'hour');
  }

  //admin is left unprocessed and copied to site
  eleventyConfig.ignores.add("src/admin/index.html");
  eleventyConfig.ignores.add("src/admin/**/*.html");
  eleventyConfig.addPassthroughCopy("src/admin");

  eleventyConfig.addPassthroughCopy({ "src/assets": "assets" });
  eleventyConfig.addPassthroughCopy({ "src/robots.txt": "robots.txt" });

  // Gallery images reader
  eleventyConfig.addGlobalData('galleries', function() {
    const galleries = {};
    
    function scanGalleryDirectory(dirPath, filterPrefix = null) {
      const fullPath = path.join(__dirname, 'src', dirPath);
      
      try {
        if (!fs.existsSync(fullPath)) {
          console.log(`Gallery directory not found: ${dirPath}`);
          return [];
        }
        
        const files = fs.readdirSync(fullPath);
        const imageExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg'];
        
        let images = files.filter(file => {
          const ext = path.extname(file).toLowerCase();
          return imageExtensions.includes(ext);
        });
        
        // Filter by prefix if provided (e.g., 'gallery-')
        if (filterPrefix) {
          images = images.filter(file => file.startsWith(filterPrefix));
        }
        
        images.sort();
        
        if (images.length === 0) {
          console.log(`No images found in ${dirPath}${filterPrefix ? ' with prefix "' + filterPrefix + '"' : ''}`);
        } else {
          console.log(`Found ${images.length} images in ${dirPath}${filterPrefix ? ' with prefix "' + filterPrefix + '"' : ''}`);
        }
        
        return images;
      } catch (error) {
        console.error(`Error reading gallery directory ${dirPath}:`, error.message);
        return [];
      }
    }
    
    // Register a gallery path scanner
    galleries.scan = function(dirPath, filterPrefix = null) {
      const key = dirPath + (filterPrefix || '');
      if (!galleries[key]) {
        galleries[key] = scanGalleryDirectory(dirPath, filterPrefix);
      }
      return galleries[key];
    };
    
    return galleries;
  });

  // All events (sorted by date ascending)
  eleventyConfig.addCollection("events", function (collectionApi) {
    return collectionApi.getFilteredByGlob("src/events/*.md")
      .sort((a, b) => new Date(a.data.eventDate) - new Date(b.data.eventDate));
  });

  eleventyConfig.addCollection("posts", function (collectionApi) {
    return collectionApi.getFilteredByGlob("src/posts/*.md")
      .sort((a, b) => new Date(b.data.postDate) - new Date(a.data.postDate));
  });

  // Upcoming events (event hasn't ended yet)
  eleventyConfig.addCollection("upcomingEvents", function (collectionApi) {
    const now = dayjs().tz(SITE_TIMEZONE);
    return collectionApi.getFilteredByGlob("src/events/*.md")
      .filter(e => {
        const endDateTime = getEventEndDateTime(e);
        return endDateTime && endDateTime.isAfter(now);
      })
      .sort((a, b) => new Date(a.data.eventDate) - new Date(b.data.eventDate));
  });

  // Past events (event has ended)
  eleventyConfig.addCollection("pastEvents", function (collectionApi) {
    const now = dayjs().tz(SITE_TIMEZONE);
    return collectionApi.getFilteredByGlob("src/events/*.md")
      .filter(e => {
        const endDateTime = getEventEndDateTime(e);
        return endDateTime && endDateTime.isSameOrBefore(now);
      })
      .sort((a, b) => new Date(b.data.eventDate) - new Date(a.data.eventDate));
  });

  // Featured events
  eleventyConfig.addCollection("featuredEvents", function (collectionApi) {
    return collectionApi.getFilteredByGlob("src/events/*.md")
      .filter(e => e.data.featured === true)
      .sort((a, b) => new Date(a.data.eventDate) - new Date(b.data.eventDate));
  });

  // Featured posts
  eleventyConfig.addCollection("featuredPosts", function (collectionApi) {
    return collectionApi.getFilteredByGlob("src/posts/*.md")
      .filter(p => p.data.featured === true)
      .sort((a, b) => new Date(b.data.postDate) - new Date(a.data.postDate));
  });

  // Preview events - upcoming only (excluding featured)
  eleventyConfig.addCollection("previewEvents", function (collectionApi) {
    const now = dayjs().tz(SITE_TIMEZONE);
    return collectionApi.getFilteredByGlob("src/events/*.md")
      .filter(e => {
        const endDateTime = getEventEndDateTime(e);
        return endDateTime && 
               endDateTime.isAfter(now) &&
               e.data.featured !== true;
      })
      .sort((a, b) => new Date(a.data.eventDate) - new Date(b.data.eventDate))
      .slice(0, 3);
  });

  // Preview events - upcoming only (including featured)
  eleventyConfig.addCollection("previewEventsAll", function (collectionApi) {
    const now = dayjs().tz(SITE_TIMEZONE);
    return collectionApi.getFilteredByGlob("src/events/*.md")
      .filter(e => {
        const endDateTime = getEventEndDateTime(e);
        return endDateTime && endDateTime.isAfter(now);
      })
      .sort((a, b) => new Date(a.data.eventDate) - new Date(b.data.eventDate))
      .slice(0, 3);
  });

  // Preview events - combined past and upcoming (excluding featured)
  eleventyConfig.addCollection("previewEventsCombined", function (collectionApi) {
    const now = dayjs().tz(SITE_TIMEZONE);
    const allEvents = collectionApi.getFilteredByGlob("src/events/*.md")
      .filter(e => e.data.eventDate && e.data.featured !== true);
    
    const upcoming = allEvents
      .filter(e => {
        const endDateTime = getEventEndDateTime(e);
        return endDateTime && endDateTime.isAfter(now);
      })
      .sort((a, b) => new Date(a.data.eventDate) - new Date(b.data.eventDate))
      .slice(0, 2);
    
    const past = allEvents
      .filter(e => {
        const endDateTime = getEventEndDateTime(e);
        return endDateTime && endDateTime.isSameOrBefore(now);
      })
      .sort((a, b) => new Date(b.data.eventDate) - new Date(a.data.eventDate))
      .slice(0, 1);
    
    return [...upcoming, ...past];
  });

  // Preview events - combined past and upcoming (including featured)
  eleventyConfig.addCollection("previewEventsCombinedAll", function (collectionApi) {
    const now = dayjs().tz(SITE_TIMEZONE);
    const allEvents = collectionApi.getFilteredByGlob("src/events/*.md")
      .filter(e => e.data.eventDate);
    
    const upcoming = allEvents
      .filter(e => {
        const endDateTime = getEventEndDateTime(e);
        return endDateTime && endDateTime.isAfter(now);
      })
      .sort((a, b) => new Date(a.data.eventDate) - new Date(b.data.eventDate))
      .slice(0, 2);
    
    const past = allEvents
      .filter(e => {
        const endDateTime = getEventEndDateTime(e);
        return endDateTime && endDateTime.isSameOrBefore(now);
      })
      .sort((a, b) => new Date(b.data.eventDate) - new Date(a.data.eventDate))
      .slice(0, 1);
    
    return [...upcoming, ...past];
  });

  // Preview events - past only (excluding featured)
  eleventyConfig.addCollection("previewPastEvents", function (collectionApi) {
    const now = dayjs().tz(SITE_TIMEZONE);
    return collectionApi.getFilteredByGlob("src/events/*.md")
      .filter(e => {
        const endDateTime = getEventEndDateTime(e);
        return endDateTime && 
               endDateTime.isSameOrBefore(now) &&
               e.data.featured !== true;
      })
      .sort((a, b) => new Date(b.data.eventDate) - new Date(a.data.eventDate))
      .slice(0, 3);
  });

  // Preview events - past only (including featured)
  eleventyConfig.addCollection("previewPastEventsAll", function (collectionApi) {
    const now = dayjs().tz(SITE_TIMEZONE);
    return collectionApi.getFilteredByGlob("src/events/*.md")
      .filter(e => {
        const endDateTime = getEventEndDateTime(e);
        return endDateTime && endDateTime.isSameOrBefore(now);
      })
      .sort((a, b) => new Date(b.data.eventDate) - new Date(a.data.eventDate))
      .slice(0, 3);
  });

  // Preview events - upcoming only (excluding featured) - duplicate for consistency
  eleventyConfig.addCollection("previewUpcomingEvents", function (collectionApi) {
    const now = dayjs().tz(SITE_TIMEZONE);
    return collectionApi.getFilteredByGlob("src/events/*.md")
      .filter(e => {
        const endDateTime = getEventEndDateTime(e);
        return endDateTime && 
               endDateTime.isAfter(now) &&
               e.data.featured !== true;
      })
      .sort((a, b) => new Date(a.data.eventDate) - new Date(b.data.eventDate))
      .slice(0, 3);
  });

  // Preview events - upcoming only (including featured) - duplicate for consistency
  eleventyConfig.addCollection("previewUpcomingEventsAll", function (collectionApi) {
    const now = dayjs().tz(SITE_TIMEZONE);
    return collectionApi.getFilteredByGlob("src/events/*.md")
      .filter(e => {
        const endDateTime = getEventEndDateTime(e);
        return endDateTime && endDateTime.isAfter(now);
      })
      .sort((a, b) => new Date(a.data.eventDate) - new Date(b.data.eventDate))
      .slice(0, 3);
  });

  // Preview posts (excluding featured by default)
  eleventyConfig.addCollection("previewPosts", function (collectionApi) {
    return collectionApi.getFilteredByGlob("src/posts/*.md")
      .filter(p => p.data.featured !== true) // hide featured
      .sort((a, b) => new Date(b.data.postDate) - new Date(a.data.postDate))
      .slice(0, 3);
  });

  // Preview posts (including featured)
  eleventyConfig.addCollection("previewPostsAll", function (collectionApi) {
    return collectionApi.getFilteredByGlob("src/posts/*.md")
      .sort((a, b) => new Date(b.data.postDate) - new Date(a.data.postDate))
      .slice(0, 3);
  });

  // Consolidated galleries - all events and posts with gallery property, sorted by date (most recent first)
  // Each entry includes scanned image filenames for use in the all-images gallery
  eleventyConfig.addCollection("consolidatedGalleries", function (collectionApi) {
    const imageExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg'];

    function scanDir(dirPath) {
      const cleanPath = dirPath.replace(/^\//, '');
      const fullPath = path.join(__dirname, 'src', cleanPath);
      try {
        if (!fs.existsSync(fullPath)) return [];
        return fs.readdirSync(fullPath)
          .filter(f => imageExtensions.includes(path.extname(f).toLowerCase()))
          .sort();
      } catch { return []; }
    }

    const events = collectionApi.getFilteredByGlob("src/events/*.md")
      .filter(e => e.data.gallery)
      .map(e => {
        const galleryPath = e.data.gallery.replace(/^\//, '');
        return {
          date: new Date(e.data.eventDate),
          type: 'event',
          pageTitle: e.data.title,
          gallery: galleryPath,
          url: e.url,
          images: scanDir(galleryPath)
        };
      });
    
    const posts = collectionApi.getFilteredByGlob("src/posts/*.md")
      .filter(p => p.data.gallery)
      .map(p => {
        const galleryPath = p.data.gallery.replace(/^\//, '');
        return {
          date: new Date(p.data.postDate),
          type: 'post',
          pageTitle: p.data.title,
          gallery: galleryPath,
          url: p.url,
          images: scanDir(galleryPath)
        };
      });
    
    return [...events, ...posts]
      .sort((a, b) => b.date - a.date);
  });

  // Recent activity - past events and posts mixed together, sorted by date (most recent first)
  eleventyConfig.addCollection("recentActivity", function (collectionApi) {
    const now = dayjs().tz(SITE_TIMEZONE);

    const pastEvents = collectionApi.getFilteredByGlob("src/events/*.md")
      .filter(e => {
        const endDateTime = getEventEndDateTime(e);
        return endDateTime && endDateTime.isSameOrBefore(now);
      })
      .map(e => ({ type: 'event', date: new Date(e.data.eventDate), item: e }));

    const posts = collectionApi.getFilteredByGlob("src/posts/*.md")
      .map(p => ({ type: 'post', date: new Date(p.data.postDate), item: p }));

    return [...pastEvents, ...posts]
      .sort((a, b) => b.date - a.date)
      .slice(0, 3);
  });

  // Date formatting filter - uses site.json dateFormat as default
  eleventyConfig.addFilter("formatDate", function (dateInput, format) {
    if (!dateInput) return '';
    try {
      // Use provided format, or fall back to site default
      // Parse as UTC so plain calendar dates (e.g. "2026-07-04") don't shift
      // to the previous/next day when the build machine's local timezone differs from UTC.
      const dateFormat = format || DEFAULT_DATE_FORMAT;
      const parsed = dayjs.utc(dateInput);
      return parsed.isValid() ? parsed.format(dateFormat) : String(dateInput);
    } catch (err) {
      console.warn(`Error formatting date: ${dateInput} - ${err.message}`);
      return String(dateInput);
    }
  });

  // Google Calendar "add event" link, built from event frontmatter
  eleventyConfig.addNunjucksGlobal("googleCalendarUrl", function (title, description, location, eventDate, startTime, endTime, pageUrl) {
    const start = parseEventDateTime(eventDate, startTime);
    if (!start) return '';
    const end = endTime ? parseEventDateTime(eventDate, endTime) : start.add(1, 'hour');

    let details = description || '';
    if (pageUrl) details += `${details ? '\n\n' : ''}More info: ${SITE_URL}${pageUrl}`;

    const params = new URLSearchParams({
      action: 'TEMPLATE',
      text: title || '',
      dates: `${formatICSDateTime(start)}/${formatICSDateTime(end)}`,
      details,
      ctz: SITE_TIMEZONE,
    });
    if (location) params.set('location', location.replace(/\n/g, ', '));

    return `https://calendar.google.com/calendar/render?${params.toString()}`;
  });

  // .ics download (data URI) for Apple Calendar / Outlook / anything else, built from event frontmatter
  eleventyConfig.addNunjucksGlobal("icsDataUri", function (title, description, location, eventDate, startTime, endTime, pageUrl, slug) {
    const start = parseEventDateTime(eventDate, startTime);
    if (!start) return '';
    const end = endTime ? parseEventDateTime(eventDate, endTime) : start.add(1, 'hour');

    const ics = buildICS({ title, description, location, pageUrl, start, end, uid: slug || 'event' });
    return `data:text/calendar;charset=utf8,${encodeURIComponent(ics)}`;
  });

  // Concat filter for Nunjucks
  eleventyConfig.addFilter("concat", function (arr1, arr2) {
    if (!Array.isArray(arr1)) arr1 = [];
    if (!Array.isArray(arr2)) arr2 = [];
    return arr1.concat(arr2);
  });

  // Check if rendered content already contains a manually placed gallery
  eleventyConfig.addFilter("hasGallery", function(content) {
    return content && content.includes('<div class="gallery">');
  });

  // Strip leading slash from a path
  eleventyConfig.addFilter("stripLeadingSlash", function(str) {
    return str ? str.replace(/^\//, '') : str;
  });

  // JSON stringify filter
  eleventyConfig.addFilter("jsonify", function(value) {
    return JSON.stringify(value);
  });

  // Find an item in an array by key/value
  eleventyConfig.addFilter("find", function(arr, key, value) {
    if (!Array.isArray(arr)) return null;
    return arr.find(item => item[key] === value) || null;
  });

  // Markdown filter for rendering README content
  eleventyConfig.addFilter("markdown", function(content) {
    return md.render(content);
  });

  return {
    dir: {
      input: "src",
      includes: "_includes",
      layouts: "_includes/layouts",
      data: "_data",
      output: "_site"
    },
    markdownTemplateEngine: "njk",
    htmlTemplateEngine: "njk"
  };
};