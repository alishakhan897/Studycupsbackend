from playwright.sync_api import sync_playwright
from pymongo import MongoClient
from dotenv import load_dotenv
import os, time
import sys
import threading
import os
import signal 
import warnings 
import json
warnings.filterwarnings("ignore", category=DeprecationWarning)
warnings.filterwarnings("ignore", category=UserWarning)



# def force_exit():
#     print("[TIMEOUT] FORCE EXIT: Script took too long")
#     os.kill(os.getpid(), signal.SIGTERM)

# timer = threading.Timer(20, force_exit)  # 15 min
# timer.start()


load_dotenv()

MONGO_URI = os.getenv("MONGO_URI")
DB_NAME = "studycups"

client = MongoClient(MONGO_URI)
db = client[DB_NAME]

detail_collection = db["college_course_test"] 



def safe(node):
    try:
        return node.inner_text().strip() if node else None
    except:
        return None 

def safe_goto(page, url, wait=2000):
    page.goto(
        url,
        wait_until="domcontentloaded",
        timeout=60000
    )
    page.wait_for_timeout(wait)
    nuke_popups(page)



def handle_popups(page):
    selectors = [
        "button:has-text('Accept')",
        "button:has-text('I Agree')",
        "button:has-text('Allow')",
        "button:has-text('No Thanks')",
        "button:has-text('Skip')",
        "button:has-text('Later')",
        "button:has-text('Continue')",
        "button:has-text('×')",
        "button.close",
        "span.close",
        "div.close",
        "button[aria-label='close']",
        "div[class*='close']",
        "div[class*='Close']",
        "button[data-dismiss]",
        "div[role='dialog'] button"
    ]

    for sel in selectors:
        try:
            btns = page.query_selector_all(sel)
            for b in btns:
                if b.is_visible():
                    b.click()
                    page.wait_for_timeout(300)
        except:
            pass



def parse_fee(fee):
    if not fee:
        return None

    fee = fee.lower().strip()

    # remove ₹ , commas
    fee = fee.replace("₹","").replace(",","").strip()

    # if lakhs
    if "lakh" in fee:
        num = fee.split()[0]
        try:
            return int(float(num) * 100000)
        except:
            return None

    # plain number fallback
    try:
        return int(fee)
    except:
        return None

def build_fee_range(courses):
    values = []

    for c in courses:
        v = parse_fee(c.get("fees"))
        if v:
            values.append(v)

    if not values:
        return None

    return {
        "min": min(values),
        "max": max(values)
    }


###############################################################
# SCRAPE RATING CATEGORIES   (MAIN PAGE)
############################################################### 

def scrape_likes_dislikes(page, url):

    safe_goto(page, url, 2500)


    output = {
        "likes": [],
        "dislikes": []
    }

    #########################################
    # Expand READ MORE button if exists
    #########################################
    try:
        btns = page.query_selector_all(
            "button.jsx-2132319233.read-more-less-btn"
        )
        for b in btns:
            try:
                b.click()
                page.wait_for_timeout(500)
            except:
                pass
    except:
        pass

    #########################################
    # LIKE SECTION SCRAPING
    #########################################
    try:
        like_items = page.query_selector_all(
            "div#likes-dislikes ul li.jsx-2132319233.mb-3.like-dislike__list-item"
        )

        for li in like_items:

            text = safe(li)

            # clean garbage markers
            if text:
                text = text.replace("::marker", "").strip()

            # username extraction
            user = None
            a = li.query_selector("a")
            if a:
                user = safe(a).replace(", PGPM","").strip()

            if text:
                output["likes"].append({
                    "content": text,
                    "username": user
                })

    except:
        pass

    #########################################
    # DISLIKE SECTION SCRAPING
    #########################################
    try:

        dislike_items = page.query_selector_all(
            "div.dislike-section ul li.jsx-2132319233.mb-3.like-dislike__list-item"
        )

        for li in dislike_items:

            text = safe(li)
            if text:
                text = text.replace("::marker","").strip()

            user = None
            a = li.query_selector("a")
            if a:
                user = safe(a).replace(", PGPM","").strip()

            if text:
                output["dislikes"].append({
                    "content": text,
                    "username": user
                })

    except:
        pass

    return output


def scrape_rating_categories(page, url):

    safe_goto(page, url, 2000)


    categories = []

    cards = page.query_selector_all("div.rating-card")

    for card in cards:

        label = safe(
            card.query_selector("div.fs-14.font-weight-medium.text-primary-black")
        )

        rating_span = card.query_selector(
            "div.fs-14.font-weight-medium.margint-2.text-dark-grey span"
        )
        rating = safe(rating_span)

        if label and rating:
            categories.append({
                "label": label,
                "rating": rating
            })

    return categories



