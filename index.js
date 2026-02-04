
import express from "express";
import http from "http";
import { Server as SocketIOServer } from "socket.io";
import mongoose from "mongoose";
import dotenv from "dotenv";
dotenv.config();

import helmet from "helmet";
import rateLimit from "express-rate-limit";
import PDFDocument from "pdfkit";
import { v2 as cloudinary } from "cloudinary";
import multer from "multer";
import fs from "fs";
import Parser from "rss-parser";
const parser = new Parser();

import fetch from "node-fetch";



const mainConn = mongoose.createConnection(
  process.env.MONGO_URI, // studentcap
  { dbName: "studentcap" }
);

const tempConn = mongoose.createConnection(
  process.env.MONGO_URI,
  { dbName: "studycups" }
);

cloudinary.config({
  cloud_name: process.env.CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const allowedOrigins = [
  // local
  "http://localhost:3000",
  "http://localhost:3001",

  // production (VERCEL)
  "https://supportstudycups.vercel.app",
  "https://supportstudycups-5e5dg3cuk-alishakhan897s-projects.vercel.app"
];

function normalizeCollegeForMainDB(data) {
  return {
    ...data,

    // ✅ keep full rawScraped
    rawScraped: data.rawScraped || data,

    // ✅ normalized fields only for frontend usage
    gallery: normalizeGallery(data.gallery),
    courses: Array.isArray(data.courses)
      ? data.courses.map(normalizeCourse)
      : [],
  };
}

function isValidImageUrl(url) {
  if (!url || typeof url !== "string") return false;

  // dotenv / logs / garbage block
  if (url.includes("dotenv@") || url.includes("injecting env")) return false;

  // basic image check
  return /\.(jpg|jpeg|png|webp)$/i.test(url);
}

function normalizeGallery(gallery) {
  if (!Array.isArray(gallery)) return [];
  return gallery.map(item => {
    if (typeof item === 'string') return item;
    if (typeof item === 'object' && item.image) return item.image;
    return null;
  }).filter(Boolean);
}

function normalizeCourse(course) {
  return {
    ...course,
    fees: parseFees(course.fees)
  };
}

function parseFees(value) {
  if (!value) return null;
  if (typeof value === 'number') return value;
  const clean = value.toString().replace(/,|Rs.?|INR/gi, '').toLowerCase().trim();
  if (clean.includes('-')) {
    const min = clean.split('-')[0];
    return parseFloat(min) || null;
  }
  if (clean.includes('lakh')) {
    const num = parseFloat(clean);
    return isNaN(num) ? null : num * 100000;
  }
  const num = parseFloat(clean);
  return isNaN(num) ? null : num;
}


const app = express(); 
app.set("trust proxy", 1);

app.use(express.json({ limit: "5mb" })); 

app.use(express.urlencoded({ extended: true, limit: "5mb" }));

// ================== CORS FIX (FINAL) ==================
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header(
    "Access-Control-Allow-Headers",
    "Origin, X-Requested-With, Content-Type, Accept, Authorization"
  );
  res.header(
    "Access-Control-Allow-Methods",
    "GET, POST, PUT, DELETE, OPTIONS"
  );

  if (req.method === "OPTIONS") {
    return res.sendStatus(200);
  }

  next();
});
// ======================================================


app.use(
  helmet({
    contentSecurityPolicy: false,
  })
);



app.use(
  rateLimit({
    windowMs: 60 * 1000,
    max: 200,
    standardHeaders: true,
    legacyHeaders: false,
  })
);

const upload = multer({
  dest: "uploads/",
  limits: {
    fileSize: 5 * 1024 * 1024, // 5MB per image (safe)
  },
});

mongoose
  .connect(process.env.MONGO_URI)
  .then(() => {
    console.log("MongoDB Connected");
  })
  .catch(err => console.log(err))

console.log("🟢 NODE MONGO_URI:", process.env.MONGO_URI);




const runPythonScraperViaAPI = async (url) => {
  const response = await fetch(
    `${process.env.PYTHON_SCRAPER_URL}/scrape`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ url })
    }
  );

  if (!response.ok) {
    throw new Error(`Python API failed with ${response.status}`);
  }

  const data = await response.json();

  if (!data?.success) {
    throw new Error("Python scraper returned failure");
  }

  return data.data; // ✅ PURE SCRAPED JSON
};



const generateId = () => Date.now() + Math.floor(Math.random() * 1000);

const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

const sendError = (res, message, code = 400) =>
  res.status(code).json({ success: false, error: message });

const safeParseJSON = (text) => {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("Invalid JSON from AI");
  return JSON.parse(match[0]);
};

function mapScrapedCollegeToCMS(college) {
  // ensure content exists
  if (!college.content) college.content = {};

  /* ================= ADMISSION ================= */
  if (!college.content.admission) {
    college.content.admission = {
      title: "Admission",
      blocks: []
    };
  }

  // ❗ sirf scraped blocks hatao, manual nahi
  college.content.admission.blocks =
    college.content.admission.blocks.filter(
      b => b.source === "manual"
    );

  // description → text block
  if (college.description) {
    college.content.admission.blocks.push({
      type: "text",
      data: { text: college.description },
      source: "scraped",
    });
  }

  // highlights → list block
  if (college.highlights?.length) {
    college.content.admission.blocks.push({
      type: "list",
      data: { items: college.highlights },
      source: "scraped",
    });
  }

  /* ================= COURSES ================= */
  if (Array.isArray(college.courses)) {
    college.courses.forEach(course => {
      if (!course.content) course.content = {};

      if (!course.content.about) {
        course.content.about = {
          title: "About Course",
          blocks: []
        };
      }

      course.content.about.blocks =
        course.content.about.blocks.filter(
          b => b.source === "manual"
        );

      if (course.about) {
        course.content.about.blocks.push({
          type: "text",
          data: { text: course.about },
          source: "scraped",
        });
      }

      // admissionProcess → table
      if (course.admissionProcess?.length) {
        course.content.admission = {
          title: "Admission Process",
          blocks: [
            {
              type: "table",
              data: {
                columns: ["Step", "Title", "Description"],
                rows: course.admissionProcess.map(s => [
                  s.step,
                  s.title,
                  s.description
                ])
              },
              source: "scraped",
            }
          ]
        };
      }
    });
  }
}

//Content Block Schema


const ContentBlockSchema = new mongoose.Schema(
  {
    type: {
      type: String,
      enum: ["text", "list", "table", "key_value", "custom"],
      required: true,
    },

    data: {
      type: mongoose.Schema.Types.Mixed,
      required: true,
    },

    source: {
      type: String,
      enum: ["scraped", "manual"],
      default: "manual",
    },

    order: {
      type: Number,
      default: 0,
    },
  },
  { _id: false }
);

