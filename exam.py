from playwright.sync_api import sync_playwright
from bs4 import BeautifulSoup
import json, re, time


URL = "https://www.shiksha.com/engineering/jee-main-exam"


def clean(t):
    return re.sub(r"\s+", " ", t).strip() if t else None


def is_blocked(html: str) -> bool:
    return (
        "Access Denied" in html
        or "Something Went Wrong" in html
        or "blocked" in html.lower()
    )


def scrape_shiksha_exam(url):

    with sync_playwright() as p:
        browser = p.chromium.launch(
            headless=False,   # 🔴 IMPORTANT
            slow_mo=50
        )

        context = browser.new_context(
            viewport={"width": 1366, "height": 768},
            user_agent=(
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/122.0.0.0 Safari/537.36"
            ),
            extra_http_headers={
                "accept-language": "en-IN,en;q=0.9",
                "sec-fetch-site": "same-origin",
                "sec-fetch-mode": "navigate",
                "sec-fetch-user": "?1",
                "upgrade-insecure-requests": "1"
            }
        )

        page = context.new_page()

        page.goto(url, timeout=60000)
        page.wait_for_timeout(6000)

        html = page.content()

        if is_blocked(html):
            print("❌ BLOCK DETECTED — retrying once...")
            page.reload()
            page.wait_for_timeout(6000)
            html = page.content()

        browser.close()

    if is_blocked(html):
        raise Exception("Shiksha blocked the request (Access Denied)")

    soup = BeautifulSoup(html, "html.parser")

    data = {
        "exam_name": None,
        "exam_url": url,
        "overview": [],
        "important_updates": [],
        "eligibility": [],
        "syllabus": [],
        "faqs": []
    }

    # ================= EXAM NAME =================
    h1 = soup.select_one("h1")
    data["exam_name"] = clean(h1.text) if h1 else None

    # ================= OVERVIEW =================
    for p in soup.select("div._116d p"):
        txt = clean(p.text)
        if txt:
            data["overview"].append(txt)

    # ================= IMPORTANT DATES =================
    for row in soup.select("table tr"):
        tds = row.select("td")
        if len(tds) == 2:
            date = clean(tds[0].text)
            event = clean(tds[1].text)
            if date and event:
                data["important_updates"].append({
                    "date": date,
                    "event": event
                })

    # ================= ELIGIBILITY =================
    h = soup.find("h2", string=re.compile("Eligibility", re.I))
    if h:
        for li in h.find_next("div").select("li"):
            txt = clean(li.text)
            if txt:
                data["eligibility"].append(txt)

    # ================= SYLLABUS =================
    h = soup.find("h2", string=re.compile("Syllabus", re.I))
    if h:
        for li in h.find_next("div").select("li"):
            txt = clean(li.text)
            if txt:
                data["syllabus"].append(txt)

    # ================= FAQ =================
    for p in soup.select("p"):
        txt = clean(p.text)
        if txt and txt.lower().startswith("ques"):
            ans = p.find_next_sibling("p")
            if ans:
                data["faqs"].append({
                    "question": txt,
                    "answer": clean(ans.text)
                })

    return data


if __name__ == "__main__":
    result = scrape_shiksha_exam(URL)
    print(json.dumps(result, indent=2, ensure_ascii=False))