###############################################################
# SCRAPE GALLERY / STUDENT SNAPSHOTS
###############################################################

def make_gallery_url(url):

    if "/college/" in url:
        return url + "/gallery"

    if "/university/" in url:
        return url + "/gallery"

    return None


def scrape_gallery(page, url):

    gallery_url = make_gallery_url(url)
    if not gallery_url:
        return []

    safe_goto(page, gallery_url, 3000)


    last_height = 0
    for _ in range(15):
        page.mouse.wheel(0, 2500)
        page.wait_for_timeout(800)
        new_height = page.evaluate("document.body.scrollHeight")
        if new_height == last_height:
            break
        last_height = new_height

    results = []

    images = page.query_selector_all("div.img-container img")

    for img in images:

        src = img.get_attribute("data-src")

        if not src:
            src = img.get_attribute("src")

        if not src:
            continue

        if src.startswith("data:image"):
            continue

        category_node = img.evaluate_handle("node => node.closest('.img-container')")
        category = None
        try:
            category = safe(category_node.query_selector("div.photo-tag"))
        except:
            pass

        results.append({
            "image": src,
            "category": category
        })

    return results


###############################################################
# SCRAPE EXTERNAL Q&A
###############################################################

def scrape_qna(page, url):

    try:
        if "/university/" in url:
            college_id = url.split("/university/")[1].split("-")[0]
        else:
            college_id = url.split("/college/")[1].split("-")[0]
    except:
        return []

    qna_url = f"https://collegedunia.com/qna?college={college_id}"

    page.goto(qna_url, timeout=0)
    page.wait_for_timeout(2500)

    # Scroll to load full content
    last = 0
    for _ in range(30):
        page.mouse.wheel(0, 3500)
        page.wait_for_timeout(1200)
        new = page.evaluate("document.body.scrollHeight")
        if new == last:
            break
        last = new

    output = []

    cards = page.query_selector_all(
        "div.question-card-wrapper, div.question-card, div[data-test-id='ques-cont']"
    )

    for card in cards:

        q = {}

        title_node = card.query_selector("h3[data-test-id='question-card-title'] a, a.text-dark")
        q["question"] = safe(title_node)
        if title_node:
            href = title_node.get_attribute("href")
            q["question_url"] = "https://collegedunia.com" + href
        else:
            q["question_url"] = None

        author_node = card.query_selector("span.font-weight-bold, span.author-img + span")
        q["author"] = safe(author_node)

        role_node = card.query_selector("div.text-gray-800, div.text-md.font-weight-bold")
        q["role"] = safe(role_node)

        date_node = card.query_selector("span.posted-on, span.text-gray-500.posted-on")
        q["posted_date"] = safe(date_node)

        # answer text block
        para_nodes = card.query_selector_all(
            "div[data-test-id='ques-desc'] p, div[data-test-id='ques-desc'] li"
        )

        q["answer_text"] = " ".join([safe(x) for x in para_nodes if safe(x)])

        # Skip empty questions safely
        if q["question"]:
            output.append(q)

    return output


###############################################################
# SCRAPE PLACEMENT SECTION
###############################################################