const CourseSectionSchema = new mongoose.Schema(
  {
    title: String,
    blocks: {
      type: [ContentBlockSchema],
      default: [],
    },
  },
  { _id: false }
);
const CourseCMSLayerSchema = new mongoose.Schema(
  {
    about: CourseSectionSchema,
    eligibility: CourseSectionSchema,
    admission: CourseSectionSchema,
    fees: CourseSectionSchema,
    curriculum: CourseSectionSchema,
    career: CourseSectionSchema,
    faq: CourseSectionSchema,
  },
  { _id: false }
);



const CourseSchema = new mongoose.Schema(
  {
    // ===== EXISTING FIELDS (UNCHANGED) =====
    id: Number,
    name: String,
    duration: String,
    level: String,
    fees: {
  type: mongoose.Schema.Types.Mixed,
  default: null
},

    eligibility: String,
    about: String,
    programType: String,
    intake: String,
    longEligibility: String,

    admissionProcess: [
      {
        step: Number,
        title: String,
        description: String,
      },
    ],

    highlights: [String],
    skills: [String],

    structure: [
      {
        year: String,
        topics: [String],
      },
    ],

    statistics: {
      studentsEnrolled: String,
      placementRate: String,
      recruiters: String,
      ranking: String,
    },

    // ===== NEW CMS LAYER (ADDITIVE) =====
    content: CourseCMSLayerSchema,
  },
  { _id: false }
);


const SectionSchema = new mongoose.Schema(
  {
    title: String,
    blocks: {
      type: [ContentBlockSchema],
      default: [],
    },
  },
  { _id: false }
);


const PlacementsSchema = new mongoose.Schema(
  {
    highestPackage: String,
    averagePackage: String,
    placementPercentage: Number,
    topRecruiters: [String],
  },
  { _id: false }
);

const ReviewSchema = new mongoose.Schema({
  author: String,
  rating: Number,
  content: String,
  source: String
});

const CollegeSchema = new mongoose.Schema({
  id: { type: Number, index: true, unique: true },

  name: String,
  location: String,
  established: Number,
  type: String,
  stream: String,
  rating: Number,
  reviewCount: Number,
  description: {
  type: mongoose.Schema.Types.Mixed,
  default: ""
},

  highlights: [String],

  gallery: {
    type: [mongoose.Schema.Types.Mixed],
    default: []
  },

  courses: [CourseSchema],

  heroImages: [String],
  heroDownloaded: { type: Boolean, default: false },

  rawScraped: {
    type: Object,
    default: {},
  },

  // ✅ ONLY CMS CONTENT
  content: {
    about: SectionSchema,
    admission: SectionSchema,
    placement: SectionSchema,
    courses_fees: SectionSchema,
    ranking: SectionSchema,
    campus: SectionSchema,
    scholarship: SectionSchema,
    faq: SectionSchema,
    reviews: SectionSchema,
    news: SectionSchema,
  },
}, { timestamps: true });


CollegeSchema.index({ name: "text", location: 1 });

const College = mainConn.model("college", CollegeSchema);


const ExamSchema = new mongoose.Schema(
  {
    id: { type: Number, index: true, unique: true },

    /* BASIC INFO */
    name: String,                 // "JEE Main 2026"
    full_name: String,            // full title
    logoUrl: String,
    conductingBody: String,
    stream: String,               // Engineering / Medical etc.

    /* ABOUT */
    about: {
      description: String,
      about_table: [
        {
          section: String,
          detail: String,
        },
      ],
    },

    /* HIGHLIGHTS */
    highlights: {
      full_exam_name: String,
      short_exam_name: String,
      conducting_body: String,
      frequency_of_conduct: String,
      exam_level: String,
      mode_of_application: String,
      mode_of_exam: String,
      mode_of_counselling: String,
      participating_colleges: Number,
      exam_duration: String,
      languages: [String],
    },

    /* IMPORTANT DATES */
    important_dates: [
      {
        session: String,
        exam_date: String,
        result_date: String,
        mode: String,
      },
    ],

    /* ELIGIBILITY */
    eligibility: {
      basic_criteria: [
        {
          particular: String,
          detail: String,
        },
      ],
      course_wise_eligibility: [
        {
          course: String,
          criteria: String,
        },
      ],
      reservation_criteria: [
        {
          category: String,
          reservation: String,
        },
      ],
    },

    /* EXAM PATTERN */
    exam_pattern: {
      paper_1: {
        name: String,
        exam_mode: String,
        duration: String,
        subjects: [String],
        total_questions: Number,
        total_marks: Number,
        marking_scheme: String,
      },
      paper_2: {
        b_arch: {
          subjects: [String],
          total_questions: Number,
          total_marks: Number,
          duration: String,
        },
        b_plan: {
          subjects: [String],
          total_questions: Number,
          total_marks: Number,
          duration: String,
        },
      },
    },

    /* SYLLABUS */
    syllabus: {
      sections: [
        {
          title: String,
          content: [
            {
              chapter: String,
              raw_text: [String],
            },
          ],
        },
      ],
    },
  },
  { timestamps: true }
);

const Exam = mainConn.model("exam", ExamSchema);


const EventSchema = new mongoose.Schema(
  {
    id: { type: Number, index: true, unique: true },
    title: String,
    category: { type: String, enum: ["Webinar", "Workshop", "College Fair", "Deadline"] },
    date: String,
    description: String,
    imageUrl: String,
    link: String,
    collegeId: Number,
  },
  { timestamps: true }
);
const Event = mainConn.model("event", EventSchema);


const TestimonialSchema = new mongoose.Schema(
  {
    id: { type: Number, index: true, unique: true },
    name: String,
    college: String,
    avatarUrl: String,
    quote: String,
  },
  { timestamps: true }
);
const Testimonial = mainConn.model("testimonial", TestimonialSchema);

const BlogSchema = new mongoose.Schema(
  {
    id: { type: Number, index: true, unique: true },
    title: String,
    author: String,
    date: String,
    imageUrl: String,
    excerpt: String,
    content: String,
    category: String,
  },
  { timestamps: true }
);
const Blog = mainConn.model("blog", BlogSchema);


const RegistrationSchema = new mongoose.Schema(
  {
    id: Number,
    name: String,
    email: String,
    phone: String,
    course: String,
    city:String,
  },
  { timestamps: true }
);

const Registration = mainConn.model("registration", RegistrationSchema);



