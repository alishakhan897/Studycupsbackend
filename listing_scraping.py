from playwright.sync_api import sync_playwright
from pymongo import MongoClient, UpdateOne
from dotenv import load_dotenv
import os
import time
import re

# ---------- LOAD ENV ----------
load_dotenv()

MONGO_URI = os.getenv("MONGO_URI")
DB_NAME = "studycups"
COLLECTION_NAME = "college_listings"

URL = "https://collegedunia.com/top-mba-colleges-in-india"

# ---------- HELPERS ----------
def clean(text):
    if not text:
        return None
    return " ".join(text.replace("\n", " ").split())

def extract_bg_url(style):
    if not style:
        return None
    match = re.search(r'url\(["\']?(.*?)["\']?\)', style)
    return match.group(1) if match else None

# ---------- MONGO ----------
client = MongoClient(MONGO_URI)
db = client[DB_NAME]
collection = db[COLLECTION_NAME]

# ---------- SCRAPER ----------
def scrape_and_save():
    seen_urls = set()
    no_new_rounds = 0

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=False)
        page = browser.new_page()
        page.goto(URL, timeout=120000)
        page.wait_for_selector("tbody > tr", timeout=60000)

        last_height = 0

        while True:
            rows = page.query_selector_all("tbody > tr")
            found_new = False
            bulk_ops = []

            for row in rows:
                try:
                    # ---------- COLLEGE NAME + URL ----------
                    name_el = row.query_selector("a.college_name")
                    if not name_el:
                        continue

                    name = clean(name_el.inner_text())
                    href = name_el.get_attribute("href")
                    college_url = "https://collegedunia.com" + href

                    if college_url in seen_urls:
                        continue

                    seen_urls.add(college_url)
                    found_new = True

                    # ---------- LOGO URL ----------
                    logo_url = None

                    logo_img = row.query_selector("a.clg-logo img")
                    if logo_img:
                        logo_url = logo_img.get_attribute("data-src")
                        if not logo_url:
                            logo_url = logo_img.get_attribute("src")

                    if not logo_url:
                        logo_span = row.query_selector("a.clg-logo span")
                        if logo_span:
                            logo_url = extract_bg_url(logo_span.get_attribute("style"))

                    # ---------- LOCATION ----------
                    loc_el = row.query_selector("span.location")
                    location = clean(loc_el.inner_text()) if loc_el else None

                    # ---------- APPROVALS ----------
                    app_el = row.query_selector("span.approvals")
                    approvals = clean(app_el.inner_text()) if app_el else None

                    # ---------- PROGRAM (MBA / PGDM) ----------
                    program = None
                    program_el = row.query_selector("span.fee-shorm-form")
                    if program_el:
                        program = clean(program_el.inner_text())

                    # ---------- FEES ----------
                    fees = None
                    fees_el = row.query_selector("td.col-fees span.text-green")
                    if fees_el:
                        fees = clean(fees_el.inner_text())

                    # ---------- PLACEMENTS ----------
                    avg_package = None
                    highest_package = None
                    placement_score = None

                    placement_col = row.query_selector("td.col-placement")
                    if placement_col:
                        pkgs = placement_col.query_selector_all("span.text-green")
                        if len(pkgs) > 0:
                            avg_package = clean(pkgs[0].inner_text())
                        if len(pkgs) > 1:
                            highest_package = clean(pkgs[1].inner_text())

                        score_el = placement_col.query_selector("span.font-weight-bold")
                        if score_el:
                            placement_score = clean(score_el.inner_text())

                    # ---------- REVIEWS ----------
                    rating = None
                    reviews_count = None
                    review_col = row.query_selector("td.col-reviews")
                    if review_col:
                        r1 = review_col.query_selector("span.lr-key")
                        r2 = review_col.query_selector("span.lr-value")
                        rating = clean(r1.inner_text()) if r1 else None
                        reviews_count = clean(r2.inner_text()) if r2 else None

                    doc = {
                        "name": name,
                        "url": college_url,
                        "logo": logo_url,
                        "location": location,
                        "approvals": approvals,
                        "program": program,          # ✅ NEW FIELD
                        "fees": fees,
                        "placements": {
                            "average_package": avg_package,
                            "highest_package": highest_package,
                            "score": placement_score,
                        },
                        "reviews": {
                            "rating": rating,
                            "count": reviews_count,
                        },
                        "source": "collegedunia",
                        "updatedAt": time.time()
                    }

                    bulk_ops.append(
                        UpdateOne(
                            {"url": college_url},
                            {"$set": doc},
                            upsert=True
                        )
                    )

                    print(f"✔ Queued: {name} | {program}")

                except Exception as e:
                    print("Row error:", e)

            # ---------- BULK WRITE ----------
            if bulk_ops:
                collection.bulk_write(bulk_ops, ordered=False)
                print(f"💾 Saved {len(bulk_ops)} records")
            else:
                print("ℹ No new records this round")

            # ---------- STOP CONDITION ----------
            if not found_new:
                no_new_rounds += 1
            else:
                no_new_rounds = 0

            if no_new_rounds >= 5:
                print("✅ All colleges scraped successfully")
                break

            # ---------- SCROLL ----------
            page.evaluate("window.scrollBy(0, document.body.scrollHeight)")
            time.sleep(2)

            new_height = page.evaluate("document.body.scrollHeight")
            if new_height == last_height:
                time.sleep(2)
            last_height = new_height

        browser.close()

    print(
        "\n🎯 Total colleges in MongoDB:",
        collection.count_documents({"source": "collegedunia"})
    )

if __name__ == "__main__":
    scrape_and_save()
