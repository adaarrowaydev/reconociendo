const axios = require('axios');
const fs = require('fs');

const CONFIG = {
    searchPageUrl: 'https://www.emperordivers.com/search/?destination=6004&selectedDate=2026-4-01&type=liveaboard&end-month-date=1',
    ajaxUrl: 'https://www.emperordivers.com/wp-admin/admin-ajax.php',
    output_file: './data/emperor-data.json',
    delayBetweenRequests: 2000,
    markup: 0.15,
    currency: process.env.RECONOCIDO_CURRENCY || 'EUR',
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
};

const DESTINATIONS = {
    egypt:   { key: '6004', label: 'Egypt / Red Sea' },
    maldives:{ key: '6001', label: 'Maldives' },
    indonesia:{ key: '6049', label: 'Indonesia' },
    solomon: { key: '7582', label: 'Solomon Islands' },
};

const CURRENCY_SYMBOLS = { USD: '$', EUR: '€', GBP: '£' };
const CURRENCY_CODES   = { USD: '2', EUR: '3', GBP: '1' };
const currencySymbol = () => CURRENCY_SYMBOLS[CONFIG.currency] || `${CONFIG.currency} `;

const cookieJar = {};
function applyCookies(setCookieHeaders) {
    if (!setCookieHeaders) return;
    (Array.isArray(setCookieHeaders) ? setCookieHeaders : [setCookieHeaders]).forEach(line => {
        const [pair] = line.split(';');
        const idx = pair.indexOf('=');
        if (idx > 0) cookieJar[pair.slice(0, idx).trim()] = pair.slice(idx + 1).trim();
    });
}
function cookieHeader() {
    return Object.entries(cookieJar).map(([k, v]) => `${k}=${v}`).join('; ');
}
async function req(method, url, data) {
    const opts = {
        method, url,
        headers: {
            'User-Agent': CONFIG.userAgent,
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.9',
            ...(Object.keys(cookieJar).length ? { Cookie: cookieHeader() } : {}),
        },
        timeout: 30000,
        validateStatus: () => true,
    };
    if (data) {
        opts.headers['Content-Type'] = 'application/x-www-form-urlencoded';
        opts.data = new URLSearchParams(data).toString();
    }
    const res = await axios.request(opts);
    applyCookies(res.headers['set-cookie']);
    return res;
}

async function fetchNonce() {
    const res = await req('GET', CONFIG.searchPageUrl);
    if (res.status !== 200) throw new Error(`Failed to load search page (HTTP ${res.status})`);
    const m = res.data.match(/action:\s*'initial_search_submit'[\s\S]*?nonce:\s*"([^"]+)"/);
    if (!m) throw new Error('Could not extract nonce from search page');
    return m[1];
}

async function setCurrencyPreference() {
    const code = CURRENCY_CODES[CONFIG.currency];
    if (!code) return;
    cookieJar['emperor_currency'] = code;
    cookieJar['emperor_currency_code'] = CONFIG.currency;
}

function generateMonths() {
    const months = [];
    const now = new Date();
    const end = new Date(now.getFullYear() + 2, now.getMonth(), 1);
    let cur = new Date(now.getFullYear(), now.getMonth(), 1);
    while (cur <= end) {
        months.push({ month: cur.getMonth() + 1, year: cur.getFullYear() });
        cur.setMonth(cur.getMonth() + 1);
    }
    return months;
}

