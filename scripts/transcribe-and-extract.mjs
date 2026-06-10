#!/usr/bin/env node
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { XMLParser } from 'fast-xml-parser';

const RSS_URL = process.env.TKO_RSS_URL || 'https://feeds.buzzsprout.com/2241079.rss';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const OPENAI_WHISPER_MODEL = process.env.OPENAI_WHISPER_MODEL || 'whisper-1';
const OPENAI_INTEL_MODEL = process.env.OPENAI_INTEL_MODEL || 'gpt-4o-mini';
const WHISPER_PROVIDER = (process.env.WHISPER_PROVIDER || 'auto').toLowerCase(); // auto | openai | local
const LOCAL_WHISPER_MODEL = process.env.LOCAL_WHISPER_MODEL || 'base.en';
const MAX_NEW_EPISODES = Number(process.env.MAX_NEW_EPISODES || 3);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT_DIR, 'data');
const CACHE_DIR = path.join(ROOT_DIR, '.cache', 'tko-audio');
const OUTPUT_FILE = path.join(DATA_DIR, 'tko-intel.json');
const PROCESSED_FILE = path.join(DATA_DIR, 'processed-episodes.json');

const EXTRACTION_PROMPT = `Extract all business ideas, opportunities, and actionable insights from this podcast transcript.

For each idea, provide:
- Name/title of the opportunity
- Category (AI business, Service business, Real estate, SaaS, Side hustle, etc.)
- Barrier level (Low $0-500, Medium $500-5K, High $5K+)
- Timeline (Days, Weeks, Months)
- Tools/services mentioned
- Revenue potential (if stated)
- Key insight (1-2 sentences)
- Match score for a UX designer with AI agent skills (1-10)

Format as JSON array.`;

function parseArgs(argv) {
  const out = { limit: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--limit') out.limit = Number(argv[i + 1] || 1);
    if (arg === '--feed') out.feed = argv[i + 1];
  }
  return out;
}

function sanitizeId(value = '') {
  const raw = String(value).trim();
  if (!raw) return createHash('sha1').update(raw + Math.random()).digest('hex').slice(0, 16);
  return raw.replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 80) || createHash('sha1').update(raw).digest('hex').slice(0, 16);
}