const ContactSchema = new mongoose.Schema(
  {
    id: { type: Number, index: true, unique: true },
    name: String,
    email: String,
    subject: String,
    message: String,
  },
  { timestamps: true }
);

const Contact = mainConn.model("contact", ContactSchema);

// ================= TOP COURSE CATEGORIES =================
const TOP_COURSES = [
  {
    name: "B.E / B.Tech",
    stream: "Engineering",
    keywords: ["btech", "b.tech", "be", "engineering"]
  },
  {
    name: "MBA / PGDM",
    stream: "MBA",
    keywords: ["mba", "pgdm", "management", "business administration"]
  },
  {
    name: "MBBS",
    stream: "Medical",
    keywords: ["mbbs"]
  },
  {
    name: "BCA",
    stream: "IT",
    keywords: ["bca"]
  },
  {
    name: "B.Com",
    stream: "Commerce",
    keywords: ["bcom", "b.com", "commerce"]
  },
  {
    name: "B.Sc",
    stream: "Science",
    keywords: ["bsc", "b.sc", "bachelor of science"]
  },
  {
    name: "BA",
    stream: "Arts",
    keywords: ["ba", "b.a", "bachelor of arts"]
  },
  {
    name: "BBA",
    stream: "Management",
    keywords: ["bba"]
  },
  {
    name: "M.E / M.Tech",
    stream: "Engineering",
    keywords: ["mtech", "m.tech", "me"]
  },
  {
    name: "MCA",
    stream: "IT",
    keywords: ["mca"]
  },
  {
    name: "B.Ed",
    stream: "Education",
    keywords: ["bed", "b.ed"]
  }
];



const server = http.createServer(app);

const io = new SocketIOServer(server, {
  cors: {
    origin: allowedOrigins,
    methods: ["GET", "POST", "PUT", "DELETE"],
  },
});

io.on("connection", (socket) => {
  console.log("Socket connected:", socket.id);

  socket.on("disconnect", () => {
    console.log("Socket disconnected:", socket.id);
  });


  socket.on("subscribe", (room) => {
    socket.join(room);
  });

  socket.on("unsubscribe", (room) => {
    socket.leave(room);
  });
});


const emit = (event, payload) => {
  try {
    io.emit(event, payload);
  } catch (e) {
    console.warn("Socket emit error:", e.message);
  }
};

async function planQueryWithAI(query) {
  const chat = await groq.chat.completions.create({
    model: "llama-3.1-8b-instant",
    messages: [
      {
        role: "system",
        content: `
You are a query planner for StudyCups education portal.

You must choose ONLY from the allowed values below.

INTENTS (choose one):
- ANSWER_FROM_DB
- RECOMMEND_COLLEGES
- GENERAL_GUIDANCE

ENTITIES (choose one or null):
- college
- course
- exam
- event
- blog
- null

ACTIONS (choose one or null):
- count
- list
- details
- recommend
- null

RULES:
- Never answer the question yourself
- Never invent data
- If information is missing, use null
- If user asks for suggestion, intent MUST be RECOMMEND_COLLEGES
- If user asks how many / list, intent MUST be ANSWER_FROM_DB

Return ONLY valid JSON in this exact format:

{
  "intent": "",
  "entity": "",
  "action": "",
  "filters": {
    "course": null,
    "location": null,
    "maxFees": null,
    "limit": null
  }
}
`

      },
      {
        role: "user",
        content: query
      }
    ],
    temperature: 0
  });

  return safeParseJSON(chat.choices[0].message.content);
}

async function handlePlannedQuery(plan, res) {
  const { intent, entity, action, filters = {} } = plan;

  /* ---------- COUNTS ---------- */
  if (intent === "ANSWER_FROM_DB" && action === "count") {
    if (entity === "college") {
      const count = await College.countDocuments();
      return res.json({ message: `There are ${count} colleges on the portal.` });
    }

    if (entity === "exam") {
      const count = await Exam.countDocuments();
      return res.json({ message: `There are ${count} exams available.` });
    }
  }

  /* ---------- LIST ---------- */
  if (intent === "ANSWER_FROM_DB" && action === "list") {
    if (entity === "exam") {
      const exams = await Exam.find({}, { name: 1, stream: 1 }).lean();
      return res.json({ message: "Here are the available exams.", data: exams });
    }

    if (entity === "college") {
      const colleges = await College.find({}, { name: 1, location: 1 }).lean();
      return res.json({ message: "Here are the colleges on the portal.", data: colleges });
    }
  }

  /* ---------- RECOMMENDATION ---------- */
  if (intent === "RECOMMEND_COLLEGES") {
    const query = {};

    if (filters.location)
      query.location = new RegExp(filters.location, "i");

    if (filters.course)
      query["courses.name"] = new RegExp(filters.course, "i");

    if (filters.maxFees)
      query["feesRange.max"] = { $lte: filters.maxFees };

    const colleges = await College.find(query)
      .sort({ rating: -1 })
      .limit(filters.limit || 5)
      .lean();

    return res.json({
      message: "Here are some colleges that match your requirement.",
      recommendations: colleges.map(c => ({
        collegeId: c.id,
        collegeName: c.name
      }))
    });
  }

  /* ---------- FALLBACK ---------- */
  return res.json({
    message:
      "I can help you with colleges, courses, exams, fees and admissions."
  });
}

app.post(
  "/api/ai-counsellor",
  rateLimit({ windowMs: 60 * 1000, max: 10 }),
  asyncHandler(async (req, res) => {
    const { query } = req.body;
    if (!query) return sendError(res, "Query required");

    // 1️⃣ Ask AI to plan (NOT answer)
    const plan = await planQueryWithAI(query);

    // 🔐 SAFETY CHECK (ADD THIS)
    if (!plan || !plan.intent) {
      return res.json({
        message: "I could not understand the question. Please rephrase."
      });
    }

    // 2️⃣ Execute plan using DB
    return handlePlannedQuery(plan, res);
  })
);


app.get(
  "/api/enquiries",
  asyncHandler(async (req, res) => {

    const contacts = await Contact.find().sort({ createdAt: -1 }).lean();
    const registrations = await Registration.find().sort({ createdAt: -1 }).lean();

    const contactMapped = contacts.map(c => ({
      id: c.id,
      name: c.name,
      email: c.email,

      // Contact → interestedIn = message
      interestedIn: c.message,

      date: c.createdAt,
      type: "contact",
      status: "Not Resolved"
    }));

    const regMapped = registrations.map(r => ({
      id: r.id,
      name: r.name,
      email: r.email,

      // Registration → interestedIn = course
      interestedIn: r.course,

      date: r.createdAt,
      type: "registration",
      status: "Not Resolved"
    }));

    const combined = [...contactMapped, ...regMapped].sort(
      (a, b) => new Date(b.date) - new Date(a.date)
    );

    res.json({ success: true, data: combined });
  })
);