function parseTripsFromHtml(html, destination) {
    const trips = [];
    const rowRe = /<tr\s+class="boats-package"[^>]*>[\s\S]*?<\/tr>/g;
    let match;
    while ((match = rowRe.exec(html)) !== null) {
        const row = match[0];
        const attrs = row.match(/<tr[^>]*>/)[0];

        const packId    = (attrs.match(/pack-id="([^"]+)"/) || [])[1] || '';
        const seatsLeft = parseInt((attrs.match(/data-total-seats-left="([^"]+)"/) || [])[1] || '0', 10);

        const dateMatch = row.match(/boats-package-date[^>]*>([^<]+)</);
        const dateStr = dateMatch ? dateMatch[1].trim() : '';

        // Use pack-name attr (e.g. "Emperor Elite I South & St. Johns")
        const packNameMatch = row.match(/pack-name="([^"]+)"/);
        const rawName = packNameMatch ? packNameMatch[1] : '';

        // Use itinerary-name attr for the route (e.g. "South & St Johns")
        const itineraryMatch = row.match(/itinerary-name="([^"]+)"/);
        const route = itineraryMatch ? itineraryMatch[1] : '';

        // Derive boat name: split on " | " or " I " (roman numeral separator used by Egypt boats)
        let boatName = rawName;
        const sepMatch = rawName.match(/^(.+?)\s+[|I]\s+(.+)$/);
        if (sepMatch) {
            boatName = sepMatch[1].trim();
        }

        const nightsMatch = row.match(/No of nights:\s*(\d+)/i);
        const nights = nightsMatch ? parseInt(nightsMatch[1], 10) : 0;

        const priceMatch = row.match(/data-original-price="([^"]+)"/);
        const price = priceMatch ? parseFloat(priceMatch[1]) : 0;

        const hasBookBtn = /boat-book-btn[^>]*>SELECT A CABIN/i.test(row);
        const isEmailOnly = /send-email-package/i.test(row);

        let availability = 'available';
        if (isEmailOnly) availability = 'email only';
        else if (seatsLeft <= 3) availability = `only ${seatsLeft} spaces left`;

        let formattedDate = dateStr;
        const dateParts = dateStr.match(/(\d{2})-(\d{2})-(\d{4})/);
        if (dateParts) {
            const [, dd, mm, yyyy] = dateParts;
            const monthNames = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
            formattedDate = `${parseInt(dd, 10)} ${monthNames[parseInt(mm, 10) - 1]} ${yyyy}`;
        }

        const sym = currencySymbol();
        const yourPrice = price > 0 ? (price * (1 + CONFIG.markup)).toFixed(2) : '';

        trips.push({
            name: boatName,
            route,
            destination: destination.label,
            date: formattedDate,
            duration: `${nights + 1}D/${nights}N`,
            currency: CONFIG.currency,
            price: price > 0 ? `${sym}${price.toLocaleString()}` : '',
            originalPrice: price,
            crossedRate: '',
            yourPrice: yourPrice ? `${sym}${parseFloat(yourPrice).toLocaleString()}` : '',
            availability,
            isAvailable: hasBookBtn && seatsLeft > 0,
            spotsLeft: seatsLeft,
            discountPercentage: null,
            discountText: '',
            hasDiscount: false,
            rating: '',
            description: route,
            photo: { url: '', alt: boatName },
            source: 'emperordivers.com',
            packId,
            reconocidoAt: new Date().toISOString(),
        });
    }
    return trips;
}

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

async function reconoceEmperor() {
    console.log('Starting Emperor Divers reconoce...');

    setCurrencyPreference();
    const nonce = await fetchNonce();
    console.log('Nonce acquired');

    const months = generateMonths();
    const destEntries = Object.entries(DESTINATIONS);
    const allTrips = [];
    let successCount = 0;

    for (const [destName, dest] of destEntries) {
        console.log(`\nReconociendo ${dest.label}...`);

        for (let i = 0; i < months.length; i++) {
            const { month, year } = months[i];
            const selectedDate = `${year}-${month}-01`;

            try {
                const res = await req('POST', CONFIG.ajaxUrl, {
                    action: 'initial_search_submit',
                    destination_key: dest.key,
                    selectedDate,
                    type: 'liveaboard',
                    month_no: String(month),
                    year: String(year),
                    current_date: selectedDate,
                    checked: '0',
                    no_days: '0',
                    course_id: '0',
                    offer_pack_code: '',
                    itinerary: '',
                    exact_from_date: '1',
                    nonce,
                });

                if (res.status !== 200) {
                    console.error(`  Non-200 for ${destName} ${month}/${year}`);
                    continue;
                }

                const data = typeof res.data === 'string' ? JSON.parse(res.data) : res.data;
                const trips = parseTripsFromHtml(data.html || '', dest);

                if (trips.length > 0) {
                    allTrips.push(...trips);
                    console.log(`  ${month}/${year}: ${trips.length} trips`);
                    successCount++;
                }
            } catch (err) {
                console.error(`  Error ${destName} ${month}/${year}: ${err.message}`);
            }

            await delay(CONFIG.delayBetweenRequests);
        }
    }

    // Deduplicate by packId
    const seen = new Set();
    const uniqueTrips = allTrips.filter(t => {
        if (seen.has(t.packId)) return false;
        seen.add(t.packId);
        return true;
    });

    console.log(`\nEmperor reconocido complete: ${uniqueTrips.length} unique trips from ${successCount} successful month queries`);

    if (!fs.existsSync('./data')) fs.mkdirSync('./data');

    const output = {
        lastUpdated: new Date().toISOString(),
        totalTrips: uniqueTrips.length,
        source: 'emperordivers.com',
        currency: CONFIG.currency,
        destinations: Object.values(DESTINATIONS).map(d => d.label),
        trips: uniqueTrips,
    };

    fs.writeFileSync(CONFIG.output_file, JSON.stringify(output, null, 2));
    console.log(`Data saved to ${CONFIG.output_file}`);
    return output;
}

if (require.main === module) {
    reconoceEmperor()
        .then(() => { console.log('Emperor reconoce completed'); process.exit(0); })
        .catch(err => { console.error('Emperor reconoce failed:', err); process.exit(1); });
}

module.exports = { reconoceEmperor, CONFIG };
