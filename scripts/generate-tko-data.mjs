#!/usr/bin/env node
import { promises as fs } from 'node:fs';
import path from 'node:path';

const repoRoot = process.cwd();
const sources = {
  scoutFindings: path.resolve(repoRoot, '../memory/scout-findings'),
  scoutReports: path.resolve(repoRoot, '../reports/solana-scout'),
  database: path.resolve(repoRoot, '../memory/scout-findings/database.md'),
  whaleAlerts: path.resolve(repoRoot, '../memory/whale-alerts'),
};

async function listMarkdownFiles(dir) {
  try {
    const names = await fs.readdir(dir);
    return names
      .filter((name) => name.endsWith('.md'))
      .map((name) => path.join(dir, name))
      .sort();
  } catch {
    return [];
  }
}

function parseField(block, fieldName) {
  const rx = new RegExp(`- \\*\\*${fieldName}:\\*\\*\\s*([^\\n]+)`, 'i');
  const m = block.match(rx);
  return m ? m[1].trim() : null;
}

function parseConfidence(block) {
  const val = parseField(block, 'Confidence');
  if (!val) return null;
  const n = Number((val.match(/\d+/) || [])[0]);
  return Number.isFinite(n) ? n : null;
}

function parseDescription(block) {
  return parseField(block, 'Description');
}

function parseRewardMechanic(block) {
  const start = block.match(/- \*\*Reward Mechanic:\*\*\s*/i);
  if (!start) return null;
  const chunk = block.slice(start.index + start[0].length);
  const stop = chunk.search(/\n- \*\*[A-Z][^\n]*:\*\*|\n\n|\n---/);
  const raw = (stop >= 0 ? chunk.slice(0, stop) : chunk).trim();
  return raw.replace(/\n\s*[-*]\s*/g, '; ').replace(/\s+/g, ' ').trim() || null;
}

function parseLinks(block) {
  const out = [];
  const linkRegex = /\[([^\]]+)\]\((https?:[^)]+)\)/g;
  let m;
  while ((m = linkRegex.exec(block)) !== null) {
    out.push({ label: m[1].trim(), url: m[2].trim() });
  }
  return out;
}

function parseFindingsFromMarkdown(content, sourceFile) {
  const findings = [];
  const sectionRegex = /###\s+\d+\.\s+(.+?)\s+\(([^)]+)\)\n([\s\S]*?)(?=\n---\n|\n###\s+\d+\.|\n##\s+|\n\*Report|$)/g;
  let match;
  while ((match = sectionRegex.exec(content)) !== null) {
    const token = match[1].trim();
    const ticker = match[2].trim();
    const block = match[3];

    findings.push({
      token,
      ticker,
      marketCap: parseField(block, 'Market Cap'),
      description: parseDescription(block),
      rewardMechanic: parseRewardMechanic(block),
      confidence: parseConfidence(block),
      links: parseLinks(block),
      sourceFile,
    });
  }
  return findings;
}