def scrape_placement_data(page, url):

    safe_goto(page, url + "/placement", 3500)

    page.wait_for_timeout(3000)

    placement = {
        "highest_package": None,
        "average_package": None,
        "alumni": [],
        "companies": [],
        "education_background": [],
        "yearly_highest_avg": [],
    }


    ##############################################################
    # HIGHEST + AVERAGE PACKAGE  -> New selector
    ##############################################################
    try:
        highest_node = page.query_selector(
            "div.graph span.bg-primary-green, span.text-white.bg-primary-green"
        )
        placement["highest_package"] = safe(highest_node)
    except:
        placement["highest_package"] = None


    try:
        avg_node = page.query_selector(
            "div.graph span.bg-orange-shade, span.text-title.bg-orange-shade"
        )
        placement["average_package"] = safe(avg_node)
    except:
        placement["average_package"] = None



    ##############################################################
    # CLICK READ MORE – needed for education background table
    ##############################################################
    try:
        btns = page.query_selector_all(
            "button.read-more-less-btn, button[data-test-id='read-more']"
        )
        for b in btns:
            try:
                b.click()
                page.wait_for_timeout(1500)
            except:
                pass
    except:
        pass



    ##############################################################
    # EDUCATION BACKGROUND TABLE INSIDE READ MORE
    ##############################################################
    try:
        table = page.query_selector(
            "h3#4 + div.table-responsive table.table-striped"
        )

        if table:
            heads = [safe(x) for x in table.query_selector_all("tbody tr th")]
            rows = table.query_selector_all("tbody tr")[1:]

            for r in rows:
                cols = r.query_selector_all("td")
                if len(cols) >= 2:
                    placement["education_background"].append({
                        heads[0]: safe(cols[0]),
                        heads[1]: safe(cols[1])
                    })
    except:
        placement["education_background"] = []



    ##############################################################
    # YEAR WISE highest + median + average TABLE
    ##############################################################
    try:
        trend_table = page.query_selector(
            "table:has(th:text('Median Package')), table:has(th:text('Year'))"
        )

        if trend_table:

            headers = [safe(x) for x in trend_table.query_selector_all("thead th")]
            rows   = trend_table.query_selector_all("tbody tr")

            for r in rows:
                cols = r.query_selector_all("td")

                obj = {}
                for i,c in enumerate(cols):
                    key = headers[i] if i < len(headers) else f"col_{i}"
                    obj[key] = safe(c)

                placement["yearly_highest_avg"].append(obj)

    except:
        pass


    ##############################################################
    # TOP COMPANIES LIST
    ##############################################################
    try:
        rows = page.query_selector_all("tbody.jsx-1034654049 tr")
        for r in rows:
            cols = r.query_selector_all("td")
            for cell in cols:
                v = safe(cell)
                if v and v not in placement["companies"]:
                    placement["companies"].append(v)
    except:
        pass


    ##############################################################
    # ALUMNI graph
    ##############################################################
    try:
        alumni_rows = page.query_selector_all("section.company-wrapper div.graph")
        for r in alumni_rows:
            text = safe(r.query_selector("span"))
            if text:
                placement["alumni"].append(text)
    except:
        pass


    return placement


###############################################################
# SCRAPE COLLEGE COURSE SUMMARY CARDS
###############################################################

def scrape_college_courses(page, url):
    # ===============================================================
    # STEP 1: Main Course Data Scraping (Duration, Mode, Reviews)
    # ===============================================================
    safe_goto(page, url + "/courses-fees", 4000)

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

        safe_goto(page, course["url"], 3000)

        page.wait_for_timeout(2000)
        page.mouse.wheel(0, 10000)
        page.wait_for_timeout(1500)

        while True:
            btn = page.query_selector(
                "span:text('View More') >> xpath=ancestor::div[@type='button']"
            )
            if not btn:
                break
            btn.click()
            page.wait_for_timeout(1200)

        subcards = page.query_selector_all("div.course-card.border-gray-5.rounded-8.p-2")
        sub_list = []
        for sc in subcards:
            sub_name = safe(sc.query_selector("div.course-detail.d-flex.justify-content-between.text-primary-black"))
            sub_fees = safe(sc.query_selector("div.text-end.text-primary-green"))
            sub_url = None
            link_node = sc.query_selector("a")
            if link_node:
                href = link_node.get_attribute("href")
                if href and href.startswith("/"):
                    sub_url = "https://collegedunia.com" + href

            sub_list.append({"name": sub_name,"fees": sub_fees,"url": sub_url, "details": None})
        course["sub_courses"] = sub_list
        final_results.append(course)

    return final_results

###############################################################
# SCRAPE MAIN INFO
############################################################### 

 
def scrape_main_info(page,url):

    data = {}

    safe_goto(page, url, 2000)

    

    # extract correct full college brand name
    try:
        node = page.query_selector("div.header_info.ml-3")
        full_name = safe(node)
        if full_name:
            data["full_name"] = full_name
        else:
        # fallback: take everything before colon
            seo = safe(page.query_selector("h1#collegePageTitle"))
            data["full_name"] = seo.split(":")[0].strip() if seo else None
    except:
        data["full_name"] = None

    data["college_name"] = safe(page.query_selector("h1#collegePageTitle"))
    data["location"]     = safe(page.query_selector("div.college_header_details span.text-white"))
    
        # extract estd year & college type correctly
    nodes = page.query_selector_all("span.clg-detail-separater")

    estd_year = None
    college_type = None

    for n in nodes:
        txt = safe(n)
        if not txt:
            continue

        if "Estd" in txt:
            estd_year = txt.replace("Estd","").strip()
        else:
            college_type = txt

    data["estd_year"] = estd_year
    data["college_type"] = college_type


    data["rating"]       = safe(page.query_selector("div.fs-30.font-weight-bold"))

    review_node = page.query_selector("div.rating a[href*='reviews']")
    data["review_count"] = safe(review_node)

    about_ps = page.query_selector_all("#listing-article p")
    data["about_text"] = " ".join([safe(x) for x in about_ps if safe(x)])

    about_bullets = page.query_selector_all("#listing-article li")
    data["about_list"] = [safe(x) for x in about_bullets if safe(x)]

    try:
        logo_node = page.query_selector("img[src*='logos']")
        if logo_node:
            data["logo"] = logo_node.get_attribute("src")
        else:
            data["logo"] = None
    except:
        data["logo"] = None

    return data