function toDateOnly(input) {
  const d = new Date(input);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

function stripHtml(text = '') {
  return String(text)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function ensureDirs() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.mkdir(CACHE_DIR, { recursive: true });
}

async function readJson(filePath, fallback) {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

async function saveJson(filePath, data) {
  await fs.writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

async function hasLocalWhisper() {
  return new Promise((resolve) => {
    const child = spawn('bash', ['-lc', 'command -v whisper >/dev/null 2>&1']);
    child.on('close', (code) => resolve(code === 0));
    child.on('error', () => resolve(false));
  });
}

async function fetchEpisodes(feedUrl) {
  const res = await fetch(feedUrl, { headers: { Accept: 'application/rss+xml, application/xml;q=0.9, */*;q=0.8' } });
  if (!res.ok) throw new Error(`RSS fetch failed: ${res.status} ${res.statusText}`);

  const xml = await res.text();
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '',
    parseTagValue: false,
    trimValues: true,
  });

  const parsed = parser.parse(xml);
  const channel = parsed?.rss?.channel;
  const items = Array.isArray(channel?.item) ? channel.item : (channel?.item ? [channel.item] : []);

  return items
    .map((item) => {
      const enclosure = item.enclosure || {};
      const guid = typeof item.guid === 'object' ? item.guid['#text'] : item.guid;
      const title = stripHtml(item.title || 'Untitled Episode');
      const audioUrl = enclosure.url || null;
      const pubDate = item.pubDate || null;
      const idBase = guid || item['itunes:episode'] || title || audioUrl;

      return {
        id: sanitizeId(idBase),
        title,
        date: toDateOnly(pubDate) || toDateOnly(new Date().toISOString()),
        audioUrl,
        description: stripHtml(item.description || item['content:encoded'] || item['itunes:summary'] || ''),
      };
    })
    .filter((ep) => ep.audioUrl)
    .sort((a, b) => (new Date(b.date).getTime() || 0) - (new Date(a.date).getTime() || 0));
}

async function runCommand(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} failed (${code}): ${stderr.trim()}`));
    });
  });
}

async function downloadAudio(url, episodeId) {
  const ext = path.extname(new URL(url).pathname) || '.mp3';
  const targetPath = path.join(CACHE_DIR, `${episodeId}${ext}`);
  try {
    await fs.access(targetPath);
    return targetPath;
  } catch {
    // continue
  }

  const headers = {
    Accept: 'audio/mpeg,audio/*;q=0.9,*/*;q=0.8',
    'User-Agent': 'Mozilla/5.0 (compatible; TKO-Intel/1.0)',
  };

  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const res = await fetch(url, { headers, redirect: 'follow' });
      if (!res.ok) throw new Error(`Audio download failed: ${res.status} ${res.statusText}`);
      const buffer = Buffer.from(await res.arrayBuffer());
      if (!buffer.length) throw new Error('Downloaded audio is empty');
      await fs.writeFile(targetPath, buffer);
      return targetPath;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
    }
  }

  try {
    await runCommand('curl', ['-L', '--fail', '--silent', '--show-error', '--output', targetPath, url]);
    return targetPath;
  } catch (curlError) {
    throw new Error(`Audio download failed after retries: ${lastError?.message || 'unknown error'}; curl fallback: ${curlError.message}`);
  }
}

async function transcribeWithOpenAI(audioPath) {
  if (!OPENAI_API_KEY) throw new Error('OPENAI_API_KEY missing for OpenAI transcription');

  const bytes = await fs.readFile(audioPath);
  const blob = new Blob([bytes]);
  const form = new FormData();
  form.append('file', blob, path.basename(audioPath));
  form.append('model', OPENAI_WHISPER_MODEL);

  const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
    body: form,
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`OpenAI transcription failed: ${res.status} ${res.statusText} - ${errText}`);
  }

  const json = await res.json();
  return String(json.text || '').trim();
}

async function transcribeWithLocalWhisper(audioPath, episodeId) {
  const transcriptPath = path.join(CACHE_DIR, `${episodeId}.txt`);

  await new Promise((resolve, reject) => {
    const args = [
      audioPath,
      '--model', LOCAL_WHISPER_MODEL,
      '--language', 'en',
      '--task', 'transcribe',
      '--output_format', 'txt',
      '--output_dir', CACHE_DIR,
      '--verbose', 'False',
      '--fp16', 'False',
    ];

    const child = spawn('whisper', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Local whisper failed (${code}): ${stderr.trim()}`));
    });
  });

  const text = await fs.readFile(transcriptPath, 'utf8');
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function extractJsonArray(rawText) {
  const text = String(rawText || '').trim();
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    const start = text.indexOf('[');
    const end = text.lastIndexOf(']');
    if (start === -1 || end === -1 || end <= start) return [];
    try {
      const parsed = JSON.parse(text.slice(start, end + 1));
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
}

async function extractIntelligence(transcript, episodeMeta) {
  if (!OPENAI_API_KEY) throw new Error('OPENAI_API_KEY missing for intelligence extraction');

  const input = `${EXTRACTION_PROMPT}\n\nEpisode: ${episodeMeta.title}\nDate: ${episodeMeta.date}\n\nTranscript:\n${transcript.slice(0, 120000)}`;

  const res = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: OPENAI_INTEL_MODEL,
      input,
      max_output_tokens: 2500,
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`OpenAI extraction failed: ${res.status} ${res.statusText} - ${errText}`);
  }

  const body = await res.json();
  const text = body.output_text
    || body?.output?.flatMap((o) => o?.content || []).map((c) => c?.text || '').join('\n')
    || '';

  return extractJsonArray(text);
}