function extractDateFromPath(filePath) {
  const m = filePath.match(/(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

async function parseTrackedTokenCount(databasePath) {
  try {
    const content = await fs.readFile(databasePath, 'utf8');
    const rows = content
      .split('\n')
      .filter((line) => line.startsWith('|') && !line.includes('---') && !line.includes(' Token ') && !line.includes('Ticker |'));

    const uniq = new Set();
    for (const row of rows) {
      const cols = row.split('|').map((x) => x.trim()).filter(Boolean);
      if (cols.length >= 2) {
        const name = cols[0];
        const ticker = cols[1];
        if (name && ticker) uniq.add(`${name.toLowerCase()}::${ticker.toLowerCase()}`);
      }
    }
    return uniq.size;
  } catch {
    return 0;
  }
}

async function fetchDexScreener(ticker) {
  const symbol = String(ticker || '').toUpperCase();
  const url = `https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(symbol)}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);

  try {
    const res = await fetch(url, { signal: controller.signal, headers: { Accept: 'application/json' } });
    clearTimeout(timeout);
    if (!res.ok) return null;
    const data = await res.json();
    const pairs = Array.isArray(data?.pairs) ? data.pairs : [];
    if (!pairs.length) return null;

    const solana = pairs.filter((p) => p.chainId === 'solana');
    const exact = solana.filter((p) => String(p?.baseToken?.symbol || '').toUpperCase() === symbol);
    const shortlist = exact.length ? exact : solana;

    const ranked = shortlist.sort((a, b) => Number(b?.liquidity?.usd || 0) - Number(a?.liquidity?.usd || 0));
    const best = ranked[0] || null;
    if (!best) return null;

    const change24h = Number(best?.priceChange?.h24 ?? 0);
    const volume24h = Number(best?.volume?.h24 ?? 0);

    return {
      ticker: symbol,
      pair: best.pairAddress || null,
      dexId: best.dexId || null,
      url: best.url || null,
      priceUsd: Number(best.priceUsd || 0),
      change24h,
      volume24h,
      fdv: Number(best.fdv || 0),
      liquidityUsd: Number(best?.liquidity?.usd || 0),
      baseSymbol: best?.baseToken?.symbol || symbol,
      quoteSymbol: best?.quoteToken?.symbol || 'SOL',
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function readWhaleAlerts() {
  try {
    const names = await fs.readdir(sources.whaleAlerts);
    const files = names.filter((n) => n.endsWith('.json')).map((n) => path.join(sources.whaleAlerts, n));
    const alerts = [];

    for (const file of files) {
      try {
        const raw = await fs.readFile(file, 'utf8');
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) alerts.push(...parsed);
      } catch {
        // ignore malformed file
      }
    }

    return alerts.slice(0, 20);
  } catch {
    return [];
  }
}

async function main() {
  const [scoutFiles, reportFiles] = await Promise.all([
    listMarkdownFiles(sources.scoutFindings),
    listMarkdownFiles(sources.scoutReports),
  ]);

  const sourceFiles = [...scoutFiles, ...reportFiles]
    .filter((f) => !f.endsWith('database.md'))
    .sort();

  const allFindings = [];
  for (const file of sourceFiles) {
    const content = await fs.readFile(file, 'utf8');
    const sourceFile = path.relative(path.resolve(repoRoot, '..'), file);
    const date = extractDateFromPath(file);
    const findings = parseFindingsFromMarkdown(content, sourceFile).map((f) => ({ ...f, discoveredOn: date }));
    allFindings.push(...findings);
  }

  // De-duplicate by ticker, keep latest discovered entry
  const dedupedMap = new Map();
  for (const item of allFindings) {
    const key = item.ticker.toUpperCase();
    const prev = dedupedMap.get(key);
    if (!prev) {
      dedupedMap.set(key, item);
      continue;
    }
    const prevDate = prev.discoveredOn || '0000-00-00';
    const nextDate = item.discoveredOn || '0000-00-00';
    if (nextDate >= prevDate) dedupedMap.set(key, item);
  }

  const findings = Array.from(dedupedMap.values()).sort((a, b) => {
    const da = a.discoveredOn || '';
    const db = b.discoveredOn || '';
    if (da !== db) return db.localeCompare(da);
    return (b.confidence || 0) - (a.confidence || 0);
  });

  const latestDate = findings[0]?.discoveredOn || new Date().toISOString().slice(0, 10);
  const latestFinds = findings.filter((f) => f.discoveredOn === latestDate);
  const trackedTokens = await parseTrackedTokenCount(sources.database);

  const symbolUniverse = Array.from(
    new Set([
      ...latestFinds.map((f) => f.ticker),
      'FLOCK',
      'CGPT',
      'REI',
      'GRASS',
      'HONEY',
      'UPT',
      'DOOD',
      'SNS',
    ])
  ).slice(0, 14);

  const marketRows = (await Promise.all(symbolUniverse.map((s) => fetchDexScreener(s)))).filter(Boolean);
  const topGainers = [...marketRows]
    .filter((r) => Number.isFinite(r.change24h))
    .sort((a, b) => b.change24h - a.change24h)
    .slice(0, 8);

  const totalVolume24h = marketRows.reduce((sum, r) => sum + (r.volume24h || 0), 0);
  const avgChange24h = marketRows.length
    ? marketRows.reduce((sum, r) => sum + (r.change24h || 0), 0) / marketRows.length
    : 0;

  const whaleAlerts = await readWhaleAlerts();

  const payload = {
    generatedAt: new Date().toISOString(),
    lastUpdated: latestDate,
    quickStats: {
      totalTokensTracked: trackedTokens,
      newFindsToday: latestFinds.length,
      hotOpportunities: findings
        .filter((f) => (f.confidence || 0) >= 65)
        .slice(0, 5)
        .map((f) => ({ token: f.token, ticker: f.ticker, confidence: f.confidence })),
    },
    marketOverview: {
      source: 'DexScreener',
      symbolsQueried: symbolUniverse,
      topGainers,
      trends: {
        avgChange24h,
        totalVolume24h,
        advancers: marketRows.filter((r) => (r.change24h || 0) > 0).length,
        decliners: marketRows.filter((r) => (r.change24h || 0) < 0).length,
      },
    },
    whaleAlerts: {
      available: whaleAlerts.length > 0,
      source: whaleAlerts.length ? 'memory/whale-alerts/*.json' : null,
      alerts: whaleAlerts,
    },
    scoutFindings: findings,
  };

  const outDir = path.join(repoRoot, 'data');
  await fs.mkdir(outDir, { recursive: true });
  const outPath = path.join(outDir, 'tko-intel.json');
  await fs.writeFile(outPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');

  console.log(`Generated ${path.relative(repoRoot, outPath)} with ${findings.length} findings and ${marketRows.length} market rows.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