app.post(
  "/api/colleges",
  upload.fields([
    { name: "image", maxCount: 1 },      // main image
    { name: "logo", maxCount: 1 },       // logo
    { name: "gallery", maxCount: 20 },   // gallery images (5, 6, unlimited)
  ]),
  async (req, res) => {
    try {
      let imageUrl = "";
      let logoUrl = "";
      let galleryUrls = [];

      /* MAIN IMAGE */
      if (req.files?.image?.[0]) {
        const result = await cloudinary.uploader.upload(
          req.files.image[0].path,
          { folder: "studycups/colleges/main" }
        );
        imageUrl = result.secure_url;
        fs.unlinkSync(req.files.image[0].path);
      }

      /* LOGO */
      if (req.files?.logo?.[0]) {
        const result = await cloudinary.uploader.upload(
          req.files.logo[0].path,
          { folder: "studycups/colleges/logo" }
        );
        logoUrl = result.secure_url;
        fs.unlinkSync(req.files.logo[0].path);
      }

      /* GALLERY */
      if (req.files?.gallery?.length) {
        for (const file of req.files.gallery) {
          const result = await cloudinary.uploader.upload(file.path, {
            folder: "studycups/colleges/gallery",
          });

          galleryUrls.push(result.secure_url);
          fs.unlinkSync(file.path);
        }
      }

      const college = new College({
        ...req.body,
        id: Date.now(),
        imageUrl,
        logoUrl,
        gallery: galleryUrls,
        rawScraped: req.body.rawScraped || {}
      });


      const saved = await college.save();

      res.status(201).json({
        success: true,
        message: "College created with gallery",
        data: saved,
      });

    } catch (error) {
      console.error(error);
      res.status(400).json({
        success: false,
        message: error.message,
      });
    }
  }
);


app.get("/sitemap.xml", async (req, res) => {
  try {
    const BASE_URL = "https://studycups.in";

    const urls = [];

    /* ================= STATIC PAGES ================= */
    [
      "/",
      "/landing",
      "/colleges",
      "/courses",
      "/exams",
      "/blog"
    ].forEach(p => {
      urls.push(`${BASE_URL}${p}`);
    });

    /* ================= COLLEGE PAGES ================= */
    const colleges = await College.find({}, { id: 1, name: 1 }).lean();

    colleges.forEach(c => {
      if (!c.id || !c.name) return;

      const slug = c.name
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, "")
        .replace(/\s+/g, "-");

      urls.push(`${BASE_URL}/university/${c.id}-${slug}`);
    });

    /* ================= COURSE PAGES ================= */
    const coursesAgg = await College.aggregate([
      { $unwind: "$courses" },
      {
        $group: {
          _id: "$courses.name"
        }
      }
    ]);

    coursesAgg.forEach(c => {
      if (!c._id) return;

      const slug = c._id
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, "")
        .replace(/\s+/g, "-");

      urls.push(`${BASE_URL}/courses/${slug}`);
    });

    /* ================= BLOG PAGES ================= */
    const blogs = await Blog.find({}, { id: 1, title: 1 }).lean();

    blogs.forEach(b => {
      if (!b.id || !b.title) return;

      const slug = b.title
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, "")
        .replace(/\s+/g, "-");

      urls.push(`${BASE_URL}/blog/${b.id}-${slug}`);
    });

    /* ================= XML ================= */
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map(url => `
  <url>
    <loc>${url}</loc>
    <changefreq>weekly</changefreq>
    <priority>0.8</priority>
  </url>`).join("")}
