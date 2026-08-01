// Deterministic accuracy checks for the scraped liveaboard data shown on
// https://www.buceogalapagos.com/liveaboards.
// Run by .github/workflows/data-check.yml. Writes data-check-report.md and
// exits non-zero when any hard check fails (the workflow then opens/updates
// a "[data-check]" issue).
const axios = require('axios');
const fs = require('fs');

const RAW_BASE = 'https://raw.githubusercontent.com/adaarrowaydev/reconociendo/refs/heads/main';
const LIVE_PAGE = 'https://www.buceogalapagos.com/liveaboards';
// Wix regenerates this URL if the embed block is ever re-pasted in the editor;
// update it here when that happens (a 404 below is the signal).
const WIX_EMBED = 'https://www-buceogalapagos-com.filesusr.com/html/1a4f34_edbc1035ff6f2854118a4d2bf940e4e9.html';
const MARKUP = 1.15;            // must match CONFIG.markup in la-reconocedor.js
const MAX_AGE_HOURS = 24;       // scraper runs 3x/day
const MIN_TRIPS = 100;          // baseline is ~350-400
const SPOTCHECK_MONTHS = 3;
const DELAY_MS = 3000;
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36';

const failures = [];
const warnings = [];
const notes = [];

const money = s => Number(String(s).replace(/[^0-9.]/g, ''));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const get = url => axios.get(url, {
    timeout: 30000,
    validateStatus: () => true,
    headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' }
});

async function checkData() {
    const res = await get(`${RAW_BASE}/data/reconocido-data.json?t=${Date.now()}`);
    if (res.status !== 200) {
        failures.push(`Data JSON not reachable: HTTP ${res.status} from raw.githubusercontent`);
        return null;
    }
    const d = res.data;
    const ageH = (Date.now() - new Date(d.lastUpdated).getTime()) / 3600e3;
    if (!(ageH >= 0 && ageH < MAX_AGE_HOURS)) {
        failures.push(`Data is stale: lastUpdated ${d.lastUpdated} (${ageH.toFixed(1)}h old, limit ${MAX_AGE_HOURS}h) — scraper likely broken`);
    }
    if (!Array.isArray(d.trips) || d.trips.length < MIN_TRIPS) {
        failures.push(`Trip count suspicious: ${d.trips ? d.trips.length : 'none'} trips (expected > ${MIN_TRIPS})`);
    }
    if (!d.trips) return d;

    const required = ['name', 'date', 'duration', 'price', 'originalPrice', 'yourPrice', 'availability'];
    let fieldBad = 0, markupBad = 0, priceBad = 0, dateBad = 0;
    const examples = [];
    for (const t of d.trips) {
        if (required.some(k => t[k] === undefined || t[k] === null || t[k] === '')) {
            fieldBad++;
            if (examples.length < 5) examples.push(`missing field: ${t.name || '?'} ${t.date || ''}`);
            continue;
        }
        // Mirrors la-reconocedor.js: yourPrice = crossedRate when discounted,
        // else originalPrice * markup.
        const expected = money(t.crossedRate) > 0 ? money(t.crossedRate) : t.originalPrice * MARKUP;
        if (Math.abs(money(t.yourPrice) - expected) > 0.02) {
            markupBad++;
            if (examples.length < 5) examples.push(`markup: ${t.name} ${t.date} yourPrice ${t.yourPrice} != expected ${expected.toFixed(2)}`);
        }
        if (money(t.price) !== t.originalPrice) {
            priceBad++;
            if (examples.length < 5) examples.push(`price mismatch: ${t.name} ${t.date} price ${t.price} vs originalPrice ${t.originalPrice}`);
        }
        const ts = Date.parse(t.date);
        if (isNaN(ts)) {
            dateBad++;
            if (examples.length < 5) examples.push(`unparseable date: ${t.name} "${t.date}"`);
        } else if (ts < Date.now() - 7 * 86400e3) {
            dateBad++;
            if (examples.length < 5) examples.push(`past trip still listed: ${t.name} ${t.date}`);
        }
    }
    const total = fieldBad + markupBad + priceBad + dateBad;
    if (total > 0) {
        failures.push(`${total} trip-level violations (fields ${fieldBad}, markup ${markupBad}, price ${priceBad}, dates ${dateBad}):\n  - ${examples.join('\n  - ')}`);
    } else {
        notes.push(`All ${d.trips.length} trips pass field/markup/price/date checks`);
    }
    return d;
}