###############################################################
# SCRAPE NEWS
###############################################################

def get_latest_news(page):

    news_section = page.query_selector("div.jsx-1921587171.whats-new-description")
    if not news_section:
        return []

    articles = []

    blocks = news_section.query_selector_all("p")

    for block in blocks:

        item = {}

        item["date"] = safe(block.query_selector("strong.text-red"))

        strongs = block.query_selector_all("strong")
        if len(strongs) > 1:
            item["headline"] = safe(strongs[1])
        else:
            item["headline"] = None

        item["content"] = safe(block)
        item["points"] = []

        articles.append(item)

    return articles



###############################################################
# FULL-TIME COURSE TABLE
###############################################################

def scrape_full_time(page, url):

    page.goto(url + "/courses-fees", timeout=0)
    page.wait_for_timeout(1500)

    results = []

    rows = page.query_selector_all("table.table-new:nth-of-type(1) tbody tr")

    for r in rows:

        cols = r.query_selector_all("td")
        if len(cols) < 3:
            continue

        course = safe(cols[0])
        if not course:
            continue

        trash = ["student", "placed", "admitted", "518"]
        if any(x in course.lower() for x in trash):
            continue

        results.append(
            {
                "course": course,
                "fees": safe(cols[1]),
                "eligibility": safe(cols[2]),
                "date": safe(cols[3]) if len(cols)>=4 else None,
            }
        )

    return results



###############################################################
# PART-TIME COURSE TABLE
###############################################################

def scrape_part_time(page, url):

    page.goto(url + "/courses-fees", timeout=0)
    page.wait_for_timeout(1500)

    results = []

    rows = page.query_selector_all("table.table-new:nth-of-type(2) tbody tr")

    for r in rows:

        cols = r.query_selector_all("td")
        if len(cols) < 3:
            continue

        course = safe(cols[0])
        if not course:
            continue

        results.append(
            {
                "course": course,
                "fees": safe(cols[1]),
                "eligibility": safe(cols[2]),
                "date": safe(cols[3]) if len(cols)>=4 else None,
            }
        )

    return results


def scrape_reviews(page, url):

    safe_goto(page, url + "/reviews", 3000)

    page.wait_for_timeout(3000)

    output = {
        "summary": {
            "likes": [],
            "dislikes": []
        },
        "students": []
    }

    ##########################################################
    # 1️⃣ GLOBAL SUMMARY LIKE/DISLIKE SECTION
    ##########################################################

    # global likes
    try:
        like_items = page.query_selector_all(
            "div#likes-dislikes ul li.jsx-2132319233.mb-3.like-dislike__list-item"
        )
        for li in like_items:
            t = safe(li)
            if t:
                t = t.replace("::marker","").strip()
                output["summary"]["likes"].append(t)

    except:
        pass

    # global dislikes

    try:
        dislike_items = page.query_selector_all(
            "div.dislike-section ul li.jsx-2132319233.mb-3.like-dislike__list-item"
        )
        for li in dislike_items:
            t = safe(li)
            if t:
                t = t.replace("::marker","").strip()
                output["summary"]["dislikes"].append(t)

    except:
        pass


    ##########################################################
    # 2️⃣ INDIVIDUAL STUDENT REVIEWS
    ##########################################################

    review_cards = page.query_selector_all("div.jsx-3091098665.clg-review-card")

    for card in review_cards:

        student = {}

        # student name
        student["name"] = safe(
            card.query_selector("span.font-weight-semi.text-primary-black")
        )

        # rating number
        student["rating"] = safe(
            card.query_selector("span.fs-16.font-weight-semi.text-dark-grey")
        )

        # course name
        student["course"] = safe(
            card.query_selector("div.mb-1 a span")
        )

        # review date
        student["date"] = safe(
            card.query_selector("span:text('Reviewed on')")
        )

        # heading title
        student["title"] = safe(
            card.query_selector("h2.fs-16.font-weight-semi.text-primary-black")
        )

        ###################################################
        # student LIKE bullet points
        ###################################################
        likes_arr = []

        likes_li = card.query_selector_all(
            "section.jsx-2132319233.like-dislike-section ul li.jsx-2132319233.mb-3.like-dislike__list-item"
        )

        for li in likes_li:
            tx = safe(li)
            if tx:
                tx = tx.replace("::marker","").strip()
                likes_arr.append(tx)

        student["likes"] = likes_arr

        ###################################################
        # student DISLIKE bullet points
        ###################################################
        dislikes_arr = []

        d_li = card.query_selector_all(
            "div.dislike-section ul li.jsx-2132319233.mb-3.like-dislike__list-item"
        )

        for li in d_li:
            tx = safe(li)
            if tx:
                tx = tx.replace("::marker","").strip()
                dislikes_arr.append(tx)

        student["dislikes"] = dislikes_arr

        ###################################################
        # add to output only valid reviews
        ###################################################
        if student["name"] or student["title"]:
            output["students"].append(student)

    return output