</urlset>`;

    res.setHeader("Content-Type", "application/xml");
    res.setHeader("Cache-Control", "public, max-age=3600");
    res.status(200).send(xml);

  } catch (err) {
    console.error("❌ Sitemap error:", err);
    res.status(500).send("Sitemap generation failed");
  }
});




app.get(
  "/api/colleges",
  asyncHandler(async (req, res) => {

    // ✅ DEFAULT: return ALL colleges (up to 100)
    const page = Math.max(parseInt(req.query.page) || 1, 1);
    const limit = Math.min(parseInt(req.query.limit) || 100, 100);

    // optional text search
    const q = req.query.q
      ? { $text: { $search: req.query.q } }
      : {};

    // fetch data
    let data = await College.find(q)
      .sort({ rating: -1, createdAt: -1 }) // optional: better ordering
      .skip((page - 1) * limit)
      .limit(limit)
      .lean();

    // normalize data for frontend
    data = data.map(c => {

      const ranking2025 = Array.isArray(c.rawScraped?.ranking_data)
        ? c.rawScraped.ranking_data.find(r =>
          r.ranking?.includes("2025")
        )?.ranking ?? null
        : null;

      return {
        ...c,

        // hero image
        imageUrl: c.heroImages?.[0] ?? null,

        // logo
        logoUrl: c.rawScraped?.logo ?? null,

        // normalize fields
        type: c.type ?? null,
        stream: c.rawScraped?.stream ?? null,
        ranking: ranking2025,
        feesRange: c.rawScraped?.feesRange ?? null,
      };
    });

    const total = await College.countDocuments(q);

    res.json({
      success: true,
      page,
      limit,
      total,
      data,
    });
  })
);


app.get("/api/colleges/list", asyncHandler(async (req, res) => {
  const colleges = await College.find(
    {},
    {
      id: 1,
      name: 1,
      location: 1,
      rating: 1,
      type: 1,
      createdAt: 1
    }
  )
    .sort({ createdAt: -1 })
    .lean();

  res.json({ success: true, data: colleges });
}));

// Read single
app.get(
  "/api/colleges/:id",
  asyncHandler(async (req, res) => {
    const college = await College.findOne({ id: Number(req.params.id) });
    if (!college) return sendError(res, "College not found", 404);
    res.json({ success: true, data: college });
  })
);

app.put(
  "/api/colleges/:id/hero-image",
  upload.single("file"),
  asyncHandler(async (req, res) => {
    const collegeId = Number(req.params.id);
    const { heroMode, heroImage } = req.body;

    let finalUrl = null;

    // CASE 1️⃣: URL pasted
    if (heroMode === "url") {
      if (!heroImage || !heroImage.startsWith("https://")) {
        return sendError(res, "Only HTTPS image URLs allowed");
      }
      finalUrl = heroImage;
    }

    // CASE 2️⃣: File uploaded
    if (heroMode === "upload" && req.file) {
      const uploaded = await cloudinary.uploader.upload(req.file.path, {
        folder: "studycups/colleges/hero"
      });
      finalUrl = uploaded.secure_url;
      fs.unlinkSync(req.file.path);
    }

    if (!finalUrl) {
      return sendError(res, "Hero image not provided");
    }

    await College.updateOne(
      { id: collegeId },
      {
        $set: {
          heroImages: [finalUrl],
          heroDownloaded: true
        }
      }
    );

    res.json({
      success: true,
      heroImage: finalUrl
    });
  })
);

// Delete
app.delete(
  "/api/colleges/:id",
  asyncHandler(async (req, res) => {
    const deleted = await College.findOneAndDelete({ id: Number(req.params.id) });
    if (!deleted) return sendError(res, "College not found", 404);
    emit("college:deleted", { id: Number(req.params.id) });
    res.json({ success: true, message: "College deleted" });
  })
);

app.get(
  "/api/colleges/:id/brochure",
  asyncHandler(async (req, res) => {
    const college = await College.findOne({ id: Number(req.params.id) }).lean();
    if (!college) return sendError(res, "College not found", 404);

    const doc = new PDFDocument({ margin: 50 });

    // Headers for download
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${college.name.replace(/\s+/g, "_")}_Brochure.pdf"`
    );

    doc.pipe(res);

    /* ================= HEADER ================= */
    doc
      .fontSize(22)
      .text(college.name, { align: "center" })
      .moveDown(0.5);

    doc
      .fontSize(12)
      .fillColor("gray")
      .text(college.location, { align: "center" })
      .fillColor("black")
      .moveDown(1);

    /* ================= ABOUT ================= */
    doc.fontSize(15).text("About College", { underline: true });
    doc.moveDown(0.5);
    doc.fontSize(11).text(college.description || "Information coming soon.");
    doc.moveDown(1);

    /* ================= HIGHLIGHTS ================= */
    if (college.highlights?.length) {
      doc.fontSize(15).text("Key Highlights", { underline: true });
      doc.moveDown(0.5);
      college.highlights.forEach(h => doc.text(`• ${h}`));
      doc.moveDown(1);
    }

    /* ================= COURSES ================= */
    doc.fontSize(15).text("Courses Offered", { underline: true });
    doc.moveDown(0.5);

    if (college.courses?.length) {
      college.courses.forEach(course => {
        doc.fontSize(12).text(course.name || "Course");
        doc.fontSize(10).text(`Duration: ${course.duration || "N/A"}`);
        doc.fontSize(10).text(`Fees: ₹₹${Number(course.fees || 0).toLocaleString("en-IN")}
`);
        doc.fontSize(10).text(`Eligibility: ${course.eligibility || "N/A"}`);
        doc.moveDown(0.5);
      });
    } else {
      doc.fontSize(11).text("Courses information will be updated soon.");
    }


    /* ================= PLACEMENTS ================= */
    if (college.placements) {
      doc.addPage();
      doc.fontSize(15).text("Placements", { underline: true });
      doc.moveDown(0.5);

      doc.text(`Highest Package: ${college.placements.highestPackage}`);
      doc.text(`Average Package: ${college.placements.averagePackage}`);
      doc.text(`Placement Rate: ${college.placements.placementPercentage}%`);

      if (college.placements.topRecruiters?.length) {
        doc.moveDown(0.5);
        doc.text("Top Recruiters:");
        college.placements.topRecruiters.forEach(r =>
          doc.text(`• ${r}`)
        );
      }
    }

    /* ================= FOOTER ================= */
    doc.moveDown(2);
    doc
      .fontSize(9)
      .fillColor("gray")
      .text(
        "Generated by StudyCups Education | Official college data",
        { align: "center" }
      );

    doc.end();
  })
);


app.get(
  "/api/course/:slug",
  asyncHandler(async (req, res) => {

    // 1️⃣ URL decode
    const slug = decodeURIComponent(req.params.slug).trim();
    console.log("🔹 Requested slug:", slug);

    // 2️⃣ Regex safe banana (dot, spaces, case issue fix)
    const nameRegex = new RegExp(
      "^" +
      slug
        .replace(/\./g, "\\.")     // dot fix
        .replace(/\s+/g, "\\s*")   // space flexible
      + "$",
      "i" // case-insensitive
    );

    // 3️⃣ College collection me search
    const college = await College.findOne(
      {
        $or: [
          { "courses.name": nameRegex },
          { "courses_full_time.name": nameRegex },
          { "courses_part_time.name": nameRegex }
        ]
      },
      {
        name: 1,
        id: 1,
        courses: { $elemMatch: { name: nameRegex } },
        courses_full_time: { $elemMatch: { name: nameRegex } },
        courses_part_time: { $elemMatch: { name: nameRegex } }
      }
    );

    // 4️⃣ Agar kuch bhi nahi mila
    if (!college) {
      return res.status(404).json({
        success: false,
        error: "Course not found"
      });
    }

    // 5️⃣ Course nikaalo (jis array me mila ho)
    const course =
      college.courses?.[0] ||
      college.courses_full_time?.[0] ||
      college.courses_part_time?.[0];

    if (!course) {
      return res.status(404).json({
        success: false,
        error: "Course not found"
      });
    }

    // 6️⃣ SUCCESS RESPONSE
    res.json({
      success: true,
      courseKey: course.name,
      courseIds: [course.id],
      college: {
        id: college.id,
        name: college.name
      }
    });
  })
);



// ================= MEGA MENU – INIT =================
app.get(
  "/api/megamenu/init",
  asyncHandler(async (req, res) => {

    /* ---------- UNIQUE COURSES (12) ---------- */
   const courses = TOP_COURSES.map(c => ({
  name: c.name,
  stream: c.stream
}));



    /* ---------- TOP COLLEGES (DEFAULT) ---------- */
    const colleges = await College.find({})
      .sort({ rating: -1 })
      .limit(12)
      .select("id name location rating")
      .lean();

    /* ---------- TOP EXAMS (DEFAULT) ---------- */
    const exams = await Exam.find({})
      .limit(6)
      .select("id name stream")
      .lean();

    res.json({
      success: true,
      courses,
      colleges,
      exams
    });
  })
);

