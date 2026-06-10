#!/usr/bin/env node
/**
 * TKO YouTube Transcript Fetcher
 * Fetches transcripts from YouTube videos (fast, free)
 * Falls back to Whisper if no transcript available
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT_DIR, 'data');
const CACHE_DIR = path.join(ROOT_DIR, '.cache', 'tko-audio');
const OUTPUT_FILE = path.join(DATA_DIR, 'tko-intel.json');
const PROCESSED_FILE = path.join(DATA_DIR, 'processed-episodes.json');

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

async function fetchYouTubeTranscript(videoId) {
  return new Promise((resolve, reject) => {
    const child = spawn('python3', [
      path.join(__dirname, 'fetch-youtube-transcripts.py'),
      videoId
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

    child.on('close', (code) => {
      if (code === 0) {
        try {
          const result = JSON.parse(stdout);
          resolve(result);
        } catch (e) {
          reject(new Error(`Failed to parse transcript output: ${e.message}`));
        }
      } else {
        reject(new Error(`Transcript fetch failed (${code}): ${stderr || stdout}`));
      }
    });

    child.on('error', reject);
  });
}

async function extractIntelligence(transcript, episodeMeta) {
  // Simple extraction - in production, use LLM
  const ideas = [];
  
  // Extract price mentions
  const priceMatches = transcript.match(/\$\d+(?:,\d{3})*(?:\s*(?:to|-)\s*\$?\d+(?:,\d{3})*)?\s*(?:a month|per month|monthly|year|annually)/gi);
  if (priceMatches) {
    ideas.push({
      idea: 'Pricing Strategy',
      category: 'Business Model',
      barrier: 'Low',
      timeline: 'Immediate',
      tools: [],
      revenue: priceMatches[0],
      insight: `Pricing mentioned: ${priceMatches.join(', ')}`,
      matchScore: 7
    });
  }

  // Extract tool mentions
  const toolMatches = transcript.match(/(?:using|tool called|platform|service)\s+([A-Z][a-zA-Z0-9]+(?:\.[a-z]+)?)/g);
  if (toolMatches) {
    const tools = toolMatches.map(m => m.replace(/(?:using|tool called|platform|service)\s+/, ''));
    ideas.push({
      idea: 'Tools & Platforms',
      category: 'Technology',
      barrier: 'Low',
      timeline: 'Immediate',
      tools: tools.slice(0, 5),
      revenue: 'Not stated',
      insight: `Tools mentioned: ${tools.slice(0, 5).join(', ')}`,
      matchScore: 6
    });
  }

  // Extract market size mentions
  const marketMatches = transcript.match(/(?:market|industry|worth)\s+(?:is\s+)?(?:over\s+)?\$?\d+(?:\.\d+)?\s*(?:billion|million|trillion)/gi);
  if (marketMatches) {
    ideas.push({
      idea: 'Market Opportunity',
      category: 'Market Analysis',
      barrier: 'Low',
      timeline: 'Immediate',
      tools: [],
      revenue: marketMatches[0],
      insight: `Market size: ${marketMatches.join(', ')}`,
      matchScore: 8
    });
  }

  return ideas;
}

async function processEpisode(videoId, episodeMeta) {
  console.log(`Processing YouTube video: ${videoId}`);
  
  const transcriptResult = await fetchYouTubeTranscript(videoId);
  
  if (!transcriptResult.success) {
    console.warn(`YouTube transcript failed for ${videoId}: ${transcriptResult.error}`);
    return null;
  }

  console.log(`Transcript fetched: ${transcriptResult.char_count} characters`);

  const intelligence = await extractIntelligence(transcriptResult.transcript, episodeMeta);

  return {
    id: videoId,
    title: episodeMeta.title || 'Unknown Episode',
    date: episodeMeta.date || new Date().toISOString().slice(0, 10),
    audioUrl: `https://youtube.com/watch?v=${videoId}`,
    transcript: transcriptResult.transcript,
    intelligence,
    source: 'youtube'
  };
}

async function main() {
  await ensureDirs();

  // Read current state
  const output = await readJson(OUTPUT_FILE, { episodes: [] });
  const processedState = await readJson(PROCESSED_FILE, { processedEpisodeIds: [] });
  const processedIds = new Set(processedState.processedEpisodeIds || []);
  const outputById = new Map((output.episodes || []).map((ep) => [ep.id, ep]));

  // Test with known TKO video IDs
  const testVideos = [
    { id: 'trdHxY1UMF0', title: 'AI Voice Cloning for Realtors', date: '2026-06-08' },
    { id: 'HcR7Wqgi4lU', title: 'TKO Episode 2', date: '2026-06-07' }
  ];

  let success = 0;
  let failed = 0;

  for (const video of testVideos) {
    if (processedIds.has(video.id)) {
      console.log(`Skipping already processed: ${video.id}`);
      continue;
    }

    try {
      const episode = await processEpisode(video.id, video);
      if (episode) {
        outputById.set(video.id, episode);
        processedIds.add(video.id);
        success++;
        console.log(`✅ Processed: ${video.title} (${episode.intelligence.length} ideas)`);
      } else {
        failed++;
      }
    } catch (error) {
      console.warn(`❌ Failed: ${video.id} - ${error.message}`);
      failed++;
    }
  }

  // Save updated state
  await saveJson(OUTPUT_FILE, {
    episodes: Array.from(outputById.values())
      .sort((a, b) => (new Date(b.date).getTime() || 0) - (new Date(a.date).getTime() || 0)),
  });

  await saveJson(PROCESSED_FILE, {
    processedEpisodeIds: Array.from(processedIds),
    updatedAt: new Date().toISOString(),
  });

  console.log(`\nDone: ${success} succeeded, ${failed} failed`);
  console.log(`Total episodes: ${outputById.size}`);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