function normalizeIdea(item) {
  const idea = item?.idea || item?.title || item?.name || item?.opportunity || 'Untitled opportunity';
  const category = item?.category || 'General';
  const barrier = item?.barrier || item?.barrierLevel || 'Medium';
  const timeline = item?.timeline || 'Weeks';
  const tools = Array.isArray(item?.tools) ? item.tools : (Array.isArray(item?.toolsNeeded) ? item.toolsNeeded : []);
  const revenue = item?.revenue || item?.revenuePotential || 'Not stated';
  const insight = item?.insight || item?.keyInsight || item?.notes || '';
  const scoreRaw = Number(item?.matchScore ?? item?.score ?? 5);

  return {
    idea: String(idea),
    category: String(category),
    barrier: String(barrier),
    timeline: String(timeline),
    tools: tools.map((t) => String(t)).slice(0, 10),
    revenue: String(revenue),
    insight: String(insight),
    matchScore: Math.min(10, Math.max(1, Number.isFinite(scoreRaw) ? Math.round(scoreRaw) : 5)),
  };
}

async function transcribeEpisode(audioPath, episodeId, localWhisperAvailable) {
  const useOpenAI = WHISPER_PROVIDER === 'openai' || (WHISPER_PROVIDER === 'auto' && !!OPENAI_API_KEY && !localWhisperAvailable);
  const useLocal = WHISPER_PROVIDER === 'local' || (WHISPER_PROVIDER === 'auto' && localWhisperAvailable);

  if (useOpenAI) return transcribeWithOpenAI(audioPath);
  if (useLocal) return transcribeWithLocalWhisper(audioPath, episodeId);

  if (OPENAI_API_KEY) return transcribeWithOpenAI(audioPath);
  throw new Error('No transcription provider available (set OPENAI_API_KEY or install local whisper)');
}

async function processEpisodes({ feedUrl, limit }) {
  await ensureDirs();

  const episodes = await fetchEpisodes(feedUrl);
  const output = await readJson(OUTPUT_FILE, { episodes: [] });
  const processedState = await readJson(PROCESSED_FILE, { processedEpisodeIds: [] });

  const processedIds = new Set(processedState.processedEpisodeIds || []);
  const outputById = new Map((output.episodes || []).map((ep) => [ep.id, ep]));

  const newEpisodes = episodes.filter((ep) => !processedIds.has(ep.id));
  const toProcess = newEpisodes.slice(0, Number.isFinite(limit) ? limit : MAX_NEW_EPISODES);
  const localWhisperAvailable = await hasLocalWhisper();

  let success = 0;
  let failed = 0;

  for (const ep of toProcess) {
    try {
      console.log(`Processing: ${ep.title}`);
      const audioPath = await downloadAudio(ep.audioUrl, ep.id);
      const transcript = await transcribeEpisode(audioPath, ep.id, localWhisperAvailable);

      let intelligence = [];
      try {
        intelligence = (await extractIntelligence(transcript, ep)).map(normalizeIdea);
      } catch (error) {
        console.warn(`Intelligence extraction failed for ${ep.id}: ${error.message}`);
      }

      outputById.set(ep.id, {
        id: ep.id,
        title: ep.title,
        date: ep.date,
        audioUrl: ep.audioUrl,
        transcript,
        intelligence,
      });

      processedIds.add(ep.id);
      success += 1;
    } catch (error) {
      failed += 1;
      console.warn(`Episode failed (${ep.id}): ${error.message}`);
      continue;
    }

    await saveJson(OUTPUT_FILE, {
      episodes: Array.from(outputById.values())
        .sort((a, b) => (new Date(b.date).getTime() || 0) - (new Date(a.date).getTime() || 0)),
    });

    await saveJson(PROCESSED_FILE, {
      processedEpisodeIds: Array.from(processedIds),
      updatedAt: new Date().toISOString(),
    });
  }

  return {
    discovered: episodes.length,
    newEpisodes: newEpisodes.length,
    attempted: toProcess.length,
    success,
    failed,
    outputFile: OUTPUT_FILE,
    processedFile: PROCESSED_FILE,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = await processEpisodes({
    feedUrl: args.feed || RSS_URL,
    limit: args.limit,
  });

  console.log('\nDone');
  console.log(`- Discovered episodes: ${result.discovered}`);
  console.log(`- New episodes: ${result.newEpisodes}`);
  console.log(`- Attempted: ${result.attempted}`);
  console.log(`- Success: ${result.success}`);
  console.log(`- Failed: ${result.failed}`);
  console.log(`- Output: ${path.relative(ROOT_DIR, result.outputFile)}`);
  console.log(`- Processed tracker: ${path.relative(ROOT_DIR, result.processedFile)}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