// ================= MEGA MENU – COURSE HOVER =================
app.get("/api/megamenu/course", asyncHandler(async (req, res) => {
  const { name } = req.query;

  const courseConfig = TOP_COURSES.find(c => c.name === name);
  if (!courseConfig) {
    return res.json({ success: true, colleges: [], exams: [] });
  }

  // 🔥 STRONG COURSE NAME REGEX (REAL DATA FRIENDLY)
  let courseRegex;

  switch (courseConfig.name) {
    case "B.E / B.Tech":
      courseRegex = /(b\.?\s?tech|bachelor of technology|b\.?\s?e)/i;
      break;

    case "MBA / PGDM":
      courseRegex = /(mba|pgdm|post graduate programme|management)/i;
      break;

    case "MBBS":
      courseRegex = /(mbbs|medicine|medical)/i;
      break;

    case "B.Sc":
      courseRegex = /(b\.?\s?sc|bs|bachelor of science)/i;
      break;

    case "BCA":
      courseRegex = /(bca|computer application)/i;
      break;

    case "B.Com":
      courseRegex = /(b\.?\s?com|commerce)/i;
      break;

    default:
      courseRegex = new RegExp(courseConfig.name, "i");
  }

  // ✅ MAIN FIX: MATCH ONLY ON courses.name
  const colleges = await College.find({
    courses: {
      $elemMatch: {
        name: courseRegex
      }
    }
  })
    .sort({ rating: -1 })
    .limit(12)
    .select("id name rating location")
    .lean();

  const exams = await Exam.find({
    stream: new RegExp(courseConfig.stream, "i")
  })
    .limit(6)
    .select("id name")
    .lean();

  res.json({
    success: true,
    colleges,
    exams
  });
}));






// --- Exams ---
app.post(
  "/api/exams",
  asyncHandler(async (req, res) => {
    const exam = await Exam.create({ ...req.body, id: generateId() });
    emit("exam:created", exam);
    res.status(201).json({ success: true, data: exam });
  })
);
// ================= MEGA MENU HELPERS =================
const normalizeStream = (stream) =>
  stream?.toLowerCase().trim();

app.get(
  "/api/exams",
  asyncHandler(async (req, res) => {
    const exams = await Exam.find().lean();
    res.json({ success: true, data: exams });
  })
);

app.get(
  "/api/exams/:id",
  asyncHandler(async (req, res) => {
    const exam = await Exam.findOne({ id: Number(req.params.id) });
    if (!exam) return sendError(res, "Exam not found", 404);
    res.json({ success: true, data: exam });
  })
);

app.put(
  "/api/exams/:id",
  asyncHandler(async (req, res) => {
    const updated = await Exam.findOneAndUpdate({ id: Number(req.params.id) }, req.body, { new: true });
    if (!updated) return sendError(res, "Exam not found", 404);
    emit("exam:updated", updated);
    res.json({ success: true, data: updated });
  })
);

app.delete(
  "/api/exams/:id",
  asyncHandler(async (req, res) => {
    const deleted = await Exam.findOneAndDelete({ id: Number(req.params.id) });
    if (!deleted) return sendError(res, "Exam not found", 404);
    emit("exam:deleted", { id: Number(req.params.id) });
    res.json({ success: true, message: "Exam deleted" });
  })
);

// --- Events ---
app.post(
  "/api/events",
  asyncHandler(async (req, res) => {
    const event = await Event.create({ ...req.body, id: generateId() });
    emit("event:created", event);
    res.status(201).json({ success: true, data: event });
  })
);

app.get(
  "/api/events",
  asyncHandler(async (req, res) => {
    const events = await Event.find().lean();
    res.json({ success: true, data: events });
  })
);

app.get(
  "/api/events/:id",
  asyncHandler(async (req, res) => {
    const event = await Event.findOne({ id: Number(req.params.id) });
    if (!event) return sendError(res, "Event not found", 404);
    res.json({ success: true, data: event });
  })
);

app.put(
  "/api/events/:id",
  asyncHandler(async (req, res) => {
    const updated = await Event.findOneAndUpdate({ id: Number(req.params.id) }, req.body, { new: true });
    if (!updated) return sendError(res, "Event not found", 404);
    emit("event:updated", updated);
    res.json({ success: true, data: updated });
  })
);

app.delete(
  "/api/events/:id",
  asyncHandler(async (req, res) => {
    const deleted = await Event.findOneAndDelete({ id: Number(req.params.id) });
    if (!deleted) return sendError(res, "Event not found", 404);
    emit("event:deleted", { id: Number(req.params.id) });
    res.json({ success: true, message: "Event deleted" });
  })
);

// --- Testimonials ---
app.post(
  "/api/testimonials",
  asyncHandler(async (req, res) => {
    const testimonial = await Testimonial.create({ ...req.body, id: generateId() });
    emit("testimonial:created", testimonial);
    res.status(201).json({ success: true, data: testimonial });
  })
);

app.get(
  "/api/testimonials",
  asyncHandler(async (req, res) => {
    const data = await Testimonial.find().lean();
    res.json({ success: true, data });
  })
);

app.put(
  "/api/testimonials/:id",
  asyncHandler(async (req, res) => {
    const updated = await Testimonial.findOneAndUpdate({ id: Number(req.params.id) }, req.body, { new: true });
    if (!updated) return sendError(res, "Testimonial not found", 404);
    emit("testimonial:updated", updated);
    res.json({ success: true, data: updated });
  })
);

app.delete(
  "/api/testimonials/:id",
  asyncHandler(async (req, res) => {
    const deleted = await Testimonial.findOneAndDelete({ id: Number(req.params.id) });
    if (!deleted) return sendError(res, "Testimonial not found", 404);
    emit("testimonial:deleted", { id: Number(req.params.id) });
    res.json({ success: true, message: "Testimonial deleted" });
  })
);

// --- Blogs ---
app.post(
  "/api/blogs",
  asyncHandler(async (req, res) => {
    const blog = await Blog.create({ ...req.body, id: generateId() });
    emit("blog:created", blog);
    res.status(201).json({ success: true, data: blog });
  })
);

app.get(
  "/api/blogs",
  asyncHandler(async (req, res) => {
    const data = await Blog.find().lean();
    res.json({ success: true, data });
  })
);

app.get(
  "/api/blogs/:id",
  asyncHandler(async (req, res) => {
    const { id } = req.params;

    // ✅ ObjectId validation
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid blog id",
      });
    }

    // ✅ Correct lookup
    const blog = await Blog.findById(id);

    if (!blog) {
      return res.status(404).json({
        success: false,
        message: "Blog not found",
      });
    }

    res.json({ success: true, data: blog });
  })
);

