const axios = require('axios');
const fs = require('fs');

const CONFIG = {
    baseUrl: 'https://www.liveaboard.com/diving/search/galapagos',
    output_file: './data/reconocido-data.json',
    delayBetweenRequests: 3000,
    markup: 0.15,
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
};

// Generate month URLs
function generateMonthUrls() {
    const urls = [];
    const months = ['january', 'february', 'march', 'april', 'may', 'june', 
                   'july', 'august', 'september', 'october', 'november', 'december'];
    
    const now = new Date();
    const startDate = new Date('2026-02-01');
    const actualStart = now > startDate ? now : startDate;
    const endDate = new Date('2028-12-31');
    
    let current = new Date(actualStart.getFullYear(), actualStart.getMonth(), 1);
    
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

// Transform to output format
function transformBoatData(boat) {
    const trips = [];
    
    if (!boat.cruiseSearchItineraryList || boat.cruiseSearchItineraryList.length === 0) {
        return trips;
    }
    
    boat.cruiseSearchItineraryList.forEach(itinerary => {
        if (itinerary.availabilityText === 'soldout' || itinerary.isSoldOut || !itinerary.toursAvailable) {
            return;
        }
        
        const priceStr = String(itinerary.price || '0').replace(/,/g, '');
        const price = parseFloat(priceStr);
        const yourPrice = price > 0 ? (price * (1 + CONFIG.markup)).toFixed(2) : '';
        
        trips.push({
            name: boat.boatName,
            date: itinerary.departureDateFormatted,
            duration: itinerary.daysNights,
            price: price > 0 ? `$ ${price.toLocaleString()}` : '',
            availability: itinerary.availabilityText || 'available',
            isAvailable: itinerary.tourAvailability > 5,
            spotsLeft: itinerary.tourAvailability || 10,
            yourPrice: yourPrice ? `$${parseFloat(yourPrice).toLocaleString()}` : '',
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
    
    const monthUrls = generateMonthUrls();
    console.log(`Generated ${monthUrls.length} URLs to reconocer`);
    
    const allTrips = [];
    let successCount = 0;
    
    for (let i = 0; i < monthUrls.length; i++) {
        const { url, month, year } = monthUrls[i];
        
        try {
            const response = await axios.get(url, {
                headers: {
                    'User-Agent': CONFIG.userAgent,
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                    'Accept-Language': 'en-US,en;q=0.9',
                    'Connection': 'keep-alive'
                },
                timeout: 30000
            });
            
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
