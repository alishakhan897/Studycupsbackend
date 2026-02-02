import os
import json
import asyncio
from playwright.async_api import async_playwright

async def expand_all_sections(page):
    """Sari hidden details, accordions aur 'View More' buttons ko click karke kholna"""
    print("Expanding all sections...")
    
    # 1. Page ko scroll karna taaki lazy-loaded buttons trigger ho jayein
    await page.mouse.wheel(0, 5000)
    await page.wait_for_timeout(2000)

    # 2. Common 'View More' selectors ko target karna
    selectors = [
        "text=View More", 
        "text=Read More", 
        ".view-all-button", 
        ".show-more", 
        "text=Show All"
    ]
    
    for selector in selectors:
        try:
            # Jitne bhi buttons milein, un sab par click karo
            buttons = await page.locator(selector).all()
            for btn in buttons:
                if await btn.is_visible():
                    await btn.click()
                    await page.wait_for_timeout(500)
        except:
            continue

async def scrape_iima_complete(page):
    # Sab kuch expand karo pehle
    await expand_all_sections(page)
    
    print("Extracting full data...")
    
    data = await page.evaluate('''() => {
        const getEl = (sel) => document.querySelector(sel)?.innerText.trim() || null;
        
        // Identity with specific selectors based on your screenshots
        const identity = {
            college_name: getEl('h1'),
            location: getEl('.location-info') || getEl('.location'),
            rating: getEl('.rating-block .rating-value') || getEl('.common-rating .rating-text'),
            logo: document.querySelector('.school-logo img, .institute-logo img')?.src || null,
            ownership: getEl('.institute-type')
        };

        // Courses extraction from expanded table
        const courses = Array.from(document.querySelectorAll('table tr'))
            .map(row => {
                let cols = row.querySelectorAll('td');
                if (cols.length >= 3) {
                    return {
                        course_name: cols[0].innerText.trim().split('\\n')[0],
                        tuition_fees: cols[1].innerText.trim().replace('Get Fee Details', ''),
                        eligibility: cols[2].innerText.trim().replace(/\\n/g, ' ')
                    };
                }
                return null;
            }).filter(c => c && c.course_name);

        // Placement table extraction
        let placements = {};
        document.querySelectorAll('table').forEach(table => {
            if(table.innerText.toLowerCase().includes('placement')) {
                let rows = table.querySelectorAll('tr');
                rows.forEach(row => {
                    let cells = row.querySelectorAll('td, th');
                    if(cells.length > 1) {
                        placements[cells[0].innerText.trim()] = Array.from(cells).slice(1).map(c => c.innerText.trim());
                    }
                });
            }
        });

        return { identity, courses, placements };
    }''')
    return data

async def main():
    async with async_playwright() as p:
        # User preference: iPhone 13 profile for premium feel
        browser = await p.chromium.launch(headless=False)
        context = await browser.new_context(**p.devices["iPhone 13"])
        page = await context.new_page()

        url = "https://www.shiksha.com/college/iim-ahmedabad-indian-institute-of-management-vastrapur-307/courses"
        
        await page.goto(url, wait_until="networkidle")
        await page.wait_for_timeout(5000)

        final_result = await scrape_iima_complete(page)

        with open("iima_full_deep_scan.json", "w", encoding="utf-8") as f:
            json.dump(final_result, f, indent=4)
        
        print("Success! Deep scan complete.")
        await browser.close()

if __name__ == "__main__":
    asyncio.run(main())