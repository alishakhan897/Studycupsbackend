from playwright.sync_api import sync_playwright

def safe(node):
    try:
        return node.inner_text().strip()
    except:
        return None

def scrape_college_courses(page, url):
    # ===============================================================
    # STEP 1: Main Course Data Scraping (Duration, Mode, Reviews)
    # ===============================================================
    page.goto(url + "/courses-fees", timeout=0)
    page.wait_for_timeout(2000)
    page.mouse.wheel(0, 2500)
    page.wait_for_timeout(4000)

    course_entries = []
    cards = page.query_selector_all("div.course-card")

    for c in cards:
        try:
            c.scroll_into_view_if_needed()
            page.wait_for_timeout(300)
        except:
            pass

        name = safe(c.query_selector("a.text-primary-black"))
        fees = safe(c.query_selector("span.fs-18.text-primary-green"))
        rating = safe(c.query_selector("span.font-weight-medium.text-primary-black"))

        # Reviews
        reviews = None
        try:
            node = c.query_selector("a[href*='reviews']")
            if node:
                text = safe(node)
                if text:
                    reviews = text.strip().replace("(", "").replace(")", "")
        except:
            pass

        # Duration, Mode, and Course Count
        duration = None
        mode = None
        course_count = None
        span_list = c.query_selector_all("span.course-separater")

        for span in span_list:
            text = safe(span)
            if not text: continue
            if "Year" in text or "Month" in text:
                duration = text
            elif "Full Time" in text or "Part Time" in text or "Distance" in text:
                mode = text
            elif "Course" in text:
                course_count = text

        # Eligibility & Application Dates
        eligibility = safe(c.query_selector("div.eligibility-section div.fs-14"))
        application_dates = safe(c.query_selector("div.application-section div.fs-14"))

        # URL for Sub-courses
        link_node = c.query_selector("a.text-primary-black")
        href = None
        if link_node:
            href = link_node.get_attribute("href") or ""
            if href.startswith("/"):
                href = "https://collegedunia.com" + href

        course_entries.append({
            "name": name,
            "fees": fees,
            "rating": rating,
            "reviews": reviews,
            "course_count": course_count,
            "duration": duration,
            "mode": mode,
            "eligibility": eligibility,
            "application_dates": application_dates,
            "url": href,
            "sub_courses": [],
        })

    # ===============================================================
    # STEP 2: Sub-course Details Scraping
    # ===============================================================
    final_results = []
    for course in course_entries:
        if not course["url"]:
            final_results.append(course)
            continue

        page.goto(course["url"], timeout=0)
        page.wait_for_timeout(2000)
        page.mouse.wheel(0, 10000)
        page.wait_for_timeout(1500)

        try:
            btn = page.query_selector("span:text('View More') >> xpath=ancestor::div[@type='button']")
            if btn:
                btn.click()
                page.wait_for_timeout(1500)
        except:
            pass

        subcards = page.query_selector_all("div.course-card.border-gray-5.rounded-8.p-2")
        sub_list = []
        for sc in subcards:
            sub_name = safe(sc.query_selector("div.course-detail.d-flex.justify-content-between.text-primary-black"))
            sub_fees = safe(sc.query_selector("div.text-end.text-primary-green"))
            sub_list.append({"name": sub_name, "fees": sub_fees})

        course["sub_courses"] = sub_list
        final_results.append(course)

    return final_results

# ===============================================================
# TEST BLOCK: EXACT FORMATTED OUTPUT
# ===============================================================
if __name__ == "__main__":
    test_url = "https://collegedunia.com/university/25946-iim-lucknow"

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=False)
        page = browser.new_page()

        print("Scraping Data... Please wait.")
        output = scrape_college_courses(page, test_url)

        print("\n" + "="*40)
        for c in output:
            print(f"Name: {c['name']}")
            print(f"Fees: {c['fees']}")
            print(f"Rating: {c['rating']}")
            print(f"Reviews: {c['reviews']}")
            print(f"Course Count: {c['course_count']}")
            print(f"Duration: {c['duration']}")
            print(f"Mode: {c['mode']}")
            print(f"Eligibility: {c['eligibility']}")
            print(f"Application Dates: {c['application_dates']}")
            
            # Sub-courses Array Format
            sub_count = len(c['sub_courses'])
            print(f"sub_courses Array ({sub_count})")
            
            for idx, sub in enumerate(c['sub_courses']):
                print(f"{idx}: Object")
                print(f"  name: \"{sub['name']}\"")
                print(f"  fees: \"{sub['fees']}\"")
            
            print(f"Subcourse Count: {sub_count}")
            print("-" * 40)

        browser.close()