###############################################################
# IMPORTANT DATES TABLE
############################################################### 

def detect_stream(page, url):
    try:
        page.goto(url + "/ranking", timeout=0)
        page.wait_for_timeout(2000)

        node = page.query_selector("td.stream-category a")

        value = safe(node)

        if value:
            return value.strip()

    except:
        return None

def scrape_ranking(page, url):

    page.goto(url + "/ranking", timeout=0)
    page.wait_for_timeout(2500)

    results = []

    rows = page.query_selector_all("table#cutoff-table tbody tr")

    for r in rows:

        cols = r.query_selector_all("td")
        if len(cols) < 2:
            continue

        stream = safe(cols[0].query_selector("a"))

        rank_text = safe(cols[1])
        if not rank_text:
            continue

        stream = stream.replace("\n", "").strip() if stream else None
        rank_text = rank_text.replace("\xa0", " ").strip()

        results.append({
            "stream": stream,
            "ranking": rank_text
        })

    return results


def scrape_important_dates(page, url):

    safe_goto(page, url + "/dates", 2500)

    page.wait_for_timeout(2000)

    result = {
        "upcoming_events": [],
        "expired_events": []
    }

    # get section containers - page contains 2 sections
    containers = page.query_selector_all("div.application-dates.position-relative")

    if len(containers) < 2:
        return result

    upcoming_table = containers[0].query_selector("table#application-dates-table tbody")
    expired_table = containers[1].query_selector("table#application-dates-table tbody")

    # ---- UPCOMING EVENTS -----
    if upcoming_table:
        rows = upcoming_table.query_selector_all("tr")
        for r in rows:
            cols = r.query_selector_all("td")
            if len(cols) >= 2:
                result["upcoming_events"].append({
                    "event": safe(cols[0]),
                    "date": safe(cols[1])
                })

    # ---- SCROLL THROUGH 4 PROGRAM TABS ----
    tab_buttons = page.query_selector_all(
        "button[type='button'], a.pill-detail-container"
    )

    visited_programs = set()

    for btn in tab_buttons:

        txt = safe(btn)
        if not txt:
            continue

        # avoid duplicates
        if txt in visited_programs:
            continue

        visited_programs.add(txt)

        try:
            btn.click()
            page.wait_for_timeout(1500)
        except:
            continue

        expired_block = page.query_selector_all("h2")

        for h in expired_block:
            if safe(h) and "Expired" in safe(h):
                table = h.evaluate_handle(
                    "node => node.nextElementSibling.querySelector('tbody')"
                )

                if table:
                    rows = table.query_selector_all("tr")

                    for r in rows:

                        cols = r.query_selector_all("td")

                        if len(cols) >= 2:
                            result["expired_events"].append({
                                "program": txt,
                                "event": safe(cols[0]),
                                "date": safe(cols[1])
                            })

    return result

###############################################################
# ADD: SCRAPING COURSE DETAIL PAGE
###############################################################

