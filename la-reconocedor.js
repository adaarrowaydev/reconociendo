const axios = require('axios');
const fs = require('fs');

const CONFIG = {
    baseUrl: 'https://www.liveaboard.com/diving/search/galapagos',
    output_file: './data/reconocido-data.json',
    delayBetweenRequests: 3000,
    markup: 0.15,
    currency: process.env.RECONOCIDO_CURRENCY || 'EUR',
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
};

const CURRENCY_SYMBOLS = { USD: '$', EUR: '€', GBP: '£', AUD: 'A$', CAD: 'C$', CHF: 'CHF ' };
const currencySymbol = () => CURRENCY_SYMBOLS[CONFIG.currency] || `${CONFIG.currency} `;

// Minimal cookie jar so the currency preference (server-side session) persists across requests
const cookieJar = {};
function applyCookies(setCookieHeaders) {
    if (!setCookieHeaders) return;
    setCookieHeaders.forEach(line => {
        const [pair] = line.split(';');
        const idx = pair.indexOf('=');
        if (idx > 0) cookieJar[pair.slice(0, idx).trim()] = pair.slice(idx + 1).trim();
    });
}
function cookieHeader() {
    return Object.entries(cookieJar).map(([k, v]) => `${k}=${v}`).join('; ');
}
async function laRequest(method, url) {
    const res = await axios.request({
        method,
        url,
        headers: {
            'User-Agent': CONFIG.userAgent,
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.9',
            'Connection': 'keep-alive',
            ...(Object.keys(cookieJar).length ? { Cookie: cookieHeader() } : {})
        },
        timeout: 30000,
        validateStatus: () => true
    });
    applyCookies(res.headers['set-cookie']);
    return res;
}
async function setCurrencyPreference(code) {
    await laRequest('GET', CONFIG.baseUrl);
    const res = await laRequest('POST', `https://www.liveaboard.com/Preference/SetCurrency?currencyCode=${code}`);
    if (res.status >= 200 && res.status < 300) {
        console.log(`Currency preference set to ${code}`);
    } else {
        console.warn(`Failed to set currency to ${code} (HTTP ${res.status}); falling back to default`);
    }
}

// Generate month URLs
function generateMonthUrls() {
    const urls = [];
    const months = ['january', 'february', 'march', 'april', 'may', 'june', 
                   'july', 'august', 'september', 'october', 'november', 'december'];

    const now = new Date();
    const endDate = new Date(now.getFullYear() + 2, now.getMonth(), now.getDate());

    let current = new Date(now.getFullYear(), now.getMonth(), 1);
    
    while (current <= endDate) {
        const month = months[current.getMonth()];
        const year = current.getFullYear();
        urls.push({
            url: `${CONFIG.baseUrl}/${month}/${year}`,
            month: month,
            year: year
        });
        current.setMonth(current.getMonth() + 1);
    }
    
    return urls;
}

// Extract embedded JSON
function extractSearchData(html) {
    try {
        const match = html.match(/searchResultItemList":\s*(\[[\s\S]*?\])(?=\s*,\s*"(?:availableHeaderText|availableHeaderTemplate|hasSelectedFilters|selectedFilters))/);
        if (!match) return null;
        return JSON.parse(match[1]);
    } catch (error) {
        return null;
    }
}

