#!/usr/bin/env node
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { enrichEpisodesWithIntel } from './transcribe-and-extract.mjs';

const RSS_URL = 'https://feeds.buzzsprout.com/2241079.rss';

const ENTITY_MAP = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&#x2F;': '/',
  '&nbsp;': ' ',
};

const decodeEntities = (value = '') => value.replace(/&amp;|&lt;|&gt;|&quot;|&#39;|&#x2F;|&nbsp;/g, (m) => ENTITY_MAP[m] || m);

const stripHtml = (value = '') =>
  decodeEntities(
    String(value)
      .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  );

const escapeRegex = (value = '') => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function getTagText(xml, tagName) {
  const rx = new RegExp(`<${escapeRegex(tagName)}(?:\\s[^>]*)?>([\\s\\S]*?)<\/${escapeRegex(tagName)}>`, 'i');
  const match = xml.match(rx);
  return match ? match[1].trim() : null;
}

function getAllTagTexts(xml, tagName) {
  const rx = new RegExp(`<${escapeRegex(tagName)}(?:\\s[^>]*)?>([\\s\\S]*?)<\/${escapeRegex(tagName)}>`, 'gi');
  return [...xml.matchAll(rx)].map((m) => m[1].trim()).filter(Boolean);
}

function getAttr(xml, tagName, attrName) {
  const rx = new RegExp(`<${escapeRegex(tagName)}\\b[^>]*\\s${escapeRegex(attrName)}="([^"]+)"[^>]*>`, 'i');
  const match = xml.match(rx);
  return match ? match[1].trim() : null;
}

function parseDurationToSeconds(rawDuration = '') {
  const value = String(rawDuration).trim();
  if (!value) return null;

  if (/^\d+$/.test(value)) return Number(value);

  const parts = value.split(':').map((p) => Number(p));
  if (parts.some((n) => Number.isNaN(n))) return null;

  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return null;
}

function formatDuration(seconds) {
  const s = Number(seconds);
  if (!Number.isFinite(s) || s <= 0) return null;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = Math.floor(s % 60);
  if (h) return `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
  return `${m}:${String(r).padStart(2, '0')}`;
}

function extractEpisodeNumber(itemXml, title) {
  const explicit = getTagText(itemXml, 'itunes:episode');
  if (explicit && /^\d+$/.test(explicit)) return Number(explicit);

  const fromTitle = String(title || '').match(/(?:episode|ep\.?)[\s#:-]*(\d{1,4})/i);
  return fromTitle ? Number(fromTitle[1]) : null;
}

function extractEpisodeTags(itemXml, title, description) {
  const rawCategories = getAllTagTexts(itemXml, 'category').map(stripHtml);

  const topicHints = [
    'AI', 'Side Hustle', 'Business Ideas', 'Service Business', 'Marketing', 'Agency',
    'Startup', 'Investing', 'Sales', 'Growth', 'Automation', 'Local Business',
  ];

  const hay = `${title || ''} ${description || ''}`.toLowerCase();
  topicHints.forEach((hint) => {
    if (hay.includes(hint.toLowerCase())) rawCategories.push(hint);
  });

  return [...new Set(rawCategories.map((x) => x.trim()).filter(Boolean))].slice(0, 8);
}

function cleanDescription(raw = '') {
  return String(raw)
    .replace(/[\u200B-\u200D\u2060\uFEFF]/g, '')
    .replace(/\s*━\s*/g, ' — ')
    .replace(/\s+/g, ' ')
    .trim();
}

function getDescriptionExcerpt(description = '') {
  let cleaned = cleanDescription(String(description).replace(/https?:\/\/\S+/gi, '').trim());
  if (!cleaned) return '';

  const narrativeStarts = ['i sat down', 'in this episode', 'today i', 'we talked'];
  const lower = cleaned.toLowerCase();
  for (const marker of narrativeStarts) {
    const index = lower.indexOf(marker);
    if (index > 12) {
      cleaned = cleaned.slice(index);
      break;
    }
  }

  cleaned = cleaned.replace(/\s+-{3,}.*$/i, '').trim();

  const max = 270;
  if (cleaned.length <= max) return cleaned;

  const clipped = cleaned.slice(0, max);
  const lastBreak = Math.max(clipped.lastIndexOf('. '), clipped.lastIndexOf('! '), clipped.lastIndexOf('? '));
  if (lastBreak > 140) return clipped.slice(0, lastBreak + 1).trim();

  const lastSpace = clipped.lastIndexOf(' ');
  return `${clipped.slice(0, Math.max(lastSpace, 180)).trim()}…`;
}

function parseEpisodes(xml) {
  const items = xml.match(/<item\b[\s\S]*?<\/item>/gi) || [];

  return items
    .map((item) => {
      const title = stripHtml(getTagText(item, 'title') || 'Untitled Episode');
      const descriptionRaw = getTagText(item, 'content:encoded') || getTagText(item, 'description') || getTagText(item, 'itunes:summary') || '';
      const description = cleanDescription(stripHtml(descriptionRaw));
      const pubDate = getTagText(item, 'pubDate');
      const publishedAt = pubDate && !Number.isNaN(Date.parse(pubDate)) ? new Date(pubDate).toISOString() : null;
      const audioUrl = getAttr(item, 'enclosure', 'url');
      const guid = stripHtml(getTagText(item, 'guid') || '');
      const durationRaw = stripHtml(getTagText(item, 'itunes:duration') || '');
      const durationSeconds = parseDurationToSeconds(durationRaw);
      const episodeNumber = extractEpisodeNumber(item, title);
      const tags = extractEpisodeTags(item, title, description);

      return {
        id: guid || audioUrl || title,
        title,
        description,
        descriptionExcerpt: getDescriptionExcerpt(description),
        publishDate: pubDate || null,
        publishedAt,
        audioUrl,
        episodeNumber,
        duration: durationRaw || null,
        durationSeconds,
        durationLabel: formatDuration(durationSeconds) || durationRaw || null,
        tags,
      };
    })
    .filter((episode) => episode.audioUrl)
    .sort((a, b) => {
      const ta = a.publishedAt ? Date.parse(a.publishedAt) : 0;
      const tb = b.publishedAt ? Date.parse(b.publishedAt) : 0;
      return tb - ta;
    });
}

function parseFeedMeta(xml) {
  const channel = (xml.match(/<channel\b[\s\S]*?<\/channel>/i) || [null])[0] || xml;
  return {
    title: stripHtml(getTagText(channel, 'title') || getTagText(xml, 'title') || 'The Koerner Office'),
    description: stripHtml(getTagText(channel, 'description') || getTagText(xml, 'description') || ''),
    siteUrl: stripHtml(getTagText(channel, 'link') || getTagText(xml, 'link') || ''),
    image: getAttr(channel, 'itunes:image', 'href') || null,
    lastBuildDate: stripHtml(getTagText(channel, 'lastBuildDate') || ''),
  };
}

async function main() {
  const response = await fetch(RSS_URL, {
    headers: { Accept: 'application/rss+xml, application/xml;q=0.9, */*;q=0.8' },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch RSS: ${response.status} ${response.statusText}`);
  }

  const xml = await response.text();
  let episodes = parseEpisodes(xml);

  const intelResult = await enrichEpisodesWithIntel(episodes, {
    maxEpisodes: Number(process.env.TKO_INTEL_MAX_EPISODES || 2),
    force: process.env.TKO_INTEL_FORCE === '1',
    whisperModel: process.env.WHISPER_MODEL || 'tiny.en',
  });
  episodes = intelResult.episodes;

  const payload = {
    generatedAt: new Date().toISOString(),
    source: RSS_URL,
    feed: parseFeedMeta(xml),
    intelligenceMeta: {
      processedEpisodes: intelResult.processed,
      whisperModel: process.env.WHISPER_MODEL || 'tiny.en',
      llmModel: process.env.OPENAI_API_KEY ? (process.env.OPENAI_MODEL || 'gpt-4o-mini') : 'heuristic-fallback',
      updatedAt: new Date().toISOString(),
    },
    totalEpisodes: episodes.length,
    episodes,
  };

  const outDir = path.join(process.cwd(), 'data');
  await fs.mkdir(outDir, { recursive: true });
  const outPath = path.join(outDir, 'tko-intel.json');
  await fs.writeFile(outPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');

  console.log(`Generated ${path.relative(process.cwd(), outPath)} with ${episodes.length} episodes (${intelResult.processed} analyzed).`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