def scrape_course_detail(page, course_url):

    safe_goto(page, course_url, 3000)

    page.wait_for_timeout(3000)

    info = {}

    #######################################################
    # 1) HEADING (course name + fees heading)
    #######################################################
    try:
        h = page.query_selector("div.single-course-article-card h2")
        info["heading"] = safe(h)
    except:
        info["heading"] = None


    #######################################################
    # 2) OVERVIEW PARAGRAPH BLOCKS
    #######################################################
    try:
        ps = page.query_selector_all(
            "div.single-course-article-card div.content-wrapper p"
        )

        info["overview_paragraphs"] = [safe(x) for x in ps if safe(x)]
    except:
        info["overview_paragraphs"] = []


    #######################################################
    # 3) SUB HEADINGS (h4 sections)
    #######################################################
    try:
        sub = page.query_selector_all(
            "div.single-course-article-card div.content-wrapper h4"
        )

        info["sub_titles"] = [safe(x) for x in sub if safe(x)]
    except:
        info["sub_titles"] = []


    #######################################################
    # 4) FIRST CUTOFF TABLE
    #######################################################
    try:

        rows = page.query_selector_all(
            "div.single-course-article-card div.content-wrapper table tbody tr"
        )

        table_data = []

        for r in rows:
            cols = r.query_selector_all("td")
            if len(cols) >= 3:
                table_data.append({
                    "category": safe(cols[0]),
                    "cutoff_2024": safe(cols[1]),
                    "cutoff_2023": safe(cols[2])
                })

        info["cutoff_table"] = table_data

    except:
        info["cutoff_table"] = []


    #######################################################
    # 5) FULL TEXT MERGED
    #######################################################
    try:
        nodes = page.query_selector_all(
            "div.single-course-article-card div.content-wrapper p, div.single-course-article-card div.content-wrapper li"
        )

        info["overview_full_text"] = " ".join([safe(x) for x in nodes if safe(x)])

    except:
        info["overview_full_text"] = None


    #######################################################
    # 6) HIGHLIGHTS TABLE (SEPARATE)
    #######################################################
    try:
        highlight_rows = page.query_selector_all(
            "table.table-new tbody tr"
        )

        hmap = {}

        for r in highlight_rows:
            cols = r.query_selector_all("td")
            if len(cols) == 2:
                k = safe(cols[0]).lower().strip(": ")
                v = safe(cols[1]).strip()
                hmap[k] = v

        info["highlights"] = hmap

    except:
        info["highlights"] = {}


    #######################################################
    # 7) APPLICATION DATE
    #######################################################
    try:
        app = safe(page.query_selector("div.application-date span"))
        info["application_date"] = app
    except:
        info["application_date"] = None


    #######################################################
    # 8) LATEST NEWS UNDER COURSE
    #######################################################
    try:

        news_nodes = page.query_selector_all(
            "div.whats-new-description p"
        )

        info["latest_news"] = [safe(x) for x in news_nodes if safe(x)]

    except:
        info["latest_news"] = []
    
        #######################################################
    # 9) READ MORE TABLE SCRAPING (NEW)
    #######################################################
    try:
        # CLICK READ MORE IF PRESENT
        btn = page.query_selector("button:has-text('Read More')")
        if btn:
            btn.click()
            page.wait_for_timeout(1500)

        # SCRAPE TABLE DATA
        final_rows = page.query_selector_all(
            "table.table-striped.style_table tbody tr"
        )

        read_more_table = []

        for r in final_rows:
            cols = r.query_selector_all("td")

            # only valid row structures
            if len(cols) == 2:
                read_more_table.append({
                    "title": safe(cols[0]),
                    "value": safe(cols[1])
                })

        info["read_more_table"] = read_more_table

    except:
        info["read_more_table"] = []


    return info

def scrape_yearly_students_placed(page, url):

    page.goto(url + "/placement", timeout=0)
    page.wait_for_timeout(2500)

    # ----- SELECT 2ND TABLE WHERE STUDENTS ARE PLACED -----
    tables = page.query_selector_all("table.jsx-3180351000.table-new.table-font-14")

    if not tables or len(tables) < 2:
        return None

    table = tables[1]     # yearly students placed table

    # ---- Get yearly headers ----
    headers = []
    ths = table.query_selector_all("thead tr th")

    for th in ths:
        head = safe(th)
        if head and head.lower() != "particulars":
            headers.append(head)

    # ---- Extract body rows ----
    rows_out = []

    rows = table.query_selector_all("tbody tr")

    for r in rows:
        cols = r.query_selector_all("td")

        if len(cols) < 2:
            continue

        title = safe(cols[0])
        row_obj = {"title": title}

        for i, year in enumerate(headers, start=1):
            try:
                row_obj[year] = safe(cols[i])
            except:
                row_obj[year] = None

        rows_out.append(row_obj)

    return rows_out

def scrape_facilities(page, url):

    page.goto(url, timeout=0)
    page.wait_for_timeout(2500)

    results = []

    # facility container matches your DOM
    cards = page.query_selector_all(
        "div.jsx-1769494733.img-container.d-flex.flex-column.align-items-center.justify-content-center"
    )

    for c in cards:

        # facility name
        name_node = c.query_selector("div.name")
        name = safe(name_node)

        if not name:
            continue

        # extract icon_key from span class
        icon_key = None
        span = c.query_selector("span")
        if span:
            cls = span.get_attribute("class")  # full class string
            if cls:
                parts = cls.split()
                # clean JSX + structural classes
                for p in parts:
                    if (
                        p not in ["facility-images", "d-block"] and
                        not p.startswith("jsx-")
                    ):
                        icon_key = p
                        break

        results.append({
            "name": name,
            "icon_key": icon_key
        })

    return results 