// Transform to output format with discount data
function transformBoatData(boat) {
    const trips = [];
    
    if (!boat.cruiseSearchItineraryList || boat.cruiseSearchItineraryList.length === 0) {
        return trips;
    }
    
    boat.cruiseSearchItineraryList.forEach(itinerary => {
        if (itinerary.availabilityText === 'soldout' || itinerary.isSoldOut || !itinerary.toursAvailable) {
            return;
        }

        // Parse current/sale price
        const priceStr = String(itinerary.price || '0').replace(/,/g, '');
        const price = parseFloat(priceStr);
        
        // Extract original price from crossedRate
        const crossedRateStr = String(itinerary.crossedRate || '0').replace(/,/g, '');
        const crossedRate = parseFloat(crossedRateStr);
        
        // Get discount percentage
        let discountPct = itinerary.discount || itinerary.earlyBirdDiscountPercent || null;
        if (!discountPct && crossedRate > 0 && price > 0 && crossedRate > price) {
            discountPct = Math.round(((crossedRate - price) / crossedRate) * 100);
        }
        
        const hasDiscount = itinerary.hasDiscount || itinerary.hasFixedPriceOffer || (crossedRate > price && crossedRate > 0);
        
        // yourPrice = original price (crossed out), or markup if no discount
        const yourPrice = crossedRate > 0 ? crossedRate : (price > 0 ? (price * (1 + CONFIG.markup)).toFixed(2) : '');
        const sym = currencySymbol();

        trips.push({
            name: boat.boatName,
            date: itinerary.departureDateFormatted,
            duration: itinerary.daysNights,
            currency: CONFIG.currency,
            price: price > 0 ? `${sym}${price.toLocaleString()}` : '',
            originalPrice: price,
            crossedRate: crossedRate > 0 ? `${sym}${crossedRate.toLocaleString()}` : '',
            yourPrice: yourPrice ? `${sym}${parseFloat(yourPrice).toLocaleString()}` : '',
            availability: itinerary.availabilityText || 'available',
            isAvailable: itinerary.tourAvailability > 5,
            spotsLeft: itinerary.tourAvailability || 10,
            discountPercentage: discountPct,
            discountText: itinerary.discountText || '',
            hasDiscount: hasDiscount,
            rating: boat.starRating || '',
            description: boat.snippet || '',
            photo: {
                url: boat.boatImageLink || '',
                alt: boat.boatName
            },
            reconocidoAt: new Date().toISOString()
        });
    });
    
    return trips;
}

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function reconoceLa() {
    console.log('Starting l-a.com reconoce (comprehensive)...');

    await setCurrencyPreference(CONFIG.currency);

    const monthUrls = generateMonthUrls();
    console.log(`Generated ${monthUrls.length} URLs to reconocer`);

    const allTrips = [];
    let successCount = 0;

    for (let i = 0; i < monthUrls.length; i++) {
        const { url, month, year } = monthUrls[i];

        try {
            const response = await laRequest('GET', url);
            if (response.status !== 200) {
                console.error(`Non-200 ${response.status} for ${month} ${year}`);
                continue;
            }

            const boats = extractSearchData(response.data);
            
            if (boats) {
                boats.forEach(boat => {
                    const trips = transformBoatData(boat);
                    allTrips.push(...trips);
                });
                successCount++;
            }
            
            if (i < monthUrls.length - 1) {
                await delay(CONFIG.delayBetweenRequests);
            }
            
        } catch (error) {
            console.error(`Error reconociendo ${month} ${year}`);
        }
    }
    
    // Deduplicate
    const uniqueTrips = [];
    const seen = new Set();
    
    allTrips.forEach(trip => {
        const key = `${trip.name}-${trip.date}`;
        if (!seen.has(key)) {
            seen.add(key);
            uniqueTrips.push(trip);
        }
    });
    
    console.log(`Reconocido complete: ${uniqueTrips.length} trips from ${successCount} months`);
    
    if (!fs.existsSync('./data')) {
        fs.mkdirSync('./data');
    }
    
    const output = {
        lastUpdated: new Date().toISOString(),
        totalTrips: uniqueTrips.length,
        filteredOut: 'FULL trips excluded from results',
        source: 'l-a.com',
        currency: CONFIG.currency,
        trips: uniqueTrips
    };
    
    fs.writeFileSync(CONFIG.output_file, JSON.stringify(output, null, 2));
    console.log(`Data saved to ${CONFIG.output_file}`);
    
    return output;
}

if (require.main === module) {
    reconoceLa()
        .then(() => {
            console.log('Reconoce completed successfully');
            process.exit(0);
        })
        .catch(error => {
            console.error('Reconoce failed:', error);
            process.exit(1);
        });
}

module.exports = { reconoceLa, CONFIG };
