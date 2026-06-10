#!/usr/bin/env node
import { promises as fs } from 'node:fs';
import path from 'node:path';

const RSS_URL = 'https://feeds.buzzsprout.com/2241079.rss';

const decodeEntities = (value = '') =>
  value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x2F;/g, '/');

const stripHtml = (value = '') =>
  decodeEntities(
    value
      .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  );

const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function getTagText(xml, tagName) {
  const rx = new RegExp(`<${escapeRegex(tagName)}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${escapeRegex(tagName)}>`, 'i');
  const match = xml.match(rx);
  if (!match) return null;
  return match[1].trim();
}

function getAttr(xml, tagName, attrName) {
  const rx = new RegExp(`<${escapeRegex(tagName)}\\b[^>]*\\s${escapeRegex(attrName)}="([^"]+)"[^>]*>`, 'i');
  const match = xml.match(rx);
  return match ? match[1].trim() : null;
}

function extractEpisodeNumber(itemXml, title) {
  const explicit = getTagText(itemXml, 'itunes:episode');
  if (explicit && /^\d+$/.test(explicit.trim())) return Number(explicit.trim());
  const fromTitle = String(title || '').match(/(?:episode|ep\.?)[\s#:-]*(\d{1,4})/i);
  return fromTitle ? Number(fromTitle[1]) : null;
}

function parseEpisodes(xml) {
  const items = xml.match(/<item\b[\s\S]*?<\/item>/gi) || [];

  const episodes = items
    .map((item) => {
      const title = stripHtml(getTagText(item, 'title') || 'Untitled Episode');
      const descriptionRaw = getTagText(item, 'content:encoded') || getTagText(item, 'description') || '';
      const description = stripHtml(descriptionRaw);
      const pubDate = getTagText(item, 'pubDate');
      const publishedAt = pubDate && !Number.isNaN(Date.parse(pubDate)) ? new Date(pubDate).toISOString() : null;
      const audioUrl = getAttr(item, 'enclosure', 'url');
      const episodeNumber = extractEpisodeNumber(item, title);
      const guid = stripHtml(getTagText(item, 'guid') || '');
      const duration = stripHtml(getTagText(item, 'itunes:duration') || '');

      return {
        id: guid || audioUrl || title,
        title,
        description,
        descriptionExcerpt: description.slice(0, 240),
        publishDate: pubDate || null,
        publishedAt,
        audioUrl,
        episodeNumber,
        duration: duration || null,
      };
    })
    .filter((episode) => episode.audioUrl)
    .sort((a, b) => {
      const aTime = a.publishedAt ? Date.parse(a.publishedAt) : 0;
      const bTime = b.publishedAt ? Date.parse(b.publishedAt) : 0;
      return bTime - aTime;
    });

  return episodes;
}

async function main() {
  const response = await fetch(RSS_URL, { headers: { Accept: 'application/rss+xml, application/xml;q=0.9, */*;q=0.8' } });
  if (!response.ok) {
    throw new Error(`Failed to fetch RSS: ${response.status} ${response.statusText}`);
  }

  const xml = await response.text();
  const feedTitle = stripHtml(getTagText(xml, 'title') || 'The Koerner Office');
  const feedDescription = stripHtml(getTagText(xml, 'description') || '');
  const siteUrl = stripHtml(getTagText(xml, 'link') || '');

  const episodes = parseEpisodes(xml);

  const payload = {
    generatedAt: new Date().toISOString(),
    source: RSS_URL,
    feed: {
      title: feedTitle,
      description: feedDescription,
      siteUrl,
    },
    totalEpisodes: episodes.length,
    episodes,
  };

  const outDir = path.join(process.cwd(), 'data');
  await fs.mkdir(outDir, { recursive: true });
  const outPath = path.join(outDir, 'tko-intel.json');
  await fs.writeFile(outPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');

  console.log(`Generated data/tko-intel.json with ${episodes.length} podcast episodes.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