def scrape_faculty(page, url):

    page.goto(url, timeout=0)
    page.wait_for_timeout(2000)

    # open full faculty page
    try:
        btn = page.query_selector("a[href*='/faculty']")
        if btn:
            btn.click()
            page.wait_for_timeout(2500)
    except:
        pass

    # ensure faculty page opened
    if "/faculty" not in page.url:
        return []

    # scroll to load all cards
    last_height = 0
    for _ in range(20):
        page.mouse.wheel(0, 2500)
        page.wait_for_timeout(600)
        new_height = page.evaluate("document.body.scrollHeight")
        if new_height == last_height:
            break
        last_height = new_height

    results = []

    cards = page.query_selector_all(
        "div.faculty-card, div.jsx-2015978497.faculty-card"
    )

    for card in cards:

        # name
        name = safe(
            card.query_selector("div.fs-16.font-weight-semi.text-primary-black")
        )

        # designation
        designation = safe(
            card.query_selector(
                "div.faculty-des, div.fs-12.font-weight-medium.text-gray"
            )
        )

        # qualification (optional)
        qualification = None
        qnode = card.query_selector("div:nth-child(3)")
        if qnode:
            q = safe(qnode)
            if q and q != name and q != designation:
                qualification = q

        if name:
            results.append({
                "name": name,
                "designation": designation,
                "qualification": qualification,
            })

    return results

def scrape_course_fee_structure(page, url):

    page.goto(url + "/courses-fees", timeout=0)
    page.wait_for_timeout(2500)

    output = {
        "course_fee_heading": None,
        "course_fee_table": [],
        "course_fee_note": []
    }

    # =============== CLICK READMORE IF EXISTS ====================
    try:
        read_btns = page.query_selector_all(
            "button.read-more-less-btn, button[data-test-id='read-more']"
        )
        for b in read_btns:
            try:
                b.click()
                page.wait_for_timeout(800)
            except:
                pass
    except:
        pass


    # =================== HEADING TEXT ABOVE TABLE =================
    heading_node = page.query_selector(
        "div#listing-article p"
    )

    output["course_fee_heading"] = safe(heading_node)


    # ======================= TABLE SCRAPING ========================
    table = page.query_selector(
        "table.table.table-striped.style_table"
    )

    if table:

        # get header labels
        headers = []
        ths = table.query_selector_all("thead tr th")
        for th in ths:
            h = safe(th)
            headers.append(h)

        rows = table.query_selector_all("tbody tr")

        for r in rows:
            cols = r.query_selector_all("td")
            row_data = {}

            for i, td in enumerate(cols):
                col_name = headers[i] if i < len(headers) else f"col_{i}"
                row_data[col_name] = safe(td)

            output["course_fee_table"].append(row_data)



    # ===================== NOTE UNDER TABLE =========================

    # Notes exist under <p>* Note:</p> → <ul><li></li></ul>
    note_items = page.query_selector_all(
        "div#listing-article ul li"
    )

    for li in note_items:
        txt = safe(li)
        if txt:
            output["course_fee_note"].append(txt)


    return output

def scrape_mba_fees_text(page, url):

    page.goto(url + "/courses-fees", timeout=0)
    page.wait_for_timeout(2000)


    heading = None
    description = None

    # first try: exact h2 containing MBA fees text
    h2_nodes = page.query_selector_all("h2")

    for h in h2_nodes:
        txt = safe(h)
        if txt and "MBA fees" in txt.lower():
            heading = txt

            # find first <p> below
            p = h.evaluate_handle(
                "el => el.nextElementSibling && el.nextElementSibling.tagName === 'P' ? el.nextElementSibling : null"
            ).as_element()

            description = safe(p)
            break

    return {
        "heading": heading,
        "description": description
    }

# MAIN FUNCTION
############################################################### 

def scrape_admission(page, url):

    page.goto(url + "/admission", timeout=0)
    page.wait_for_timeout(2500)

    sections = page.query_selector_all("div[id='listing-article'] div[class*='cdcms_section']")

    result = []

    for sec in sections:

        block = {}

        # id name
        try:
            block["id"] = sec.get_attribute("class")
        except:
            block["id"] = None

        # heading detection
        heading = sec.query_selector("h2, h3")
        block["title"] = safe(heading)

        # paragraphs
        ps = sec.query_selector_all("p")
        block["paragraphs"] = [safe(x) for x in ps if safe(x)]

        # bullet list
        bullets = []
        lis = sec.query_selector_all("ul li")
        for li in lis:
            txt = safe(li)
            if txt:
                bullets.append(txt)
        block["bullets"] = bullets

        # tables
        tables = []
        tbs = sec.query_selector_all("table")

        for tb in tbs:

            rows = tb.query_selector_all("tbody tr")
            table_rows = []

            for r in rows:
                cols = r.query_selector_all("td, th")
                table_rows.append([safe(x) for x in cols])

            if table_rows:
                tables.append(table_rows)

        block["tables"] = tables

        result.append(block)

    return result