app.put(
  "/api/colleges/:id",
  asyncHandler(async (req, res) => {

    // ✅ CMS ABOUT BLOCKS
    if (Array.isArray(req.body?.content?.about?.blocks)) {
      req.body.content.about.blocks =
        req.body.content.about.blocks.map((block, index) => ({
          type: block.type,
          data: block.data,
          order: index,
          source: block.source || "manual"
        }));
    }

    // ✅ COURSES ID SAFETY
    if (Array.isArray(req.body.courses)) {
      req.body.courses = req.body.courses.map(c => ({
        ...c,
        id: c.id || generateId()
      }));
    }

    const updated = await College.findOneAndUpdate(
      { id: Number(req.params.id) },
      { $set: req.body },
      { new: true, runValidators: true }
    );

    if (!updated) {
      return res.status(404).json({
        success: false,
        message: "College not found"
      });
    }

    emit("college:updated", updated);

    res.json({
      success: true,
      message: "College updated successfully",
      data: updated
    });
  })
);



app.delete(
  "/api/blogs/:id",
  asyncHandler(async (req, res) => {
    const deleted = await Blog.findOneAndDelete({ id: Number(req.params.id) });
    if (!deleted) return sendError(res, "Blog not found", 404);
    emit("blog:deleted", { id: Number(req.params.id) });
    res.json({ success: true, message: "Blog deleted" });
  })
);


app.post(
  "/api/registration",
  asyncHandler(async (req, res) => {
    const data = await Registration.create({ ...req.body, id: generateId() });
    emit("registration:new", data);
    res.status(201).json({ success: true, data });
  })
);

// Get all
app.get(
  "/api/registration",
  asyncHandler(async (req, res) => {
    const data = await Registration.find().sort({ createdAt: -1 });
    res.json({ success: true, data });
  })
);

app.get(
  "/api/registration/:id",
  asyncHandler(async (req, res) => {
    const data = await Registration.findOne({ id: Number(req.params.id) });
    if (!data) return sendError(res, "Registration not found", 404);
    res.json({ success: true, data });
  })
);

// ---------------- CONTACT API ----------------

// CREATE CONTACT ENTRY
app.post(
  "/api/contact",
  asyncHandler(async (req, res) => {
    const contact = await Contact.create({
      ...req.body,
      id: generateId()
    });

    emit("contact:new", contact);

    res.status(201).json({
      success: true,
      data: contact,
    });
  })
);

// GET ALL CONTACTS
app.get(
  "/api/contact",
  asyncHandler(async (req, res) => {
    const contacts = await Contact.find().sort({ createdAt: -1 }).lean();
    res.json({ success: true, data: contacts });
  })
);


app.get(
  "/api/contact/:id",
  asyncHandler(async (req, res) => {
    const contact = await Contact.findOne({ id: Number(req.params.id) });

    if (!contact) return sendError(res, "Contact entry not found", 404);

    res.json({ success: true, data: contact });
  })
);


app.use((err, req, res, next) => {
  console.error("Unhandled Error:", err);
  sendError(res, err.message || "Server Error", 500);
});

