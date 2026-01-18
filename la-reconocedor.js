const puppeteer = require('puppeteer');
const fs = require('fs');

const CONFIG = {
    targetUrl: 'https://www.liveaboard.com/diving/search/galapagos',
    output_file: './data/reconocido-data.json',
    markup: 0.15,
    selectors: {
        tripContainer: 'section.not-prose.mb-5.flex.flex-col.border.border-gray-300',
        dates: 'li.px-3\\.5.py-2.border-t.border-gray-300'
    }
};

async function reconoceLa() {
    console.log('Starting l-a.com reconoce...');
    
    const browser = await puppeteer.launch({ 
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--disable-gpu'
        ],
        timeout: 60000
    });
    
    try {
        const page = await browser.newPage();
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');
        
        console.log(`Navigating to: ${CONFIG.targetUrl}`);
        await page.goto(CONFIG.targetUrl, { waitUntil: 'networkidle2', timeout: 30000 });
        await new Promise(r => setTimeout(r, 3000));
        
        const trips = await page.evaluate((selectors, markup) => {
            const trips = [];
            const containers = document.querySelectorAll(selectors.tripContainer);
            
            containers.forEach((container, containerIndex) => {
                try {
                    const tripName = (() => {
                        for (const sel of ['h3', '.text-lg', '.text-xl', '[class*="font-bold"]']) {
                            const el = container.querySelector(sel);
                            if (el && el.textContent.trim().length > 3) return el.textContent.trim();
                        }
                        return `Trip ${containerIndex + 1}`;
                    })();
                    
                    const description = (() => {
                        for (const sel of ['.text-sm.text-gray-600', '.text-gray-600']) {
                            const el = container.querySelector(sel);
                            if (el) {
                                const text = el.textContent.trim();
                                if (text.length > 20 && !text.match(/\$\d+/) && !text.match(/available|FULL/i)) {
                                    return text;
                                }
                            }
                        }
                        return '';
                    })();
                    
                    const photo = (() => {
                        const img = container.querySelector('img[src*="picture_library"]');
                        return img ? { url: img.src, alt: img.alt || '' } : { url: '', alt: '' };
                    })();
                    
                    const rating = (() => {
                        const info = container.querySelector('div.relative.px-4.py-3.grow');
                        if (info) {
                            const match = info.textContent.match(/(\d+\.?\d*)\s*\d+\s*reviews?/i);
                            return match ? match[1] : '';
                        }
                        return '';
                    })();
                    
                    const dateItems = container.querySelectorAll(selectors.dates);
                    dateItems.forEach((item) => {
                        const fullText = item.textContent.trim();
                        const dateMatch = fullText.match(/\d{1,2}\s+\w{3}\s+\d{4}|\d{1,2}\/\d{1,2}\/\d{4}/i);
                        if (!dateMatch) return;
                        
                        const priceMatch = fullText.match(/\$\s*[\d,]+/);
                        const availMatch = fullText.match(/(available|FULL|only\s+\d+\s+spaces?\s+left)/i);
                        const durationMatch = fullText.match(/\d+D\/\d+N/i);
                        
                        const availability = availMatch ? availMatch[1].toLowerCase() : '';
                        const isFull = availability.includes('full');
                        const spotsMatch = availability.match(/(\d+)/);
                        const spotsLeft = spotsMatch ? parseInt(spotsMatch[1]) : (availability.includes('available') ? 10 : 0);
                        
                        if (isFull || spotsLeft === 0) return;
                        
                        const priceStr = priceMatch ? priceMatch[0] : '';
                        const originalPrice = parseFloat(priceStr.replace(/[^0-9.]/g, '')) || 0;
                        const yourPrice = originalPrice > 0 ? (originalPrice * (1 + markup)).toFixed(2) : '';
                        
                        trips.push({
                            name: tripName,
                            date: dateMatch[0],
                            duration: durationMatch ? durationMatch[0] : '',
                            price: priceStr,
                            availability: availability || 'unknown',
                            isAvailable: availability.includes('available'),
                            spotsLeft: spotsLeft,
                            yourPrice: yourPrice ? `$${yourPrice}` : '',
                            rating: rating,
                            description: description,
                            photo: photo,
                            reconocidoAt: new Date().toISOString()
                        });
                    });
                } catch (error) {
                    console.error(`Error parsing container ${containerIndex}:`, error);
                }
            });
            
            return trips;
        }, CONFIG.selectors, CONFIG.markup);
        
        console.log(`Found ${trips.length} available trips (FULL trips excluded)`);
        
        if (!fs.existsSync('./data')) {
            fs.mkdirSync('./data');
        }
        
        const output = {
            lastUpdated: new Date().toISOString(),
            totalTrips: trips.length,
            filteredOut: 'FULL trips excluded from results',
            source: 'l-a.com',
            trips: trips
        };
        
        fs.writeFileSync(CONFIG.output_file, JSON.stringify(output, null, 2));
        console.log(`Data saved to ${CONFIG.output_file}`);
        
        return output;
        
    } finally {
        await browser.close();
    }
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