def nuke_popups(page):
    try:
        # Close buttons
        selectors = [
            "button[aria-label='close']",
            "button.close",
            "span.close",
            "div.close",
            "button:has-text('×')",
            "button:has-text('Skip')",
            "button:has-text('Later')",
            "button:has-text('No Thanks')",
            "button:has-text('Continue')",
            "button:has-text('Close')",
            "div[role='dialog'] button",
        ]

        for sel in selectors:
            for b in page.query_selector_all(sel):
                if b.is_visible():
                    b.click()
                    page.wait_for_timeout(300)

        # Remove modal + overlay forcefully
        page.evaluate("""
            () => {
                document.querySelectorAll(
                  'div[role="dialog"], .modal, .cd-modal, .ReactModal__Overlay'
                ).forEach(e => e.remove());

                document.querySelectorAll(
                  '.modal-backdrop, .overlay, .backdrop'
                ).forEach(e => e.remove());

                document.body.style.overflow = 'auto';
            }
        """)
    except:
        pass


def scrape_single_college(url):

    with sync_playwright() as p:

        browser = p.chromium.launch(
            headless=False,
            slow_mo=100,
            args=[
                "--disable-notifications",
                "--disable-geolocation",
                "--disable-infobars",
                "--disable-extensions",
                "--disable-blink-features=AutomationControlled",
                "--no-sandbox",
                "--disable-dev-shm-usage"
            ]
        ) 
        try:
            page = browser.new_page(
                user_agent=(
                    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                    "AppleWebKit/537.36 (KHTML, like Gecko) "
                    "Chrome/121.0.0.0 Safari/537.36"
                )
            ) 
            page.route("**/login**", lambda route: route.abort())
            page.route("**/otp**", lambda route: route.abort())
            page.route("**/auth**", lambda route: route.abort())
            page.route("**/register**", lambda route: route.abort())


            page.on("load", lambda: nuke_popups(page))
            page.on("domcontentloaded", lambda: nuke_popups(page))
            page.on("framenavigated", lambda: nuke_popups(page))


            page.set_default_timeout(30000)
            output = {}

            output["url"] = url 
        

            output.update(scrape_main_info(page, url))
            output["gallery"] = scrape_gallery(page, url)

            output["rating_categories"] = scrape_rating_categories(page, url)
            output["info_facilities"] = scrape_facilities(page, url)
            output["info_faculty"] = scrape_faculty(page, url)
            output["info_course_fee"] = scrape_course_fee_structure(page, url)

            output["info_mba_fees_text"] = scrape_mba_fees_text(page, url)



            page.goto(url, timeout=0)
            page.wait_for_timeout(1500)
            output["latest_news"] = get_latest_news(page)
            output["info_student_review"] = scrape_likes_dislikes(page, url)
            output["info_yearly_students_placed"] = scrape_yearly_students_placed(page, url)
            output["reviews_data"] = scrape_reviews(page, url)


            course_page = browser.new_page()
            output["courses"] = scrape_college_courses(course_page, url)
            course_page.close()

            output["feesRange"] = build_fee_range(output["courses"])


            output["courses_full_time"] = scrape_full_time(page, url)

            output["courses_part_time"] = scrape_part_time(page, url)

            output["important_dates"] = scrape_important_dates(page, url)

            output["placement"] = scrape_placement_data(page, url)

            output["questions_answers"] = scrape_qna(page, url)
            output["admission"] = scrape_admission(page, url)
            output["ranking_data"] = scrape_ranking(page, url)
            output["stream"] = detect_stream(page, url)

            for c in output["courses"]:
                if c.get("url"):
                    try:
                        detail = scrape_course_detail(page, c["url"])
                        c["details"] = detail
                    except:
                        c["details"] = None
 
                if c.get("sub_courses"):
                    for sub in c["sub_courses"]:
                        if sub.get("url"):
                            try:
                                sub["details"] = scrape_course_detail(page, sub["url"])
                            except:
                                sub["details"] = None 


            return output        
        finally:                  
            browser.close()
            # timer.cancel()

        


###############################################################
# RUN (API MODE)
###############################################################

if __name__ == "__main__":

    if len(sys.argv) < 2:
        print(json.dumps({"error": "URL argument missing"}))
        sys.exit(1)

    url = sys.argv[1]

    try:
        final_data = scrape_single_college(url)

        if final_data:
            # ✅ TEMP DB SAVE (studycups)
            result = detail_collection.insert_one(final_data)

            # ✅ ONLY _id for backend
            print(str(result.inserted_id), flush=True)



        else:
            print(json.dumps({"error": "No data returned"}))

    except Exception as e:
            print(json.dumps({"success": False,"error": str(e)}, ensure_ascii=False))
            sys.exit(0)   # ✅ VERY IMPORTANT