async function checkLivePage() {
    const page = await get(LIVE_PAGE);
    if (page.status !== 200) {
        failures.push(`Live page ${LIVE_PAGE} returned HTTP ${page.status}`);
    } else {
        notes.push('Live page is up (HTTP 200)');
    }
    const embed = await get(WIX_EMBED);
    if (embed.status !== 200) {
        failures.push(`Wix embed returned HTTP ${embed.status} — the widget was removed or re-pasted in the Wix editor (update WIX_EMBED in data-check.js with the new filesusr URL)`);
        return;
    }
    const html = String(embed.data);
    if (!html.includes('raw.githubusercontent.com/adaarrowaydev/reconociendo')) {
        failures.push('Wix embed no longer points at the reconociendo data JSON');
        return;
    }
    notes.push('Wix embed is live and points at the repo data');
    try {
        const repoEmbed = fs.readFileSync(`${__dirname}/embedded.html`, 'utf8');
        const src = h => (h.match(/dataSource\s*=\s*'[^']*'/) || [''])[0];
        if (src(html) !== src(repoEmbed)) {
            warnings.push('Wix embed dataSource differs from repo embedded.html (deployed copy may be outdated)');
        }
    } catch { /* repo checkout not available — skip drift check */ }
}

async function spotCheckSource(d) {
    if (!d || !Array.isArray(d.trips)) return;
    const byMonth = new Map();
    for (const t of d.trips) {
        const ts = Date.parse(t.date);
        if (isNaN(ts)) continue;
        const dt = new Date(ts);
        const key = `${dt.toLocaleString('en-US', { month: 'long' }).toLowerCase()}/${dt.getFullYear()}`;
        if (!byMonth.has(key)) byMonth.set(key, new Set());
        byMonth.get(key).add(t.name);
    }
    let checked = 0;
    for (const [key, names] of byMonth) {
        if (checked >= SPOTCHECK_MONTHS) break;
        checked++;
        const res = await get(`https://www.liveaboard.com/diving/search/galapagos/${key}`);
        if (res.status !== 200) {
            notes.push(`Spot-check ${key}: INCONCLUSIVE (liveaboard.com HTTP ${res.status})`);
            await sleep(DELAY_MS);
            continue;
        }
        const html = String(res.data);
        const sample = [...names].slice(0, 5);
        const found = sample.filter(n => html.includes(n));
        if (found.length === 0) {
            failures.push(`Spot-check ${key}: none of ${sample.length} scraped boat names (${sample.join(', ')}) appear on the source page — parsing drift likely`);
        } else if (found.length < sample.length) {
            warnings.push(`Spot-check ${key}: only ${found.length}/${sample.length} boat names found on source page (missing: ${sample.filter(n => !found.includes(n)).join(', ')})`);
        } else {
            notes.push(`Spot-check ${key}: ${found.length}/${sample.length} boat names confirmed on source`);
        }
        await sleep(DELAY_MS);
    }
}

async function checkEmperor() {
    const res = await get(`${RAW_BASE}/data/emperor-data.json?t=${Date.now()}`);
    if (res.status !== 200) {
        warnings.push(`emperor-data.json not reachable (HTTP ${res.status}) — its scraper is allowed to fail, but worth a look`);
        return;
    }
    const ageH = (Date.now() - new Date(res.data.lastUpdated).getTime()) / 3600e3;
    if (!(ageH >= 0 && ageH < 48)) {
        warnings.push(`emperor-data.json is stale (lastUpdated ${res.data.lastUpdated}) — its scraper is allowed to fail, but worth a look`);
    } else {
        notes.push('emperor-data.json is fresh');
    }
}

(async () => {
    const d = await checkData();
    await checkLivePage();
    await spotCheckSource(d);
    await checkEmperor();

    const lines = [];
    if (failures.length) {
        lines.push(`## PROBLEMS FOUND (${failures.length})`, '', ...failures.map(f => `- ❌ ${f}`));
    } else {
        lines.push('## ALL OK');
    }
    if (warnings.length) lines.push('', '### Warnings', ...warnings.map(w => `- ⚠️ ${w}`));
    if (notes.length) lines.push('', '### Checks passed', ...notes.map(n => `- ✅ ${n}`));
    lines.push('', `_data-check.js run ${new Date().toISOString()}_`);
    const report = lines.join('\n');
    fs.writeFileSync('data-check-report.md', report);
    console.log(report);
    process.exit(failures.length ? 1 : 0);
})();