app.get("/api/scrape/result/:id", async (req, res) => {
  try {
    const tempCollection = tempConn.collection("college_course_test");

    const data = await tempCollection.findOne({
      _id: new mongoose.Types.ObjectId(req.params.id)
    });

    if (!data) {
      return res.status(404).json({ success: false });
    }

    // internal fields clean
    delete data.__v;

    res.json({
      success: true,
      data
    });

  } catch (err) {
    res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

// ================= COURSES LIST (FAST, AGGREGATED) =================
app.get("/api/courses/list", asyncHandler(async (req, res) => {
  const courses = await College.aggregate([
    { $unwind: "$courses" },

    {
      $group: {
        _id: "$courses.name",
        name: { $first: "$courses.name" },
        level: { $first: "$courses.level" },
        stream: { $first: "$stream" },
        totalColleges: { $sum: 1 }
      }
    },

    { $sort: { totalColleges: -1 } }
  ]);

  res.json({
    success: true,
    data: courses
  });
}));

// ================= MIGRATE TEMP → REAL DB =================
app.post("/api/scrape/migrate/:tempId", async (req, res) => {
  try {
    const tempId = req.params.tempId;

    /* ================= 1️⃣ TEMP COLLECTION ================= */
    const tempCollection = tempConn.collection("college_course_test");

    const tempDoc = await tempCollection.findOne({
      _id: new mongoose.Types.ObjectId(tempId),
    });

    if (!tempDoc) {
      return res.status(404).json({
        success: false,
        error: "Temp document not found",
      });
    }

    /* ================= 2️⃣ CLEAN RAW COPY ================= */
    const raw = { ...tempDoc };
    delete raw._id;
    delete raw.__v;

    /* ================= 3️⃣ NAME NORMALIZATION ================= */
    const collegeName =
      (raw.full_name || raw.college_name || "")
        .replace(/Fees.*|Admission.*|Courses.*|Cutoff.*|Ranking.*|Placement.*/gi, "")
        .trim();

    /* ================= 4️⃣ BUILD REAL DB DOC ================= */
    const collegeDoc = {
      id: Date.now(),

      /* CORE */
      name: collegeName,
      full_name: raw.full_name || raw.college_name || "",
      location: raw.location || "",
      established: raw.estd_year ? Number(raw.estd_year) : null,
      type: raw.college_type || "",

      /* RATINGS */
      rating: raw.rating ? Number(raw.rating) : null,
      reviewCount: raw.review_count
        ? Number(String(raw.review_count).replace(/\D/g, ""))
        : 0,

      /* CONTENT */
      description: raw.about_text || "",
      highlights: Array.isArray(raw.about_list) ? raw.about_list : [],

      /* MEDIA */
      gallery: Array.isArray(raw.gallery)
        ? raw.gallery.map(g => (typeof g === "string" ? g : g.image)).filter(Boolean)
        : [],

     heroImages: Array.isArray(raw.heroImages)
  ? raw.heroImages.filter(isValidImageUrl)
  : [],


      heroDownloaded: !!raw.hero_generated,

      /* COURSES (NORMALIZED BUT SAFE) */
      courses: Array.isArray(raw.courses)
        ? raw.courses.map(course => ({
            id: Date.now() + Math.floor(Math.random() * 1000),
            name: course.name || "",
            duration: course.duration || "",
            level: course.level || "",
            fees: parseFees(course.fees),
            eligibility: course.eligibility || "",
            about: course.about || "",
            programType: course.mode || "",
            intake: course.intake || "",
            admissionProcess: course.admissionProcess || [],
            highlights: course.highlights || [],
            skills: course.skills || [],
            structure: course.structure || [],
            statistics: course.statistics || {},
            content: {}, // CMS layer empty (manual editing ke liye)
          }))
        : [],

      /* 🔐 MOST IMPORTANT: FULL RAW BACKUP */
      rawScraped: raw,
    };

    /* ================= 5️⃣ UPSERT INTO REAL DB ================= */
    await College.updateOne(
      { name: collegeDoc.name, location: collegeDoc.location },
      { $set: collegeDoc },
      { upsert: true }
    );

    /* ================= 6️⃣ SUCCESS ================= */
    res.json({
      success: true,
      message: "College migrated successfully",
      collegeName: collegeDoc.name,
    });

  } catch (err) {
    console.error("❌ MIGRATION ERROR:", err);
    res.status(500).json({
      success: false,
      error: err.message,
    });
  }
}); 

app.patch("/api/temp/college/update-field/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { path, value } = req.body;

    if (!path) {
      return res.status(400).json({
        success: false,
        message: "Field path is required",
      });
    }

    const updateQuery = {
      $set: {
        [path]: value,
        updatedAt: new Date(),
      },
    };

    const result = await tempConn
      .collection("college_course_test")
      .updateOne(
        { _id: new mongoose.Types.ObjectId(id) },
        updateQuery
      );

    res.json({
      success: true,
      message: "Field updated in temp DB",
      modifiedCount: result.modifiedCount,
    });

  } catch (err) {
    console.error("❌ TEMP FIELD UPDATE ERROR:", err);
    res.status(500).json({
      success: false,
      error: err.message,
    });
  }
});




app.post("/api/scrape/start", async (req, res) => {
  const { url } = req.body;

  if (!url) {
    return res.status(400).json({
      success: false,
      error: "URL is required"
    });
  }

  try {
    console.log("🚀 Calling Python Scraper API:", url);

    // 1️⃣ Call Python
    const scrapedData = await runPythonScraperViaAPI(url);

    if (!scrapedData || typeof scrapedData !== "object") {
      throw new Error("Invalid data from Python scraper");
    }

    // 2️⃣ Insert into TEMP DB
    const tempCollection = tempConn.collection("college_course_test");

    const result = await tempCollection.insertOne({
      ...scrapedData,
      sourceUrl: url,
      status: "draft",
      createdAt: new Date()
    });

    // 3️⃣ Return tempId
    return res.json({
      success: true,
      tempId: result.insertedId.toString()
    });

  } catch (err) {
    console.error("❌ SCRAPE ERROR:", err);

    return res.status(500).json({
      success: false,
      error: err.message
    });
  }
});



app.get(
  "/api/dashboard/stats",
  asyncHandler(async (req, res) => {

    // ---------- COUNTS ----------
    const [
      collegesCount,
      examsCount,
      blogsCount,
      eventsCount,
      contactsCount,
      registrationsCount,
    ] = await Promise.all([
      College.countDocuments(),
      Exam.countDocuments(),
      Blog.countDocuments(),
      Event.countDocuments(),
      Contact.countDocuments(),
      Registration.countDocuments(),
    ]);

    // ---------- UNIQUE COURSES ----------
   const courseAgg = await College.aggregate([
  {
    $project: {
      courses: { $ifNull: ["$rawScraped.courses", []] }
    }
  },
  { $unwind: "$courses" },

  // 🔑 NORMALIZE COURSE NAME
  {
    $addFields: {
      normalizedName: {
        $trim: {
          input: {
            $toLower: {
              $replaceAll: {
                input: "$courses.name",
                find: ".",
                replacement: ""
              }
            }
          }
        }
      }
    }
  },

  // 🔑 GROUP BY NORMALIZED NAME
  {
    $group: {
      _id: "$normalizedName"
    }
  },

  // 🔢 COUNT UNIQUE
  {
    $count: "total"
  }
]);

const coursesCount = courseAgg[0]?.total || 0;


    // ---------- MONTHLY ENQUIRIES (CONTACT + REGISTRATION) ----------
    const [contactMonthly, registrationMonthly] = await Promise.all([
      Contact.aggregate([
        {
          $group: {
            _id: { $month: "$createdAt" },
            count: { $sum: 1 },
          },
        },
      ]),
      Registration.aggregate([
        {
          $group: {
            _id: { $month: "$createdAt" },
            count: { $sum: 1 },
          },
        },
      ]),
    ]);

    // merge both
    const monthMap = Array(12).fill(0);

    contactMonthly.forEach(m => {
      monthMap[m._id - 1] += m.count;
    });

    registrationMonthly.forEach(m => {
      monthMap[m._id - 1] += m.count;
    });

    const months = [
      "Jan","Feb","Mar","Apr","May","Jun",
      "Jul","Aug","Sep","Oct","Nov","Dec"
    ];

    const monthlyEnquiries = months.map((name, i) => ({
      name,
      enquiries: monthMap[i],
    }));

    // ---------- RESPONSE ----------
    res.json({
      success: true,
      stats: {
        colleges: collegesCount,
        courses: coursesCount,
        exams: examsCount,
        blogs: blogsCount,
        enquiries: contactsCount + registrationsCount,
        events: eventsCount,
      },
      monthlyEnquiries,
    });
  })
);



app.get("/api/courses/all", asyncHandler(async (req, res) => {
  const courses = await College.aggregate([
    {
      $project: {
        collegeStream: {
          $ifNull: [
            "$stream",
            { $ifNull: ["$rawScraped.stream", "$rawScraped.college_type"] }
          ]
        },
        courses: { $ifNull: ["$rawScraped.courses", []] }
      }
    },

    { $unwind: "$courses" },

    {
      $addFields: {
        stream: {
          $cond: [
            { $ne: ["$collegeStream", null] },
            "$collegeStream",

            // fallback: infer from course name
            {
              $switch: {
                branches: [
                  {
                    case: { $regexMatch: { input: "$courses.name", regex: /b\.?\s?tech|engineering/i } },
                    then: "Engineering"
                  },
                  {
                    case: { $regexMatch: { input: "$courses.name", regex: /mba|management|pgdm/i } },
                    then: "Management"
                  },
                  {
                    case: { $regexMatch: { input: "$courses.name", regex: /mbbs|medical/i } },
                    then: "Medical"
                  },
                  {
                    case: { $regexMatch: { input: "$courses.name", regex: /law|llb/i } },
                    then: "Law"
                  }
                ],
                default: "General"
              }
            }
          ]
        }
      }
    },

    {
      $group: {
        _id: { name: { $trim: { input: "$courses.name" } } },

        name: { $first: "$courses.name" },
        duration: { $first: "$courses.duration" },
        mode: { $first: "$courses.mode" },
        stream: { $first: "$stream" },

        totalColleges: { $sum: 1 }
      }
    },

    { $sort: { name: 1 } }
  ]);

  res.json({
    success: true,
    total: courses.length,
    data: courses
  });
}));








// -------------------- START SERVER --------------------
const PORT = process.env.PORT || 5000;  




//------PORT LISTENING------//
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
