
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


import fetch from "node-fetch";



const mainConn = mongoose.createConnection(
  process.env.MONGO_URI, // studentcap
  { dbName: "studentcap" }
);

const tempConn = mongoose.createConnection(
  process.env.MONGO_URI,
  { dbName: "studycups" }
);

mainConn.once("open", () => {
  ensureFeaturedCollegeFieldDefaults().catch((error) => {
    console.error(
      "College featured_college default sync failed:",
      error?.message || error
    );
  });
  getMainCourseCatalog().catch((error) => {
    console.error("Main course catalog warmup failed:", error?.message || error);
  });
  getCollegeCardCatalog().catch((error) => {
    console.error("College card catalog warmup failed:", error?.message || error);
  });
  startCollegeInsertChangeStream();
});

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

const COLLEGE_SOCKET_ROOM = "colleges";
const COLLEGE_LIST_CHANGED_EVENT = "college:list:changed";
const COLLEGE_CHANGE_STREAM_RETRY_MS = 5000;

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

const normalizeCourse = (name = "") => {
  if (!name) return "";
  return name.toLowerCase()
  
    .replace(/master of technology|m\.?tech|mtech/gi, "mtech")
    .replace(/bachelor of technology|b\.?tech|btech/gi, "btech")
    .replace(/[^a-z0-9]/g, "") // Remove symbols
    .trim();
};

const normalizeCourseName = (name = "") =>
  name
    .toLowerCase()
    .replace(/\(.*?\)/g, "")     // remove specialization brackets
    .replace(/\./g, "")          // remove dots
    .replace(/\s+/g, " ")        // normalize spaces
    .trim();

const normalize = (str = "") =>
  str
    .toLowerCase()
    .replace(/\./g, "")
    .replace(/\s+/g, " ")
    .trim();
const splitCourseName = (name = "") => {
  const clean = normalize(name);

  // bracket specialization first priority
  const bracketMatch = name.match(/\(([^)]+)\)/);

  if (bracketMatch) {
    return {
      degree: normalize(name.split("(")[0]),
      specialization: normalize(bracketMatch[1])
    };
  }

  // otherwise split by words
  const parts = clean.split(" ");

  return {
    degree: parts[0], // data-driven, not hard-coded
    specialization: parts.slice(1).join(" ") || "general"
  };
};



function parseFees(value) {
  if (!value) return null;
  if (typeof value === 'number') return value;
  const clean = value
    .toString()
    .replace(/,|₹|Rs.?|INR/gi, '')
    .toLowerCase()
    .trim();

  const parseSingleAmount = (input) => {
    const text = String(input || "").trim();
    if (!text) return null;

    const num = parseFloat(text);
    if (isNaN(num)) return null;

    if (/crore|crores|cr\b/.test(text)) return num * 10000000;
    if (/lakh|lakhs|lac|lacs/.test(text)) return num * 100000;
    if (/thousand|k\b/.test(text)) return num * 1000;
    return num;
  };

  const rangeParts = clean.split(/\s*(?:-|–|—|to)\s*/i).filter(Boolean);
  if (rangeParts.length > 1) {
    return parseSingleAmount(rangeParts[0]);
  }

  return parseSingleAmount(clean);
}

const computeAverageFees = (feesRange) => {

  const min = feesRange?.min;
  const max = feesRange?.max;

  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    return null;
  }

  return Math.round((min + max) / 2);
};
// ================= BLOG IMAGE UPLOAD (TOP) =================

import axios from "axios";
import * as cheerio from "cheerio";
const app = express(); 
const parser = new Parser();
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
app.post(
  "/api/blogs/upload-image",
  upload.single("image"),
  async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({
          success: 0,
          message: "No image provided",
        });
      }

      const result = await cloudinary.uploader.upload(req.file.path, {
        folder: "studycups/blogs",
      });

      fs.unlinkSync(req.file.path);

      return res.json({
        success: 1,
        file: {
          url: result.secure_url,
          public_id: result.public_id,
        },
      });
    } catch (err) {
      console.error("Blog image upload error:", err);
      return res.status(500).json({
        success: 0,
        message: "Image upload failed",
      });
    }
  }
);
mongoose
  .connect(process.env.MONGO_URI)
  .then(() => {
    console.log("MongoDB Connected");
  })
  .catch(err => console.log(err))

console.log("🟢 NODE MONGO_URI:", process.env.MONGO_URI);



const runPythonScraperViaAPI = async (url) => {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 600000); // 10 minutes timeout

    const response = await fetch(
      `${process.env.PYTHON_SCRAPER_URL}/scrape`, 
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Accept": "application/json"
        },
        body: JSON.stringify({ url }),
        signal: controller.signal
      }
    );

    clearTimeout(timeout);

    if (!response.ok) {
      const errorText = await response.text();
      console.error("Python API Error Response:", errorText);
      throw new Error(`Python API failed: ${response.status}`);
    }

    const data = await response.json();
    return data.data; 
  } catch (err) {
    console.error("Fetch Exception:", err.message);
    throw err;
  }
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

const CMSControlledFieldSchema = new mongoose.Schema(
  {
    value: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },
    cmsControl: {
      type: Boolean,
      default: true,
    },
    source: {
      type: String,
      enum: ["cms", "scraped", "manual"],
      default: "cms",
    },
    updatedAt: {
      type: Date,
      default: Date.now,
    },
  },
  { _id: false }
);

const CMSContentItemSchema = new mongoose.Schema(
  {
    type: CMSControlledFieldSchema,
    value: CMSControlledFieldSchema,
  },
  { _id: false }
);

const CMSTocSectionSchema = new mongoose.Schema(
  {
    section: CMSControlledFieldSchema,
    content: {
      type: [CMSContentItemSchema],
      default: [],
    },
  },
  { _id: false }
);

const CMSBasicInfoSchema = new mongoose.Schema(
  {
    name: CMSControlledFieldSchema,
    logo: CMSControlledFieldSchema,
    city: CMSControlledFieldSchema,
    state: CMSControlledFieldSchema,
    college_type: CMSControlledFieldSchema,
    established_year: CMSControlledFieldSchema,
  },
  { _id: false }
);

const CMSAboutSchema = new mongoose.Schema(
  {
    about_highlights: CMSControlledFieldSchema,
    toc_sections: {
      type: [CMSTocSectionSchema],
      default: [],
    },
  },
  { _id: false }
);

const CMSAdmissionAboutSchema = new mongoose.Schema(
  {
    format: CMSControlledFieldSchema,
    value: CMSControlledFieldSchema,
  },
  { _id: false }
);

const CMSAdmissionSchema = new mongoose.Schema(
  {
    about: CMSAdmissionAboutSchema,
    toc_sections: {
      type: [CMSTocSectionSchema],
      default: [],
    },
  },
  { _id: false }
);

const CMSGalleryItemSchema = new mongoose.Schema(
  {
    src: CMSControlledFieldSchema,
    alt: CMSControlledFieldSchema,
  },
  { _id: false }
);

const CollegeSchema = new mongoose.Schema({
  source: String,
  source_college_id: Number,
  url: String, 
  avg_fees: {
  type: Number,
  default: null
},
  featured_college: {
    type: String,
    enum: ["featured", "No featured"],
    default: "No featured",
    set: (value) => value || "No featured",
  },

  basic: {
    name: String,
    logo: String,
    city: String,
    state: String,
    college_type: String,
    established_year: String,
    rating: Number,
    reviews: Number,
    about: mongoose.Schema.Types.Mixed,
    about_highlights: mongoose.Schema.Types.Mixed,
    toc_sections: mongoose.Schema.Types.Mixed,
  },

  admission: mongoose.Schema.Types.Mixed,
  reviews_page: mongoose.Schema.Types.Mixed,
  ranking: mongoose.Schema.Types.Mixed,
  placement: mongoose.Schema.Types.Mixed,
  faculty: mongoose.Schema.Types.Mixed,
  cutoff: mongoose.Schema.Types.Mixed,
  scholarship: mongoose.Schema.Types.Mixed,

  gallery: mongoose.Schema.Types.Mixed,
  qna: mongoose.Schema.Types.Mixed,

}, {
  strict: false,   // 🔥 VERY IMPORTANT
  timestamps: true
});

CollegeSchema.index({ name: "text", location: 1 });
CollegeSchema.index({ createdAt: -1 });
CollegeSchema.index({ rating: -1, createdAt: -1 });

const College = mainConn.model("college", CollegeSchema, "new_college");

async function ensureFeaturedCollegeFieldDefaults() {
  const result = await College.updateMany(
    {
      $or: [
        { featured_college: { $exists: false } },
        { featured_college: null },
        { featured_college: "" },
      ],
    },
    {
      $set: {
        featured_college: "No featured",
      },
    }
  );

  const modifiedCount = result?.modifiedCount || result?.nModified || 0;
  if (modifiedCount > 0) {
    console.log(
      `Backfilled featured_college for ${modifiedCount} college records.`
    );
  }
}

const MainCourseDetailsSchema = new mongoose.Schema(
  {
    heading: CMSControlledFieldSchema,
    overview_full_text: CMSControlledFieldSchema,
    overview_paragraphs: CMSControlledFieldSchema,
    highlights: CMSControlledFieldSchema,
  },
  { _id: false }
);

const MainCourseSchema = new mongoose.Schema(
  {
    id: CMSControlledFieldSchema,
    name: CMSControlledFieldSchema,
    collegeId: CMSControlledFieldSchema,
    collegeName: CMSControlledFieldSchema,
    rating: CMSControlledFieldSchema,
    fees: CMSControlledFieldSchema,
    duration: CMSControlledFieldSchema,
    eligibility: CMSControlledFieldSchema,
    mode: CMSControlledFieldSchema,
    reviews: CMSControlledFieldSchema,
    details: MainCourseDetailsSchema,
    collegeRawAdmission: CMSControlledFieldSchema,
    rawData: CMSControlledFieldSchema,
  },
  { timestamps: true }
);

const BasicCollegeCourseItemSchema = new mongoose.Schema(
  {
    name: CMSControlledFieldSchema,
    duration: CMSControlledFieldSchema,
    level: CMSControlledFieldSchema,
    fees: CMSControlledFieldSchema,
    eligibility: CMSControlledFieldSchema,
    about: CMSControlledFieldSchema,
    mode: CMSControlledFieldSchema,
    intake: CMSControlledFieldSchema,
    admissionProcess: CMSControlledFieldSchema,
    highlights: CMSControlledFieldSchema,
    skills: CMSControlledFieldSchema,
    structure: CMSControlledFieldSchema,
    statistics: CMSControlledFieldSchema,
    rawData: CMSControlledFieldSchema,
  },
  { _id: false }
);

const CollegeCourseSchema = new mongoose.Schema(
  {
    sourceUrl: CMSControlledFieldSchema,
    status: CMSControlledFieldSchema,
    progress: CMSControlledFieldSchema,
    full_name: CMSControlledFieldSchema,
    college_name: CMSControlledFieldSchema,
    location: CMSControlledFieldSchema,
    estd_year: CMSControlledFieldSchema,
    college_type: CMSControlledFieldSchema,
    rating: CMSControlledFieldSchema,
    review_count: CMSControlledFieldSchema,
    about_text: CMSControlledFieldSchema,
    about_list: CMSControlledFieldSchema,
    gallery: CMSControlledFieldSchema,
    heroImages: CMSControlledFieldSchema,
    hero_generated: CMSControlledFieldSchema,
    courses: [BasicCollegeCourseItemSchema],
    rawData: CMSControlledFieldSchema,
  },
  { timestamps: true }
);

const MainCourse = mainConn.model("maincourse", MainCourseSchema, "maincourse");
const CollegeCourse = mainConn.model(
  "college_course",
  CollegeCourseSchema,
  "college_course"
);

// Raw CMS schema (no transformation) for collegedunia course pages
const CollegeCourseCMSRawSchema = new mongoose.Schema(
  {
    source: String,
    url: String,
    college_id: Number,
    courses: {
      type: [mongoose.Schema.Types.Mixed],
      default: [],
    },
  },
  {
    strict: false,
    timestamps: true,
  }
);

const CollegeCourseCMS = mainConn.model(
  "college_course_cms_raw",
  CollegeCourseCMSRawSchema,
  "college_course"
);
const CollegeCourseCMSSpace = mainConn.model(
  "college_course_cms_raw_space",
  CollegeCourseCMSRawSchema,
  "college course"
);


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
    content: {
  blocks: {
    type: Array,
    default: []
  }
},
    category: String, 
    
// htmlContent: String, 
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

const emitToRoom = (room, event, payload) => {
  try {
    io.to(room).emit(event, payload);
  } catch (e) {
    console.warn("Socket room emit error:", e.message);
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
const getBestRanking = (rankingData = []) => {
  if (!Array.isArray(rankingData)) return null;

  // Priority: India / NIRF / Collegedunia
  const preferred = rankingData.find(r =>
    /india|nirf|collegedunia/i.test(r.ranking)
  );

  return preferred?.ranking || rankingData[0]?.ranking || null;
};

const getCourseTier = (totalColleges) => {
  if (totalColleges >= 5) return "primary";    // show on /courses
  if (totalColleges >= 2) return "secondary";  // show on /courses/all
  return "longtail";                           // search only
};

const unwrapCmsValue = (field) => {
  if (
    field &&
    typeof field === "object" &&
    !Array.isArray(field) &&
    Object.prototype.hasOwnProperty.call(field, "value")
  ) {
    return field.value;
  }
  return field;
};

const pickFirstNonEmpty = (...values) => {
  for (const value of values) {
    if (value === null || value === undefined) continue;
    const text = String(value).trim();
    if (text) return text;
  }
  return null;
};

const stripObjectKeyDeep = (node, blockedKey) => {
  if (Array.isArray(node)) {
    return node.map((item) => stripObjectKeyDeep(item, blockedKey));
  }

  if (!node || typeof node !== "object") {
    return node;
  }

  if (
    typeof node.toHexString === "function" ||
    node?._bsontype === "ObjectId"
  ) {
    return String(node.toHexString());
  }

  return Object.entries(node).reduce((acc, [key, value]) => {
    if (key === blockedKey) {
      return acc;
    }

    acc[key] = stripObjectKeyDeep(value, blockedKey);
    return acc;
  }, {});
};

const normalizeExistingFeesRange = (feesRange) => {
  if (!feesRange || typeof feesRange !== "object") return null;
  const min = Number(feesRange.min);
  const max = Number(feesRange.max);
  if (Number.isFinite(min) && Number.isFinite(max) && min > 0 && max >= min) {
    return { min, max };
  }
  return null;
};

const normalizeMainStreamLabel = (value) => {
  if (!value) return null;
  const raw = String(value).trim();
  const key = raw.toLowerCase();

  const map = {
    management: "MBA / PGDM",
    mba: "MBA / PGDM",
    engineering: "B.E / B.Tech",
    medical: "MBBS",
    it: "BCA",
    commerce: "B.Com",
    science: "B.Sc",
    arts: "BA",
    education: "B.Ed",
    law: "BA LLB",
    btech: "B.E / B.Tech",
    mtech: "M.E / M.Tech",
    bca: "BCA",
    mca: "MCA",
    bba: "BBA",
    general: "General",
  };

  return map[key] || raw;
};

const inferStreamFromCollege = (college) => {
  if (college?.stream) return normalizeMainStreamLabel(college.stream);

  const corpus = [
    college?.name,
    college?.type,
    college?.basic?.name,
    college?.basic?.college_type,
    unwrapCmsValue(college?.cms?.basic?.name),
    unwrapCmsValue(college?.cms?.basic?.college_type),
    unwrapCmsValue(college?.cms?.about?.about_highlights),
    college?.about?.about_highlights,
    college?.admission?.about?.value,
    unwrapCmsValue(college?.cms?.admission?.about?.value),
  ]
    .filter(Boolean)
    .map(v => (typeof v === "string" ? v : JSON.stringify(v)))
    .join(" ")
    .toLowerCase();

  const scored = TOP_COURSES.map(course => {
    const score = course.keywords.reduce((acc, keyword) => {
      const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const re = new RegExp(`\\b${escaped}\\b`, "i");
      return acc + (re.test(corpus) ? 1 : 0);
    }, 0);
    return { name: course.name, score };
  }).sort((a, b) => b.score - a.score);

  if (scored[0]?.score > 0) {
    return scored[0].name;
  }

  if (/\biim\b/.test(corpus)) return "MBA / PGDM";
  return "General";
};

const toPlainValue = (value) => {
  let current = value;

  while (
    current &&
    typeof current === "object" &&
    !Array.isArray(current) &&
    Object.prototype.hasOwnProperty.call(current, "value")
  ) {
    current = current.value;
  }

  return current;
};

const pickFirstText = (...values) => {
  for (const value of values) {
    const plainValue = toPlainValue(value);

    if (plainValue === null || plainValue === undefined) continue;

    if (typeof plainValue === "number" && Number.isFinite(plainValue)) {
      return String(plainValue);
    }

    if (typeof plainValue !== "string") continue;

    const text = plainValue.trim();
    if (text) return text;
  }

  return "";
};

const toArrayValue = (value) => {
  const plainValue = toPlainValue(value);
  return Array.isArray(plainValue) ? plainValue : [];
};

const GENERIC_COURSE_SLUGS = new Set([
  "course",
  "courses",
  "syllabus",
  "subjects",
  "fees",
  "admission",
  "admissions",
  "eligibility",
  "scope",
  "jobs",
  "salary",
  "placements",
  "placement",
  "cutoff",
  "cutoffs",
  "ranking",
  "rankings",
  "review",
  "reviews",
  "faq",
  "faqs",
  "dates",
  "important-dates",
  "important-date",
  "results",
  "comparison",
  "apply",
]);

const slugifyCourseText = (value = "") =>
  String(value)
    .toLowerCase()
    .replace(/[\[\](){}]/g, " ")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

const cleanCourseSlug = (value = "") => {
  let slug = slugifyCourseText(value);

  const cleanupPatterns = [
    /-course-details?$/,
    /-details?$/,
    /-syllabus(?:-.+)?$/,
    /-subjects?(?:-.+)?$/,
    /-fees?(?:-.+)?$/,
    /-admission(?:-.+)?$/,
    /-eligibility(?:-.+)?$/,
    /-scope(?:-.+)?$/,
    /-jobs?(?:-.+)?$/,
    /-salary(?:-.+)?$/,
    /-placements?(?:-.+)?$/,
    /-cutoff(?:-.+)?$/,
  ];

  cleanupPatterns.forEach((pattern) => {
    slug = slug.replace(pattern, "");
  });

  slug = slug.replace(/-\d{2,}$/, "");

  return slug.replace(/^-+|-+$/g, "");
};

const extractSlugFromUrl = (value = "") => {
  if (!value) return "";

  const raw = String(value).trim();
  if (!raw) return "";

  try {
    const url =
      raw.startsWith("http://") || raw.startsWith("https://")
        ? new URL(raw)
        : new URL(raw, "https://studycups.local");
    const segments = url.pathname
      .replace(/\/+$/g, "")
      .split("/")
      .filter(Boolean)
      .map((segment) => cleanCourseSlug(segment))
      .filter(Boolean);

    const coursesIndex = segments.lastIndexOf("courses");
    if (coursesIndex !== -1 && segments[coursesIndex + 1]) {
      return segments[coursesIndex + 1];
    }

    const lastSegment = segments[segments.length - 1] || "";
    if (
      GENERIC_COURSE_SLUGS.has(lastSegment) &&
      segments.length > 1
    ) {
      return segments[segments.length - 2];
    }

    return lastSegment;
  } catch {
    const segments = raw
      .replace(/\/+$/g, "")
      .split("/")
      .filter(Boolean)
      .map((segment) => cleanCourseSlug(segment))
      .filter(Boolean);

    const lastSegment = segments[segments.length - 1] || cleanCourseSlug(raw);
    if (
      GENERIC_COURSE_SLUGS.has(lastSegment) &&
      segments.length > 1
    ) {
      return segments[segments.length - 2];
    }

    return lastSegment;
  }
};

const toCourseMatchKey = (value = "") => {
  const cleanedSlug = cleanCourseSlug(value);
  if (!cleanedSlug || GENERIC_COURSE_SLUGS.has(cleanedSlug)) return "";
  return cleanedSlug.replace(/-/g, "");
};

const addCourseMatchKey = (target, value) => {
  const plainValue = toPlainValue(value);

  if (plainValue === null || plainValue === undefined) return;

  if (typeof plainValue === "number" && Number.isFinite(plainValue)) {
    const numericKey = toCourseMatchKey(String(plainValue));
    if (numericKey) target.add(numericKey);
    return;
  }

  if (typeof plainValue !== "string") return;

  const text = plainValue.trim();
  if (!text) return;

  const isUrlLike = /^(https?:\/\/|\/)/i.test(text);
  const urlSlug = extractSlugFromUrl(text);
  const urlKey = toCourseMatchKey(urlSlug);
  const textKey = isUrlLike ? "" : toCourseMatchKey(text);

  if (urlKey) target.add(urlKey);
  if (textKey) target.add(textKey);
};

const getPreferredCourseSlug = (...values) => {
  for (const value of values) {
    const plainValue = toPlainValue(value);
    if (plainValue === null || plainValue === undefined) continue;
    if (typeof plainValue !== "string") continue;

    const text = plainValue.trim();
    if (!text) continue;

    const isUrlLike = /^(https?:\/\/|\/)/i.test(text);
    const slug = isUrlLike ? extractSlugFromUrl(text) : cleanCourseSlug(text);
    if (slug) return slug;
  }

  return "";
};

const getNumericId = (...values) => {
  for (const value of values) {
    const plainValue = toPlainValue(value);
    const num = Number(plainValue);
    if (Number.isFinite(num) && num > 0) return num;
  }

  return null;
};

const parseCourseFeeAmount = (value) => {
  const plainValue = toPlainValue(value);

  if (plainValue === null || plainValue === undefined) return null;

  if (typeof plainValue === "number" && Number.isFinite(plainValue)) {
    return plainValue >= 1000 ? plainValue : null;
  }

  if (typeof plainValue !== "string") return null;

  const text = plainValue.trim();
  if (!text) return null;

  const lower = text.toLowerCase();
  const looksLikeFee =
    /₹|inr|rs\.?|rupees?/.test(text) ||
    /lakh|lakhs|crore|crores|cr\b|k\b|thousand/.test(lower) ||
    /\d[\d,]{3,}/.test(text);

  if (!looksLikeFee) return null;

  const parsed = parseFees(text);
  if (parsed !== null && parsed >= 1000) return parsed;

  const extractedAmount = extractAmountsFromText(text)[0];
  return Number.isFinite(extractedAmount) ? extractedAmount : null;
};

const extractCourseFees = (...nodes) => {
  const feeKeys = [
    "avg_fees",
    "average_fees",
    "avgFees",
    "fees",
    "course_fees",
    "courseFees",
    "fee",
    "total_fees",
    "totalFees",
  ];

  for (const node of nodes) {
    if (!node || typeof node !== "object") continue;

    for (const feeKey of feeKeys) {
      const parsed = parseCourseFeeAmount(node[feeKey]);
      if (parsed !== null) return parsed;
    }
  }

  return null;
};

const extractCourseSummaryFromFirstTocTable = (courseDetail = {}) => {
  const firstSection = toArrayValue(courseDetail?.toc_sections)[0];
  if (!firstSection) {
    return {
      avg_fees: null,
      course_level: "",
    };
  }

  const firstTable = toArrayValue(firstSection?.content).find((item) => {
    const type = pickFirstText(item?.type).toLowerCase();
    return type === "table" && Array.isArray(toPlainValue(item?.value));
  });

  if (!firstTable) {
    return {
      avg_fees: null,
      course_level: "",
    };
  }

  const rows = toArrayValue(firstTable?.value);
  const summary = {
    avg_fees: null,
    course_level: "",
  };

  for (const row of rows) {
    if (!Array.isArray(row) || row.length < 2) continue;

    const label = pickFirstText(row[0]).toLowerCase();
    const valueText = row
      .slice(1)
      .map((cell) => pickFirstText(cell))
      .filter(Boolean)
      .join(" ");

    if (!label || !valueText) continue;

    if (!summary.course_level && /(course level|course type|\blevel\b)/i.test(label)) {
      summary.course_level = valueText;
    }

    if (summary.avg_fees === null && /(fee|fees|salary|package|ctc)/i.test(label)) {
      const parsed = parseCourseFeeAmount(valueText);
      if (parsed !== null) {
        summary.avg_fees = parsed;
      }
    }

    if (summary.avg_fees !== null && summary.course_level) {
      break;
    }
  }

  return summary;
};

const averageNumbers = (values = []) => {
  const numericValues = values.filter((value) => Number.isFinite(value));
  if (!numericValues.length) return null;

  return Math.round(
    numericValues.reduce((sum, value) => sum + value, 0) / numericValues.length
  );
};

const extractAmountsFromText = (text) => {
  if (!text || typeof text !== "string") return [];
  const out = [];
  const regex = /(\d+(?:\.\d+)?)\s*(crore|cr|lakh|lakhs|lac|lacs|thousand|k)?/gi;

  let match;
  while ((match = regex.exec(text)) !== null) {
    const raw = Number(match[1]);
    if (!Number.isFinite(raw)) continue;

    const unit = (match[2] || "").toLowerCase();
    let amount = raw;

    if (unit === "crore" || unit === "cr") amount = raw * 10000000;
    else if (unit === "lakh" || unit === "lakhs" || unit === "lac" || unit === "lacs") amount = raw * 100000;
    else if (unit === "thousand" || unit === "k") amount = raw * 1000;
    else if (raw < 1000 || (raw >= 1900 && raw <= 2100)) continue;

    out.push(Math.round(amount));
  }

  return out;
};

const extractFeesRangeFromCollege = (college) => {
  const existing = normalizeExistingFeesRange(college?.feesRange || college?.rawScraped?.feesRange);
  if (existing) return existing;

  const feeValues = [];

  const walk = (node) => {
    if (!node) return;

    const valueNode = unwrapCmsValue(node);

    if (typeof valueNode === "string") {
      const lower = valueNode.toLowerCase();
      if (/fee|fees|tuition/.test(lower) && !/ctc|salary|stipend|package|lpa/.test(lower)) {
        feeValues.push(...extractAmountsFromText(valueNode));
      }
      return;
    }

    if (Array.isArray(valueNode)) {
      const looksLikeTable = valueNode.length > 0 && valueNode.every(row => Array.isArray(row));
      if (looksLikeTable) {
        const header = valueNode[0].map(cell => String(cell || "")).join(" ").toLowerCase();
        if (/fee|fees|tuition/.test(header)) {
          valueNode.forEach(row => {
            row.forEach(cell => feeValues.push(...extractAmountsFromText(String(cell || ""))));
          });
        }
      }
      valueNode.forEach(walk);
      return;
    }

    if (typeof valueNode === "object") {
      Object.values(valueNode).forEach(walk);
    }
  };

  walk(college?.basic?.about_highlights);
  walk(college?.about?.about_highlights);
  walk(college?.basic?.toc_sections);
  walk(college?.about?.toc_sections);
  walk(college?.admission?.toc_sections);
  walk(college?.cms?.about);
  walk(college?.cms?.admission);
  walk(college?.rawScraped);

  const cleaned = feeValues.filter(v => Number.isFinite(v) && v >= 10000);
  if (!cleaned.length) return null;

  return {
    min: Math.min(...cleaned),
    max: Math.max(...cleaned),
  };
};

const extractRankingFromCollege = (college) => {
  const rawRanking = getBestRanking(college?.rawScraped?.ranking_data);
  if (rawRanking) return rawRanking;

  const candidates = [];
  const nodes = [
    college?.ranking,
    college?.basic?.about,
    college?.basic?.about_highlights,
    college?.basic?.toc_sections,
    college?.about,
    college?.cms?.ranking,
    college?.cms?.about,
    college?.rawScraped?.ranking,
  ];

  const agencyScore = (txt = "") => {
    const t = txt.toLowerCase();
    if (t.includes("nirf")) return 5000;
    if (t.includes("collegedunia")) return 4000;
    if (t.includes("outlook")) return 3000;
    if (t.includes("iirf")) return 2500;
    if (t.includes("qs")) return 2000;
    return 1000;
  };

  const pushCandidate = (agency, year, rank) => {
    if (!rank) return;
    const y = Number(year) || 0;
    const label = [agency, y || null, rank].filter(Boolean).join(" ").trim();
    candidates.push({ label, score: agencyScore(agency) + y });
  };

  const walk = (node) => {
    if (!node) return;
    const valueNode = unwrapCmsValue(node);

    if (typeof valueNode === "string") {
      const m = valueNode.match(/(nirf|collegedunia|outlook|iirf|qs)[^.\n]{0,100}?(\d{4})?[^.\n]{0,40}?(\d{1,3}(?:st|nd|rd|th)?)/i);
      if (m) pushCandidate(m[1].toUpperCase(), m[2], m[3]);
      return;
    }

    if (Array.isArray(valueNode)) {
      const isTable = valueNode.length > 0 && valueNode.every(r => Array.isArray(r));
      if (isTable) {
        const header = valueNode[0].map(x => String(x || "")).join(" ").toLowerCase();
        if (header.includes("rank")) {
          valueNode.slice(1).forEach(row => {
            const rowText = row.map(x => String(x || "")).join(" ");
            const agency = row[0] ? String(row[0]) : "Ranking";
            const yearMatch = rowText.match(/\b(20\d{2})\b/);
            const rankMatch = rowText.match(/\b(\d{1,3}(?:st|nd|rd|th)?)\b/i);
            if (rankMatch) {
              pushCandidate(agency, yearMatch?.[1], rankMatch[1]);
            }
          });
        }
      }
      valueNode.forEach(walk);
      return;
    }

    if (typeof valueNode === "object") {
      Object.values(valueNode).forEach(walk);
    }
  };

  nodes.forEach(walk);

  if (!candidates.length) return null;
  candidates.sort((a, b) => b.score - a.score);
  return candidates[0].label || null;
};

const parseNumericValue = (value) => {
  if (value === null || value === undefined) return null;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const cleaned = String(value).replace(/[^0-9.]/g, "");
  const num = Number(cleaned);
  return Number.isFinite(num) ? num : null;
};

const extractRatingAndReviews = (college) => {
  const reviewsPage =
    college?.reviews_page ||
    college?.rawScraped?.reviews_page ||
    unwrapCmsValue(college?.cms?.reviews_page) ||
    null;

  const rating = (
    parseNumericValue(college?.rating) ??
    parseNumericValue(reviewsPage?.overall_rating?.score) ??
    parseNumericValue(college?.rawScraped?.rating)
  );

  const reviewCount = (
    parseNumericValue(college?.reviewCount) ??
    parseNumericValue(reviewsPage?.overall_rating?.total_reviews) ??
    parseNumericValue(college?.rawScraped?.review_count)
  );

  return {
    rating: rating ?? null,
    reviewCount: reviewCount ?? 0,
  };
};

const extractCollegePackageHighlights = (college) => {
  const packageHighlights =
    college?.placement?.package_highlights ||
    college?.placement?.packageHighlights ||
    college?.rawScraped?.placement?.package_highlights ||
    null;

  const highestPackage = pickFirstNonEmpty(
    packageHighlights?.highest_package,
    packageHighlights?.highestPackage
  );
  const averagePackage = pickFirstNonEmpty(
    packageHighlights?.average_package,
    packageHighlights?.averagePackage
  );

  if (!highestPackage && !averagePackage) {
    return null;
  }

  return {
    highest_package: highestPackage || null,
    average_package: averagePackage || null,
  };
};

const extractCollegeEstablishedYear = (college) => {
  const rawYear = pickFirstNonEmpty(
    college?.established_year,
    college?.established,
    college?.basic?.established_year,
    unwrapCmsValue(college?.cms?.basic?.established_year),
    college?.rawScraped?.established_year,
    college?.rawScraped?.estd_year
  );

  if (!rawYear) return null;

  const match = String(rawYear).match(/\b(18|19|20)\d{2}\b/);
  if (match) {
    return Number(match[0]);
  }

  return String(rawYear).trim() || null;
};

const extractCollegeAccreditation = (college) =>
  pickFirstNonEmpty(
    college?.basic?.accreditation,
    unwrapCmsValue(college?.cms?.basic?.accreditation),
    college?.accreditation,
    college?.rawScraped?.accreditation
  ) || null;

const extractCollegeAffiliations = (college) => {
  const candidates = [
    college?.affiliations,
    college?.affiliation,
    college?.basic?.affiliations,
    college?.basic?.affiliation,
    unwrapCmsValue(college?.cms?.basic?.affiliations),
    unwrapCmsValue(college?.cms?.basic?.affiliation),
    college?.rawScraped?.affiliations,
    college?.rawScraped?.affiliation,
    college?.rawScraped?.affiliated_to,
    college?.rawScraped?.affiliatedTo,
  ];

  for (const candidate of candidates) {
    const plainValue = toPlainValue(candidate);

    if (Array.isArray(plainValue)) {
      const items = plainValue
        .map((item) =>
          pickFirstText(item?.name, item?.title, item?.value, item)
        )
        .filter(Boolean);

      if (items.length) {
        return items;
      }
    }

    if (typeof plainValue === "string" && plainValue.trim()) {
      return [plainValue.trim()];
    }
  }

  return [];
};

const buildCollegeDetailPayload = (college = {}) => {
  const sanitizedCollege = stripObjectKeyDeep(college, "header_highlights");

  return {
    ...sanitizedCollege,
    accreditation: extractCollegeAccreditation(sanitizedCollege),
    affiliations: extractCollegeAffiliations(sanitizedCollege),
  };
};

const getCollegeCardData = (college) => {
  const sourceIdRaw =
    college?.source_college_id ??
    unwrapCmsValue(college?.cms?.source_college_id) ??
    college?.rawScraped?.source_college_id;
  const sourceUrl = pickFirstNonEmpty(
    college?.url,
    unwrapCmsValue(college?.cms?.url),
    college?.rawScraped?.url
  );
  const urlIdMatch = sourceUrl?.match(/\/(?:college|university)\/(\d+)-/i);
  const urlIdNum = Number(urlIdMatch?.[1]);
  const sourceIdNum = Number(sourceIdRaw);
  const id =
    college?.id ??
    (Number.isFinite(sourceIdNum) ? sourceIdNum : null) ??
    (Number.isFinite(urlIdNum) ? urlIdNum : null);

  const name = pickFirstNonEmpty(
    college?.name,
    college?.basic?.name,
    unwrapCmsValue(college?.cms?.basic?.name)
  );

  const city = pickFirstNonEmpty(
    college?.basic?.city,
    unwrapCmsValue(college?.cms?.basic?.city)
  );
  const state = pickFirstNonEmpty(
    college?.basic?.state,
    unwrapCmsValue(college?.cms?.basic?.state)
  );

  const location = pickFirstNonEmpty(
    college?.location,
    [city, state].filter(Boolean).join(", ")
  );

  const heroImage = pickFirstNonEmpty(
    college?.heroImage,
    college?.heroImages?.[0],
    college?.gallery?.[0]?.src,
    unwrapCmsValue(college?.cms?.gallery?.[0]?.src)
  );

  const logoUrl = pickFirstNonEmpty(
    college?.logoUrl,
    college?.basic?.logo,
    unwrapCmsValue(college?.cms?.basic?.logo),
    college?.rawScraped?.logo
  );

  const stream = inferStreamFromCollege(college);
  const feesRange = extractFeesRangeFromCollege(college);
  const ranking = extractRankingFromCollege(college);
  const ratingMeta = extractRatingAndReviews(college);
  const packageHighlights = extractCollegePackageHighlights(college);
  const establishedYear = extractCollegeEstablishedYear(college);
  const avgFees =
    Number.isFinite(college?.avg_fees)
      ? college.avg_fees
      : computeAverageFees(feesRange);
  return {
    id,
    name,
    location,
    established_year: establishedYear,
    rating: ratingMeta.rating,
    reviewCount: ratingMeta.reviewCount,
    heroImage,
    imageUrl: heroImage,
    logoUrl,
    stream,
    feesRange,
    ranking,
    avg_fees: avgFees,
    package_highlights: packageHighlights,
  };
}; 

// ===============================
// COURSE LEVEL NORMALIZER
// ===============================

const normalizeLevel = (text) => {

  if (!text) return null;

  text = text.toLowerCase();

  if (text.includes("undergraduate") || text.includes("bachelor")) {
    return "Undergraduate";
  }

  if (text.includes("postgraduate") || text.includes("master")) {
    return "Postgraduate";
  }

  if (text.includes("doctor")) {
    return "Doctorate";
  }

  if (text.includes("diploma")) {
    return "Diploma";
  }

  if (text.includes("certificate")) {
    return "Certificate";
  }

  return null;
};

const getCollegeBackfillPayload = (college, card) => {
  const $set = {};

  if (!college?.id && Number.isFinite(card.id)) $set.id = card.id;
  if (!college?.name && card.name) $set.name = card.name;
  if (!college?.location && card.location) $set.location = card.location;
  if (!college?.stream && card.stream) $set.stream = card.stream;
  if (!college?.heroImage && card.heroImage) $set.heroImage = card.heroImage;
  if ((!Array.isArray(college?.heroImages) || !college.heroImages.length) && card.heroImage) {
    $set.heroImages = [card.heroImage];
    $set.heroDownloaded = true;
  }
  if (!normalizeExistingFeesRange(college?.feesRange) && card.feesRange) {
    $set.feesRange = card.feesRange;
  }
  if ((college?.rating === null || college?.rating === undefined) && card.rating !== null) {
    $set.rating = card.rating;
  }
  if ((college?.reviewCount === null || college?.reviewCount === undefined) && card.reviewCount > 0) {
    $set.reviewCount = card.reviewCount;
  }
  // ===== AUTO BACKFILL AVG FEES =====
if (
  (college?.avg_fees === null || college?.avg_fees === undefined) &&
  Number.isFinite(card.avg_fees)
) {
  $set.avg_fees = card.avg_fees;
}

  return Object.keys($set).length ? { $set } : null;
};

const COLLEGE_CARD_CACHE_TTL_MS = 60 * 60 * 1000;
let collegeCardCatalogCache = {
  expiresAt: 0,
  value: null,
  promise: null,
};

const resetCollegeCardCatalogCache = () => {
  collegeCardCatalogCache = {
    expiresAt: 0,
    value: null,
    promise: null,
  };
};

const COLLEGE_CARD_PROJECTION = {
  id: 1,
  name: 1,
  established_year: 1,
  established: 1,
  featured_college: 1,
  location: 1,
  stream: 1,
  heroImage: 1,
  heroImages: 1,
  gallery: 1,
  logoUrl: 1,
  feesRange: 1,
  avg_fees: 1,
  ranking: 1,
  rating: 1,
  reviewCount: 1,
  type: 1,
  accreditation: 1,
  url: 1,
  source_college_id: 1,
  createdAt: 1,
  basic: 1,
  about: 1,
  admission: 1,
  "placement.package_highlights": 1,
  "placement.packageHighlights": 1,
  "cms.source_college_id": 1,
  "cms.url": 1,
  "cms.gallery": 1,
  "cms.basic": 1,
  "cms.about": 1,
  "cms.admission": 1,
  "cms.ranking": 1,
  "cms.reviews_page": 1,
  reviews_page: 1,
  "rawScraped.source_college_id": 1,
  "rawScraped.url": 1,
  "rawScraped.logo": 1,
  "rawScraped.feesRange": 1,
  "rawScraped.ranking": 1,
  "rawScraped.ranking_data": 1,
  "rawScraped.rating": 1,
  "rawScraped.review_count": 1,
  "rawScraped.reviews_page": 1,
  "rawScraped.accreditation": 1,
  "rawScraped.established_year": 1,
  "rawScraped.estd_year": 1,
  "rawScraped.placement.package_highlights": 1,
};

const buildCollegeCardCacheEntry = (college = {}) => {
  const card = getCollegeCardData(college);
  const objectId = String(college?._id || "");
  const createdAt = college?.createdAt ? new Date(college.createdAt).getTime() : 0;
  const city = college?.basic?.city || null;
  const state = college?.basic?.state || null;
  const collegeType = college?.basic?.college_type || college?.type || null;
  const accreditation = extractCollegeAccreditation(college);

  return {
    objectId,
    collegeId: Number.isFinite(Number(card.id)) ? Number(card.id) : null,
    createdAt,
    card,
    listing: {
      _id: college?._id,
      id: card.id,
      name: card.name,
      featured_college: college?.featured_college || "No featured",
      location: card.location,
      established_year: card.established_year,
      city,
      state,
      college_id: card.id,
      heroImage: card.heroImage,
      imageUrl: card.imageUrl,
      ranking: card.ranking,
      rating: card.rating,
      reviewCount: card.reviewCount,
      stream: card.stream,
      logoUrl: card.logoUrl,
      feesRange: card.feesRange,
      college_type: collegeType,
      accreditation,
      avg_fees: card.avg_fees,
      package_highlights: card.package_highlights,
    },
    listItem: {
      id: card.id,
      name: card.name,
      location: card.location,
      established_year: card.established_year,
      rating: card.rating,
      type: collegeType,
      createdAt: college?.createdAt || null,
      package_highlights: card.package_highlights,
    },
  };
};

const getCollegeCardCatalog = async () => {
  if (
    collegeCardCatalogCache.value &&
    collegeCardCatalogCache.expiresAt > Date.now()
  ) {
    return collegeCardCatalogCache.value;
  }

  if (collegeCardCatalogCache.promise) {
    return collegeCardCatalogCache.promise;
  }

  collegeCardCatalogCache.promise = (async () => {
    const docs = await College.find({}, COLLEGE_CARD_PROJECTION).lean();
    const entries = docs.map((college) => buildCollegeCardCacheEntry(college));
    const byObjectId = new Map();
    const byCollegeId = new Map();
    const list = [];

    entries.forEach((entry) => {
      if (entry.objectId) {
        byObjectId.set(entry.objectId, entry);
      }

      if (entry.collegeId && !byCollegeId.has(entry.collegeId)) {
        byCollegeId.set(entry.collegeId, entry);
      }

      list.push(entry.listItem);
    });

    list.sort((a, b) => {
      const aTime = a?.createdAt ? new Date(a.createdAt).getTime() : 0;
      const bTime = b?.createdAt ? new Date(b.createdAt).getTime() : 0;
      return bTime - aTime;
    });

    const value = {
      total: entries.length,
      byObjectId,
      byCollegeId,
      list,
    };

    collegeCardCatalogCache = {
      expiresAt: Date.now() + COLLEGE_CARD_CACHE_TTL_MS,
      value,
      promise: null,
    };

    return value;
  })();

  try {
    return await collegeCardCatalogCache.promise;
  } catch (error) {
    collegeCardCatalogCache.promise = null;
    throw error;
  }
};

let collegeInsertChangeStream = null;
let collegeInsertChangeStreamRetryTimer = null;
let isCollegeInsertChangeStreamActive = false;

function getCollegeRealtimeMeta() {
  return {
    room: COLLEGE_SOCKET_ROOM,
    event: COLLEGE_LIST_CHANGED_EVENT,
  };
}

function buildCollegeSocketPayload(college = {}, action = "created", extras = {}) {
  const entry = buildCollegeCardCacheEntry(college);

  return {
    action,
    source: extras.source || "api",
    college: entry.listing,
    card: entry.card,
    listItem: entry.listItem,
    realtime: getCollegeRealtimeMeta(),
    emittedAt: new Date().toISOString(),
  };
}

function emitCollegeRealtimeChange(action, college = {}, extras = {}) {
  const payload = buildCollegeSocketPayload(college, action, extras);

  if (action === "created") {
    emit("college:created", payload);
  }

  emitToRoom(COLLEGE_SOCKET_ROOM, COLLEGE_LIST_CHANGED_EVENT, payload);
  return payload;
}

function scheduleCollegeInsertChangeStreamRestart(reason = "unknown") {
  if (collegeInsertChangeStreamRetryTimer) return;

  console.warn(
    `College insert change stream will retry in ${COLLEGE_CHANGE_STREAM_RETRY_MS}ms (${reason}).`
  );

  collegeInsertChangeStreamRetryTimer = setTimeout(() => {
    collegeInsertChangeStreamRetryTimer = null;
    startCollegeInsertChangeStream();
  }, COLLEGE_CHANGE_STREAM_RETRY_MS);
}

function resetCollegeInsertChangeStreamState() {
  isCollegeInsertChangeStreamActive = false;
  const activeStream = collegeInsertChangeStream;
  collegeInsertChangeStream = null;

  if (!activeStream) return;

  try {
    activeStream.removeAllListeners();
  } catch (error) {
    console.warn("College insert change stream cleanup error:", error?.message || error);
  }

  try {
    const closePromise = activeStream.close?.();
    if (closePromise?.catch) {
      closePromise.catch(() => {});
    }
  } catch (error) {
    // ignore close errors during cleanup
  }
}

function startCollegeInsertChangeStream() {
  if (collegeInsertChangeStream || mainConn.readyState !== 1) return;

  try {
    collegeInsertChangeStream = College.watch([
      { $match: { operationType: "insert" } },
    ]);
    isCollegeInsertChangeStreamActive = true;

    console.log("College insert change stream started.");

    collegeInsertChangeStream.on("change", (change) => {
      const insertedCollege = change?.fullDocument;
      if (!insertedCollege) return;

      resetCollegeCardCatalogCache();
      emitCollegeRealtimeChange("created", insertedCollege, {
        source: "change-stream",
      });
    });

    collegeInsertChangeStream.on("error", (error) => {
      console.error(
        "College insert change stream error:",
        error?.message || error
      );
      resetCollegeInsertChangeStreamState();
      scheduleCollegeInsertChangeStreamRestart("error");
    });

    collegeInsertChangeStream.on("close", () => {
      console.warn("College insert change stream closed.");
      resetCollegeInsertChangeStreamState();
      scheduleCollegeInsertChangeStreamRestart("close");
    });
  } catch (error) {
    console.warn(
      "College insert change stream unavailable:",
      error?.message || error
    );
    resetCollegeInsertChangeStreamState();
    scheduleCollegeInsertChangeStreamRestart("startup");
  }
}

app.post("/api/chat-registration", async (req, res) => {
  try {
    const { name, email, phone, course, city } = req.body;

    if (!name || !phone) {
      return res.status(400).json({
        success: false,
        message: "Name and phone are required",
      });
    }

    // Optional duplicate check
    const existing = await Registration.findOne({ phone });
    if (existing) {
      return res.json({
        success: true,
        message: "Already registered",
      });
    }

    const registration = new Registration({
      name,
      email,
      phone,
      course,
      city,
    });

    await registration.save();

    res.json({
      success: true,
      message: "Chat registration saved",
    });
  } catch (err) {
    console.error("Chat Registration Error:", err);
    res.status(500).json({
      success: false,
      message: "Server error",
    });
  }
});



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
        heroImage: req.body.heroImage || imageUrl || undefined,
        heroImages:
          Array.isArray(req.body.heroImages) && req.body.heroImages.length
            ? req.body.heroImages
            : imageUrl
              ? [imageUrl]
              : [],
        logoUrl,
        gallery: galleryUrls,
        rawScraped: req.body.rawScraped || {}
      });


      const saved = await college.save();
      resetCollegeCardCatalogCache();

      if (!isCollegeInsertChangeStreamActive) {
        emitCollegeRealtimeChange("created", saved, { source: "api" });
      }

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
  "/api/college",
  asyncHandler(async (req, res) => {

    // ✅ DEFAULT: return ALL colleges (up to 100)
    const page = Math.max(parseInt(req.query.page) || 1, 1);
    const limit = Math.min(parseInt(req.query.limit) || 100, 100);

    // optional text search
    const q = req.query.q
      ? { $text: { $search: req.query.q } }
      : {};
    const hasSearch = Boolean(req.query.q);

    const [catalog, refs, total] = await Promise.all([
      getCollegeCardCatalog(),
      College.find(q, { _id: 1 })
        .sort({ rating: -1, createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      hasSearch ? College.countDocuments(q) : Promise.resolve(null),
    ]);

    const data = refs
      .map((doc) => catalog.byObjectId.get(String(doc?._id || ""))?.card)
      .filter(Boolean);

    res.json({
      success: true,
      page,
      limit,
      total: total ?? catalog.total,
      realtime: getCollegeRealtimeMeta(),
      data,
    });
  })
);


app.get("/api/colleges", asyncHandler(async (req, res) => {
 const isAll = req.query.all === "true";

const page = isAll ? 1 : Math.max(parseInt(req.query.page) || 1, 1);

const limit = isAll
  ? 1000
  : Math.min(parseInt(req.query.limit) || 20, 50);

  {
    const [catalog, refs] = await Promise.all([
      getCollegeCardCatalog(),
      College.find({}, { _id: 1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
    ]);

    const data = refs
      .map((doc) => catalog.byObjectId.get(String(doc?._id || ""))?.listing)
      .filter(Boolean);

    return res.json({
      success: true,
      page,
      limit,
      total: catalog.total,
      realtime: getCollegeRealtimeMeta(),
      data
    });
  }

  const colleges = await College.find({})
    .skip((page - 1) * limit)
    .limit(limit)
    .lean();

  const updateOps = [];
  const data = colleges.map(c => {

    const card = getCollegeCardData(c);
    const update = getCollegeBackfillPayload(c, card);

    if (update) {
      updateOps.push({
        updateOne: {
          filter: { _id: c._id },
          update
        }
      });
    }

    return {
      _id: c._id,
    
       id: card.id,              // 🔥 required
  name: card.name,          // 🔥 required
  location: card.location,  
  city: c?.basic?.city || null,
  state: c?.basic?.state || null,
      college_id: card.id,
   heroImage: card.heroImages?.[0] || null, 
      
      ranking: card.ranking,
      rating: card.rating,
      reviewCount: card.reviewCount,
      stream: card.stream,
      logoUrl: card.logoUrl,
      feesRange: card.feesRange,
      college_type: c?.basic?.college_type || c?.type || null,
       accreditation:
    c?.basic?.accreditation ||
    c?.accreditation ||
    c?.rawScraped?.accreditation || 
    null ,
    avg_fees: card.avg_fees 
   
      // Include any other fields you want to return in the API response
    };
  });

  if (updateOps.length) {
    await College.bulkWrite(updateOps, { ordered: false });
  }

  res.json({
    success: true,
    page,
    limit,
    total: await College.countDocuments(),
    realtime: getCollegeRealtimeMeta(),
    data
  });
}));
app.get("/api/colleges/list", asyncHandler(async (req, res) => {
  {
    const { list } = await getCollegeCardCatalog();
    return res.json({
      success: true,
      realtime: getCollegeRealtimeMeta(),
      data: list
    });
  }

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

// ================= COLLEGE COURSE CMS API (RAW, NO TRANSFORM) =================
app.get("/api/college-course", asyncHandler(async (req, res) => {
  const page = Math.max(parseInt(req.query.page) || 1, 1);
  const limit = Math.min(parseInt(req.query.limit) || 20, 100);
  const { source, college_id, slug_url } = req.query;
  const parsedCollegeId =
    college_id !== undefined && college_id !== null && college_id !== ""
      ? Number(college_id)
      : null;

  const query = {};
  if (source) query.source = source;
  if (parsedCollegeId !== null) {
    if (Number.isNaN(parsedCollegeId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid college_id",
      });
    }
    query.college_id = parsedCollegeId;
  }
  if (slug_url) {
    query.$or = [
      { "courses.slug_url": slug_url },
      { "courses.sub_courses.slug_url.value": slug_url },
    ];
  }

  let model = CollegeCourseCMS;
  let total = await CollegeCourseCMS.countDocuments(query);
  let docs = await CollegeCourseCMS.find(query)
    .sort({ updatedAt: -1, createdAt: -1 })
    .skip((page - 1) * limit)
    .limit(limit)
    .lean();

  // Fallback if collection is saved as "college course"
  if (!docs.length) {
    const altTotal = await CollegeCourseCMSSpace.countDocuments(query);
    const altDocs = await CollegeCourseCMSSpace.find(query)
      .sort({ updatedAt: -1, createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean();

    if (altDocs.length) {
      model = CollegeCourseCMSSpace;
      total = altTotal;
      docs = altDocs;
    }
  }

  const detectedCollegeId =
    parsedCollegeId !== null
      ? parsedCollegeId
      : (docs.length ? (Number(docs[0]?.college_id) || null) : null);

  res.json({
    success: true,
    collection: model.collection.name,
    college_id: detectedCollegeId,
    page,
    limit,
    total,
    data: docs,
  });
}));

app.get("/api/college-course/college/:college_id", asyncHandler(async (req, res) => {
  const collegeId = Number(req.params.college_id);
  if (Number.isNaN(collegeId)) {
    return res.status(400).json({
      success: false,
      message: "Invalid college_id",
    });
  }

  let docs = await CollegeCourseCMS.find({ college_id: collegeId })
    .sort({ updatedAt: -1, createdAt: -1 })
    .lean();
  let collectionName = CollegeCourseCMS.collection.name;

  if (!docs.length) {
    docs = await CollegeCourseCMSSpace.find({ college_id: collegeId })
      .sort({ updatedAt: -1, createdAt: -1 })
      .lean();
    collectionName = CollegeCourseCMSSpace.collection.name;
  }

  res.json({
    success: true,
    collection: collectionName,
    college_id: collegeId,
    total: docs.length,
    data: docs,
  });
}));

const saveCollegeCourseCmsByCollegeId = async (req, res) => {
  const collegeId = Number(req.params.college_id);
  if (Number.isNaN(collegeId)) {
    return res.status(400).json({
      success: false,
      message: "Invalid college_id",
    });
  }

  let model = CollegeCourseCMS;
  let total = await CollegeCourseCMS.countDocuments({ college_id: collegeId });

  if (!total) {
    model = CollegeCourseCMSSpace;
    total = await CollegeCourseCMSSpace.countDocuments({ college_id: collegeId });
  }

  if (!total) {
    return res.status(404).json({
      success: false,
      message: "College course documents not found",
    });
  }

  const updatePayload = {
    ...req.body,
    college_id: collegeId,
  };

  delete updatePayload._id;

  const result = await model.updateMany(
    { college_id: collegeId },
    { $set: updatePayload }
  );

  resetMainCourseCatalogCache();

  const docs = await model.find({ college_id: collegeId })
    .sort({ updatedAt: -1, createdAt: -1 })
    .lean();

  res.json({
    success: true,
    collection: model.collection.name,
    college_id: collegeId,
    matched: result.matchedCount ?? total,
    modified: result.modifiedCount ?? 0,
    total: docs.length,
    data: docs,
  });
};

app.put(
  "/api/college-course/college/:college_id",
  asyncHandler(saveCollegeCourseCmsByCollegeId)
);

app.patch(
  "/api/college-course/college/:college_id",
  asyncHandler(saveCollegeCourseCmsByCollegeId)
);

app.post(
  "/api/college-course/college/:college_id",
  asyncHandler(saveCollegeCourseCmsByCollegeId)
);

app.get("/api/college-course/:id", asyncHandler(async (req, res) => {
  const { id } = req.params;
  if (!mongoose.Types.ObjectId.isValid(id)) {
    return res.status(400).json({
      success: false,
      message: "Invalid document id",
    });
  }

  let doc = await CollegeCourseCMS.findById(id).lean();
  let collectionName = CollegeCourseCMS.collection.name;

  if (!doc) {
    doc = await CollegeCourseCMSSpace.findById(id).lean();
    collectionName = CollegeCourseCMSSpace.collection.name;
  }

  if (!doc) {
    return res.status(404).json({
      success: false,
      message: "Course document not found",
    });
  }

  res.json({
    success: true,
    collection: collectionName,
    data: doc,
  });
}));

// Read single
app.get("/api/colleges/:id", asyncHandler(async (req, res) => {
  const college = await College.findOne({ id: Number(req.params.id) }).lean();
  if (!college) return res.status(404).json({ success: false });

  res.json({
    success: true,
    data: buildCollegeDetailPayload(college),
  });
}));

const sendCollegeAdminDetail = async (req, res) => {
  const collegeId = Number(req.params.id);

  if (Number.isNaN(collegeId) || collegeId <= 0) {
    return res.status(400).json({
      success: false,
      message: "Invalid college id",
    });
  }

  const college = await College.findOne({ id: collegeId }).lean();
  if (!college) {
    return res.status(404).json({
      success: false,
      message: "College not found",
    });
  }

  const collegeDetail = buildCollegeDetailPayload(college);
  const mainCourseCards = await buildCollegeAdminMainCourseCards(
    collegeId,
    collegeDetail.name || college.name || ""
  );

  res.json({
    success: true,
    data: collegeDetail,
    total_main_course_cards: mainCourseCards.length,
    main_course_cards: mainCourseCards,
  });
};

app.get("/api/college-admin/:id", asyncHandler(sendCollegeAdminDetail));
app.get("/api/college-admin-api/:id", asyncHandler(sendCollegeAdminDetail));

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
    resetCollegeCardCatalogCache();

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
    resetCollegeCardCatalogCache();
    emit("college:deleted", { id: Number(req.params.id) });
    emitCollegeRealtimeChange("deleted", deleted, { source: "api" });
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

const MAIN_COURSE_CACHE_TTL_MS = 60 * 60 * 1000;
let mainCourseCatalogCache = {
  expiresAt: 0,
  value: null,
  promise: null,
};

let mainCourseCardsResponseCache = {
  expiresAt: 0,
  value: new Map(),
};

let mainCourseDetailCache = {
  expiresAt: 0,
  value: new Map(),
  pending: new Map(),
};

const resetMainCourseCatalogCache = () => {
  mainCourseCatalogCache = {
    expiresAt: 0,
    value: null,
    promise: null,
  };

  mainCourseCardsResponseCache = {
    expiresAt: 0,
    value: new Map(),
  };

  mainCourseDetailCache = {
    expiresAt: 0,
    value: new Map(),
    pending: new Map(),
  };
};

const MAIN_COURSE_SUMMARY_PROJECTION = {
  stream: 1,
  source_url: 1,
  final_url: 1,
  "course.course_name": 1,
  "course.name": 1,
  "course.mode": 1,
  "course.duration": 1,
  "course.level": 1,
  "course.slug_url": 1,
  "course_detail.url": 1,
  "course_detail.toc_sections": 1,
  "syllabus_detail.url": 1,
  course_name: 1,
  name: 1,
  mode: 1,
  duration: 1,
  fees: 1,
  collegeId: 1,
  college_id: 1,
  "details.heading": 1,
  title: 1,
  full_name: 1,
  slug: 1,
};

const MAIN_COURSE_DETAIL_PROJECTION = {
  stream: 1,
  source_url: 1,
  final_url: 1,
  course: 1,
  course_detail: 1,
  syllabus_detail: 1,
  course_name: 1,
  name: 1,
  mode: 1,
  duration: 1,
  fees: 1,
  collegeId: 1,
  college_id: 1,
  details: 1,
  title: 1,
  full_name: 1,
  slug: 1,
};

const MAIN_COURSE_CMS_SUMMARY_PROJECTION = {
  college_id: 1,
  url: 1,
  "courses.name": 1,
  "courses.course_name": 1,
  "courses.sub_course_name": 1,
  "courses.title": 1,
  "courses.heading": 1,
  "courses.specialization": 1,
  "courses.slug": 1,
  "courses.slug_url": 1,
  "courses.course_url": 1,
  "courses.url": 1,
  "courses.final_url": 1,
  "courses.mode": 1,
  "courses.study_mode": 1,
  "courses.duration": 1,
  "courses.avg_fees": 1,
  "courses.average_fees": 1,
  "courses.avgFees": 1,
  "courses.fees": 1,
  "courses.course_fees": 1,
  "courses.courseFees": 1,
  "courses.fee": 1,
  "courses.total_fees": 1,
  "courses.totalFees": 1,
  "courses.sub_courses.name": 1,
  "courses.sub_courses.course_name": 1,
  "courses.sub_courses.sub_course_name": 1,
  "courses.sub_courses.title": 1,
  "courses.sub_courses.heading": 1,
  "courses.sub_courses.specialization": 1,
  "courses.sub_courses.slug": 1,
  "courses.sub_courses.slug_url": 1,
  "courses.sub_courses.course_url": 1,
  "courses.sub_courses.url": 1,
  "courses.sub_courses.final_url": 1,
  "courses.sub_courses.mode": 1,
  "courses.sub_courses.study_mode": 1,
  "courses.sub_courses.duration": 1,
  "courses.sub_courses.avg_fees": 1,
  "courses.sub_courses.average_fees": 1,
  "courses.sub_courses.avgFees": 1,
  "courses.sub_courses.fees": 1,
  "courses.sub_courses.course_fees": 1,
  "courses.sub_courses.courseFees": 1,
  "courses.sub_courses.fee": 1,
  "courses.sub_courses.total_fees": 1,
  "courses.sub_courses.totalFees": 1,
};

const collectCourseMatchKeys = (node = {}, extraValues = []) => {
  const keys = new Set();

  [
    node?.slug,
    node?.slug_url,
    node?.url,
    node?.final_url,
    node?.course_name,
    node?.name,
    node?.title,
    node?.heading,
    ...extraValues,
  ].forEach((value) => addCourseMatchKey(keys, value));

  return keys;
};

const createCollegeCourseOffering = (doc, node, parentNode = null) => {
  const baseCourseName = pickFirstText(
    parentNode?.course_name,
    parentNode?.name,
    parentNode?.title
  );
  const nodeCourseName = pickFirstText(
    node?.course_name,
    node?.sub_course_name,
    node?.name,
    node?.title,
    node?.heading,
    node?.specialization
  );
  const baseCourseKey = toCourseMatchKey(baseCourseName);
  const nodeCourseKey = toCourseMatchKey(nodeCourseName);
  const courseName =
    parentNode &&
    nodeCourseName &&
    baseCourseName &&
    nodeCourseKey &&
    baseCourseKey &&
    !nodeCourseKey.includes(baseCourseKey)
      ? `${baseCourseName} (${nodeCourseName})`
      : nodeCourseName || baseCourseName;

  const slug = getPreferredCourseSlug(
    node?.slug_url,
    node?.course_url,
    node?.url,
    node?.final_url,
    courseName
  );

  const matchKeys = collectCourseMatchKeys(
    node,
    courseName && courseName !== nodeCourseName ? [courseName] : []
  );

  if (parentNode && !slug && !nodeCourseName && !matchKeys.size) {
    return null;
  }

  if (slug) matchKeys.add(toCourseMatchKey(slug));
  if (courseName) matchKeys.add(toCourseMatchKey(courseName));

  return {
    offeringKey: [
      getNumericId(doc?.college_id) || "na",
      slug || slugifyCourseText(courseName) || "unknown",
    ].join(":"),
    college_id: getNumericId(doc?.college_id),
    course_name: courseName || "",
    slug_url: slug || "",
    mode: pickFirstText(
      node?.mode,
      node?.study_mode,
      parentNode?.mode,
      parentNode?.study_mode
    ),
    duration: pickFirstText(node?.duration, parentNode?.duration),
    avg_fees: extractCourseFees(node, parentNode),
    source_url: pickFirstText(doc?.url),
    match_source: parentNode ? "sub_course" : "course",
    matchKeys: Array.from(matchKeys).filter(Boolean),
  };
};

const addOfferingToLookup = (lookup, offering) => {
  if (!offering || !Array.isArray(offering.matchKeys) || !offering.matchKeys.length) {
    return;
  }

  offering.matchKeys.forEach((key) => {
    if (!key) return;

    if (!lookup.has(key)) {
      lookup.set(key, new Map());
    }

    lookup.get(key).set(offering.offeringKey, offering);
  });
};

const buildCollegeCourseLookup = (docs = []) => {
  const lookup = new Map();

  docs.forEach((doc) => {
    const courses = Array.isArray(doc?.courses) ? doc.courses : [];

    courses.forEach((courseNode) => {
      addOfferingToLookup(lookup, createCollegeCourseOffering(doc, courseNode));

      toArrayValue(courseNode?.sub_courses).forEach((subCourseNode) => {
        addOfferingToLookup(
          lookup,
          createCollegeCourseOffering(doc, subCourseNode, courseNode)
        );
      });
    });
  });

  return lookup;
};

const mergeOfferingsForKeys = (lookup, keys = []) => {
  const merged = new Map();

  keys.forEach((key) => {
    const offerings = lookup.get(key);
    if (!offerings) return;

    offerings.forEach((offering, offeringKey) => {
      merged.set(offeringKey, offering);
    });
  });

  return Array.from(merged.values());
};

const summarizeOfferingsForKeys = (lookup, keys = []) => {
  const offeringKeys = new Set();
  const collegeIds = new Set();
  const feeValues = [];
  let mode = "";
  let duration = "";

  keys.forEach((key) => {
    const offerings = lookup.get(key);
    if (!offerings) return;

    offerings.forEach((offering, offeringKey) => {
      if (offeringKeys.has(offeringKey)) return;
      offeringKeys.add(offeringKey);

      if (offering.college_id) collegeIds.add(offering.college_id);
      if (Number.isFinite(offering.avg_fees)) {
        feeValues.push(offering.avg_fees);
      }
      if (!mode && offering.mode) mode = offering.mode;
      if (!duration && offering.duration) duration = offering.duration;
    });
  });

  return {
    collegeIds,
    feeValues,
    mode,
    duration,
  };
};

const extractMainCourseAboutParagraphs = (section) =>
  toArrayValue(section?.about)
    .map((item) => pickFirstText(item?.value, item))
    .filter(Boolean);

const extractMainCourseRecord = (doc = {}, options = {}) => {
  const { includeDetails = false } = options;
  const rawCourse = toPlainValue(doc?.course);
  const rawCourseDetail = toPlainValue(doc?.course_detail);
  const rawSyllabusDetail = toPlainValue(doc?.syllabus_detail);
  const courseNode =
    rawCourse && typeof rawCourse === "object" && !Array.isArray(rawCourse)
      ? rawCourse
      : {};
  const courseDetail =
    rawCourseDetail &&
    typeof rawCourseDetail === "object" &&
    !Array.isArray(rawCourseDetail)
      ? rawCourseDetail
      : {};
  const syllabusDetail =
    rawSyllabusDetail &&
    typeof rawSyllabusDetail === "object" &&
    !Array.isArray(rawSyllabusDetail)
      ? rawSyllabusDetail
      : {};

  const courseName = pickFirstText(
    courseNode?.course_name,
    doc?.course_name,
    doc?.name,
    courseNode?.name,
    doc?.title,
    doc?.full_name,
    doc?.details?.heading
  );

  const slug = getPreferredCourseSlug(
    doc?.final_url,
    courseDetail?.url,
    syllabusDetail?.url,
    doc?.source_url,
    doc?.slug,
    courseName
  );

  const matchKeys = new Set();
  [
    doc?.final_url,
    courseDetail?.url,
    syllabusDetail?.url,
    doc?.source_url,
    doc?.slug,
    courseNode?.slug_url,
    courseName,
  ].forEach((value) => addCourseMatchKey(matchKeys, value));

  if (slug) matchKeys.add(toCourseMatchKey(slug));

  const courseSummary = extractCourseSummaryFromFirstTocTable(courseDetail);

  const record = {
    id: String(doc?._id || ""),
    slug,
    matchKeys: Array.from(matchKeys).filter(Boolean),
    stream: pickFirstText(doc?.stream),
    source_url: pickFirstText(doc?.source_url),
    final_url: pickFirstText(
      doc?.final_url,
      courseDetail?.url,
      syllabusDetail?.url
    ),
    course_name: courseName || "",
    mode: pickFirstText(courseNode?.mode, doc?.mode),
    duration: pickFirstText(courseNode?.duration, doc?.duration),
    course_level: courseSummary.course_level || pickFirstText(courseNode?.level, doc?.level),
    avg_fees: courseSummary.avg_fees ?? extractCourseFees(doc, courseNode),
    college_id: getNumericId(doc?.collegeId, doc?.college_id),
  };

  if (includeDetails) {
    record.course = courseNode;
    record.course_detail = courseDetail;
    record.syllabus_detail = syllabusDetail;
    record.raw_doc = doc;
  }

  return record;
};

const buildMainCourseCatalog = (mainCourseDocs = [], lookup = new Map()) => {
  const groupedCourses = new Map();

  mainCourseDocs
    .map((doc) => extractMainCourseRecord(doc))
    .forEach((record) => {
      const canonicalKey =
        (record.slug && toCourseMatchKey(record.slug)) ||
        record.matchKeys[0] ||
        toCourseMatchKey(record.course_name);

      if (!canonicalKey) return;

      if (!groupedCourses.has(canonicalKey)) {
        groupedCourses.set(canonicalKey, {
          key: canonicalKey,
          slug: record.slug || cleanCourseSlug(record.course_name),
          matchKeys: new Set(record.matchKeys),
          recordIds: [],
          mainCourseCollegeIds: new Set(),
          fallbackFees: [],
          course_name: record.course_name,
          course_level: record.course_level,
          mode: record.mode,
          duration: record.duration,
          stream: record.stream,
          source_url: record.source_url,
          final_url: record.final_url,
        });
      }

      const group = groupedCourses.get(canonicalKey);

      record.matchKeys.forEach((key) => group.matchKeys.add(key));
      if (record.id) {
        group.recordIds.push(record.id);
      }

      if (record.college_id) group.mainCourseCollegeIds.add(record.college_id);
      if (record.avg_fees !== null) group.fallbackFees.push(record.avg_fees);
      if (!group.slug && record.slug) group.slug = record.slug;
      if (!group.course_name && record.course_name) group.course_name = record.course_name;
      if (!group.course_level && record.course_level) group.course_level = record.course_level;
      if (!group.mode && record.mode) group.mode = record.mode;
      if (!group.duration && record.duration) group.duration = record.duration;
      if (!group.stream && record.stream) group.stream = record.stream;
      if (!group.source_url && record.source_url) group.source_url = record.source_url;
      if (!group.final_url && record.final_url) group.final_url = record.final_url;
    });

  const cards = [];
  const groupsByKey = new Map();

  groupedCourses.forEach((group) => {
    const offeringSummary = summarizeOfferingsForKeys(
      lookup,
      Array.from(group.matchKeys)
    );

    const collegeIds = new Set(group.mainCourseCollegeIds);
    offeringSummary.collegeIds.forEach((collegeId) => collegeIds.add(collegeId));
    const collegeFeeValues = offeringSummary.feeValues;

    if (!group.mode && offeringSummary.mode) group.mode = offeringSummary.mode;
    if (!group.duration && offeringSummary.duration) {
      group.duration = offeringSummary.duration;
    }

    const totalCollegeCount = collegeIds.size;
    const avgFees =
      averageNumbers(group.fallbackFees) ??
      averageNumbers(collegeFeeValues);
    const slug = group.slug || cleanCourseSlug(group.course_name);
    const summary = {
      slug,
      name: group.course_name,
      course_name: group.course_name,
      course_level: group.course_level || "N/A",
      mode: group.mode || "N/A",
      duration: group.duration || "N/A",
      level: group.course_level || "N/A",
      avg_fees: avgFees,
      fees: avgFees,
      total_college_count: totalCollegeCount,
      totalColleges: totalCollegeCount,
      stream: group.stream || "",
      source_url: group.source_url || null,
      final_url: group.final_url || null,
      tier: getCourseTier(totalCollegeCount),
    };

    const detail = {
      ...summary,
      match_keys: Array.from(group.matchKeys),
      record_ids: Array.from(new Set(group.recordIds)),
    };

    cards.push(summary);

    group.matchKeys.forEach((key) => {
      if (!groupsByKey.has(key)) {
        groupsByKey.set(key, detail);
      }
    });

    if (slug) {
      groupsByKey.set(toCourseMatchKey(slug), detail);
    }
  });

  cards.sort((a, b) => {
    if (b.total_college_count !== a.total_college_count) {
      return b.total_college_count - a.total_college_count;
    }
    return (a.course_name || "").localeCompare(b.course_name || "");
  });

  const cardsByBucket = {
    all: cards,
    primary: cards.filter((card) => card.tier === "primary"),
    secondary: cards.filter((card) =>
      ["primary", "secondary"].includes(card.tier)
    ),
    longtail: cards.filter((card) => card.tier === "longtail"),
  };

  return { cards, cardsByBucket, groupsByKey };
};

const loadCollegeCourseCmsDocs = async (
  query = {},
  projection = MAIN_COURSE_CMS_SUMMARY_PROJECTION
) => {
  let docs = await CollegeCourseCMS.find(query, projection).lean();
  let collectionName = CollegeCourseCMS.collection.name;

  if (!docs.length) {
    docs = await CollegeCourseCMSSpace.find(query, projection).lean();
    collectionName = CollegeCourseCMSSpace.collection.name;
  }

  return { docs, collectionName };
};

const loadMainCourseDetailRecords = async (recordIds = []) => {
  const ids = Array.from(
    new Set(
      recordIds
        .map((recordId) => String(recordId || "").trim())
        .filter(Boolean)
    )
  );

  if (!ids.length) return [];

  const docs = await MainCourse.find(
    { _id: { $in: ids } },
    MAIN_COURSE_DETAIL_PROJECTION
  )
    .sort({ updatedAt: -1, createdAt: -1 })
    .lean();

  return docs.map((doc) => extractMainCourseRecord(doc, { includeDetails: true }));
};

const getMainCourseCatalog = async () => {
  if (
    mainCourseCatalogCache.value &&
    mainCourseCatalogCache.expiresAt > Date.now()
  ) {
    return mainCourseCatalogCache.value;
  }

  if (mainCourseCatalogCache.promise) {
    return mainCourseCatalogCache.promise;
  }

  mainCourseCatalogCache.promise = (async () => {
    const [mainCourseDocs, { docs: collegeCourseDocs, collectionName }] =
      await Promise.all([
        MainCourse.find({}, MAIN_COURSE_SUMMARY_PROJECTION).lean(),
        loadCollegeCourseCmsDocs(),
      ]);

    const lookup = buildCollegeCourseLookup(collegeCourseDocs);
    const catalog = buildMainCourseCatalog(mainCourseDocs, lookup);
    const value = {
      ...catalog,
      lookup,
      college_course_collection: collectionName,
    };

    mainCourseCatalogCache = {
      expiresAt: Date.now() + MAIN_COURSE_CACHE_TTL_MS,
      value,
      promise: null,
    };

    mainCourseDetailCache = {
      expiresAt: mainCourseCatalogCache.expiresAt,
      value: new Map(),
      pending: new Map(),
    };

    mainCourseCardsResponseCache = {
      expiresAt: mainCourseCatalogCache.expiresAt,
      value: new Map(),
    };

    return value;
  })();

  try {
    return await mainCourseCatalogCache.promise;
  } catch (error) {
    mainCourseCatalogCache.promise = null;
    throw error;
  }
};

const getMainCourseCardsResponseCacheKey = (
  routePath,
  bucket,
  stream,
  searchText
) => [routePath, bucket || "all", stream || "", searchText || ""].join("::");

const pickPrimaryMainCourseRecord = (records = []) => {
  if (!records.length) return null;

  return records.reduce((best, current) => {
    const bestScore =
      (Object.keys(best?.course_detail || {}).length ? 2 : 0) +
      (Object.keys(best?.syllabus_detail || {}).length ? 1 : 0) +
      (best?.course_name ? 1 : 0);
    const currentScore =
      (Object.keys(current?.course_detail || {}).length ? 2 : 0) +
      (Object.keys(current?.syllabus_detail || {}).length ? 1 : 0) +
      (current?.course_name ? 1 : 0);

    return currentScore > bestScore ? current : best;
  }, records[0]);
};

const enrichOfferingsWithCollegeData = async (offerings = []) => {
  const { byCollegeId } = await getCollegeCardCatalog();

  const allCollegesData = offerings
    .map((offering) => {
      const collegeId = Number(offering.college_id);
      const college = byCollegeId.get(collegeId);
      const rating = parseNumericValue(college?.card?.rating) ?? 0;

      return {
        name: offering.course_name || "",
        collegeId,
        collegeName: college?.card?.name || "",
        rating,
        fees: offering.avg_fees ?? "N/A",
        avg_fees: offering.avg_fees ?? null,
        duration: offering.duration || "N/A",
        mode: offering.mode || "N/A",
        slug_url: offering.slug_url || "",
        source_url: offering.source_url || "",
        details: {
          heading: offering.course_name || "",
        },
      };
    })
    .sort((a, b) => b.rating - a.rating);

  const uniqueCollegeCards = new Map();

  allCollegesData.forEach((row) => {
    if (uniqueCollegeCards.has(row.collegeId)) return;

    const college = byCollegeId.get(row.collegeId);
    uniqueCollegeCards.set(row.collegeId, {
      id: row.collegeId,
      name: college?.card?.name || row.collegeName || "",
      rating: row.rating,
      image: college?.card?.heroImage || null,
      logo: college?.card?.logoUrl || null,
      location: college?.card?.location || null,
    });
  });

  return {
    allCollegesData,
    collegesOffering: Array.from(uniqueCollegeCards.values()),
  };
};

const findMainCourseDetail = async (slug) => {
  const catalog = await getMainCourseCatalog();
  const matchKey = toCourseMatchKey(decodeURIComponent(slug || ""));
  const summary = catalog.groupsByKey.get(matchKey);

  if (!summary) return null;

  if (
    mainCourseDetailCache.expiresAt > Date.now() &&
    mainCourseDetailCache.value.has(matchKey)
  ) {
    return mainCourseDetailCache.value.get(matchKey);
  }

  if (mainCourseDetailCache.pending.has(matchKey)) {
    return mainCourseDetailCache.pending.get(matchKey);
  }

  const pending = (async () => {
    const records = await loadMainCourseDetailRecords(summary.record_ids);
    const detail = {
      ...summary,
      college_course_collection: catalog.college_course_collection,
      records,
      matched_offerings: mergeOfferingsForKeys(catalog.lookup, summary.match_keys),
      primaryRecord: pickPrimaryMainCourseRecord(records),
    };

    if (mainCourseDetailCache.expiresAt > Date.now()) {
      mainCourseDetailCache.value.set(matchKey, detail);
    }

    return detail;
  })();

  mainCourseDetailCache.pending.set(matchKey, pending);

  try {
    return await pending;
  } finally {
    mainCourseDetailCache.pending.delete(matchKey);
  }
};

const buildCmsControlledFieldValue = (value, existingField = null) => {
  if (value === undefined) return undefined;

  if (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.prototype.hasOwnProperty.call(value, "value")
  ) {
    return {
      value: value.value ?? null,
      cmsControl: value.cmsControl ?? existingField?.cmsControl ?? true,
      source: value.source || "manual",
      updatedAt: new Date(),
    };
  }

  return {
    value,
    cmsControl: existingField?.cmsControl ?? true,
    source: "manual",
    updatedAt: new Date(),
  };
};

const assignCmsControlledField = (target, key, value, existingField = null) => {
  const nextValue = buildCmsControlledFieldValue(value, existingField);
  if (nextValue !== undefined) {
    target[key] = nextValue;
  }
};

const extractOverviewParagraphs = (value) => {
  if (Array.isArray(value)) {
    return value
      .map((item) => pickFirstText(item?.value, item))
      .filter(Boolean);
  }

  const text = pickFirstText(value);
  if (!text) return [];

  return text
    .split(/\r?\n\s*\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean);
};

const extractMainCourseCmsDetails = (doc = {}) => {
  const rawDetails =
    doc?.details && typeof doc.details === "object" && !Array.isArray(doc.details)
      ? doc.details
      : {};
  const overviewParagraphs = extractOverviewParagraphs(
    toPlainValue(rawDetails.overview_paragraphs)
  );
  const overviewFullText =
    pickFirstText(rawDetails.overview_full_text) ||
    overviewParagraphs.join("\n\n");
  const normalizedOverviewParagraphs =
    overviewParagraphs.length
      ? overviewParagraphs
      : extractOverviewParagraphs(overviewFullText);

  return {
    heading: pickFirstText(rawDetails.heading),
    overview_full_text: overviewFullText,
    overview_paragraphs: normalizedOverviewParagraphs,
    highlights: toPlainValue(rawDetails.highlights) ?? {},
  };
};

const buildMainCourseUpdatePayload = (body = {}, existingDoc = {}) => {
  const courseInput =
    body?.course && typeof body.course === "object" && !Array.isArray(body.course)
      ? body.course
      : body;
  const detailsInput =
    courseInput?.details &&
    typeof courseInput.details === "object" &&
    !Array.isArray(courseInput.details)
      ? courseInput.details
      : body?.details &&
          typeof body.details === "object" &&
          !Array.isArray(body.details)
        ? body.details
        : {};
  const providedCourseDetail =
    body?.course_detail !== undefined
      ? body.course_detail
      : courseInput?.course_detail;
  const providedSyllabusDetail =
    body?.syllabus_detail !== undefined
      ? body.syllabus_detail
      : courseInput?.syllabus_detail;
  const providedCourseData =
    body?.course_data &&
    typeof body.course_data === "object" &&
    !Array.isArray(body.course_data)
      ? body.course_data
      : courseInput?.course_data &&
          typeof courseInput.course_data === "object" &&
          !Array.isArray(courseInput.course_data)
        ? courseInput.course_data
        : null;

  const updatePayload = {};
  const nextCourseName = courseInput.course_name ?? courseInput.name;
  const nextCollegeId = courseInput.collegeId ?? courseInput.college_id;
  const nextCollegeName = courseInput.collegeName ?? courseInput.college_name;
  const nextFees = courseInput.fees ?? courseInput.avg_fees;
  const nextLevel = courseInput.course_level ?? courseInput.level;

  assignCmsControlledField(updatePayload, "name", nextCourseName, existingDoc?.name);
  assignCmsControlledField(
    updatePayload,
    "collegeId",
    nextCollegeId,
    existingDoc?.collegeId
  );
  assignCmsControlledField(
    updatePayload,
    "collegeName",
    nextCollegeName,
    existingDoc?.collegeName
  );
  assignCmsControlledField(updatePayload, "rating", courseInput.rating, existingDoc?.rating);
  assignCmsControlledField(updatePayload, "fees", nextFees, existingDoc?.fees);
  assignCmsControlledField(
    updatePayload,
    "duration",
    courseInput.duration,
    existingDoc?.duration
  );
  assignCmsControlledField(
    updatePayload,
    "eligibility",
    courseInput.eligibility,
    existingDoc?.eligibility
  );
  assignCmsControlledField(updatePayload, "mode", courseInput.mode, existingDoc?.mode);
  assignCmsControlledField(
    updatePayload,
    "reviews",
    courseInput.reviews,
    existingDoc?.reviews
  );

  const hasDetailUpdates =
    nextCourseName !== undefined ||
    detailsInput.heading !== undefined ||
    detailsInput.overview_full_text !== undefined ||
    detailsInput.overview_paragraphs !== undefined ||
    detailsInput.highlights !== undefined;

  if (hasDetailUpdates) {
    const nextDetails =
      existingDoc?.details &&
      typeof existingDoc.details === "object" &&
      !Array.isArray(existingDoc.details)
        ? { ...existingDoc.details }
        : {};

    assignCmsControlledField(
      nextDetails,
      "heading",
      detailsInput.heading ?? nextCourseName,
      existingDoc?.details?.heading
    );
    assignCmsControlledField(
      nextDetails,
      "overview_full_text",
      detailsInput.overview_full_text,
      existingDoc?.details?.overview_full_text
    );
    assignCmsControlledField(
      nextDetails,
      "overview_paragraphs",
      detailsInput.overview_paragraphs ??
        (detailsInput.overview_full_text !== undefined
          ? extractOverviewParagraphs(detailsInput.overview_full_text)
          : undefined),
      existingDoc?.details?.overview_paragraphs
    );
    assignCmsControlledField(
      nextDetails,
      "highlights",
      detailsInput.highlights,
      existingDoc?.details?.highlights
    );

    if (Object.keys(nextDetails).length) {
      updatePayload.details = nextDetails;
    }
  }

  const nextCourseData =
    toPlainValue(existingDoc?.course) &&
    typeof toPlainValue(existingDoc.course) === "object" &&
    !Array.isArray(toPlainValue(existingDoc.course))
      ? { ...toPlainValue(existingDoc.course) }
      : {};
  let shouldPersistCourseData = false;

  if (providedCourseData) {
    Object.assign(nextCourseData, providedCourseData);
    shouldPersistCourseData = true;
  }

  if (nextCourseName !== undefined) {
    nextCourseData.course_name = nextCourseName;
    nextCourseData.name = nextCourseName;
    shouldPersistCourseData = true;
  }
  if (courseInput.duration !== undefined) {
    nextCourseData.duration = courseInput.duration;
    shouldPersistCourseData = true;
  }
  if (courseInput.mode !== undefined) {
    nextCourseData.mode = courseInput.mode;
    shouldPersistCourseData = true;
  }
  if (nextFees !== undefined) {
    nextCourseData.fees = nextFees;
    shouldPersistCourseData = true;
  }
  if (courseInput.eligibility !== undefined) {
    nextCourseData.eligibility = courseInput.eligibility;
    shouldPersistCourseData = true;
  }
  if (nextLevel !== undefined) {
    nextCourseData.level = nextLevel;
    shouldPersistCourseData = true;
  }
  if (courseInput.slug !== undefined) {
    nextCourseData.slug_url =
      cleanCourseSlug(courseInput.slug) || String(courseInput.slug).trim();
    shouldPersistCourseData = true;
  }

  if (shouldPersistCourseData) {
    updatePayload.course = nextCourseData;
  }

  if (providedCourseDetail !== undefined) {
    updatePayload.course_detail = providedCourseDetail;
  }

  if (providedSyllabusDetail !== undefined) {
    updatePayload.syllabus_detail = providedSyllabusDetail;
  }

  if (courseInput.stream !== undefined) {
    updatePayload.stream = courseInput.stream;
  }
  if (courseInput.source_url !== undefined) {
    updatePayload.source_url = courseInput.source_url;
  }
  if (courseInput.final_url !== undefined) {
    updatePayload.final_url = courseInput.final_url;
  }
  if (nextCourseName !== undefined) {
    updatePayload.course_name = nextCourseName;
  }
  if (courseInput.title !== undefined) {
    updatePayload.title = courseInput.title;
  }
  if (courseInput.full_name !== undefined) {
    updatePayload.full_name = courseInput.full_name;
  }
  if (courseInput.slug !== undefined) {
    updatePayload.slug =
      cleanCourseSlug(courseInput.slug) || String(courseInput.slug).trim();
  }

  return updatePayload;
};

const buildMainCourseDetailResponse = async (detail) => {
  const { allCollegesData, collegesOffering } =
    await enrichOfferingsWithCollegeData(detail.matched_offerings);

  const primaryRecord = detail.primaryRecord;
  const cmsDetails = extractMainCourseCmsDetails(primaryRecord?.raw_doc || {});
  const fallbackOverviewParagraphs = extractMainCourseAboutParagraphs(
    primaryRecord?.course_detail
  );
  const overviewParagraphs =
    cmsDetails.overview_paragraphs.length
      ? cmsDetails.overview_paragraphs
      : fallbackOverviewParagraphs;
  const avgRating = averageNumbers(
    allCollegesData.map((row) => parseNumericValue(row.rating))
  );

  return {
    collection: MainCourse.collection.name,
    college_course_collection: detail.college_course_collection,
    course: {
      slug: detail.slug,
      name: detail.course_name,
      course_name: detail.course_name,
      course_level: detail.course_level,
      level: detail.course_level,
      mode: detail.mode,
      duration: detail.duration,
      fees: detail.avg_fees,
      avg_fees: detail.avg_fees,
      totalColleges: detail.total_college_count,
      total_college_count: detail.total_college_count,
      avgRating: avgRating !== null ? avgRating.toFixed(1) : null,
      stream: detail.stream,
      source_url: detail.source_url,
      final_url: detail.final_url,
      details: {
        heading: cmsDetails.heading || detail.course_name,
        overview_full_text:
          cmsDetails.overview_full_text || overviewParagraphs.join("\n\n"),
        overview_paragraphs: overviewParagraphs,
        highlights: cmsDetails.highlights,
        course_detail: primaryRecord?.course_detail || null,
        syllabus_detail: primaryRecord?.syllabus_detail || null,
      },
      course_data: primaryRecord?.course || null,
      course_detail: primaryRecord?.course_detail || null,
      syllabus_detail: primaryRecord?.syllabus_detail || null,
    },
    allCollegesData,
    collegesOffering,
  };
};

const loadCollegeMainCourseRecords = async (collegeId) => {
  if (!Number.isFinite(collegeId) || collegeId <= 0) {
    return [];
  }

  const collegeIdVariants = Array.from(
    new Set([collegeId, String(collegeId)])
  );

  const docs = await MainCourse.find(
    {
      $or: [
        { "collegeId.value": { $in: collegeIdVariants } },
        { "college_id.value": { $in: collegeIdVariants } },
        { college_id: { $in: collegeIdVariants } },
      ],
    },
    MAIN_COURSE_SUMMARY_PROJECTION
  ).lean();

  return docs.map((doc) => extractMainCourseRecord(doc));
};

const buildCollegeAdminCourseFeeRows = (
  collegeId,
  collegeName,
  detail,
  records = []
) => {
  const matchedOfferings = detail.matched_offerings.filter(
    (offering) => Number(offering.college_id) === collegeId
  );

  const rows = (matchedOfferings.length ? matchedOfferings : records).map(
    (item) => ({
      name: item.course_name || detail.course_name || "",
      collegeId,
      collegeName: collegeName || "",
      fees: item.avg_fees ?? "N/A",
      avg_fees: item.avg_fees ?? null,
      duration: item.duration || detail.duration || "N/A",
      mode: item.mode || detail.mode || "N/A",
      slug_url: item.slug_url || item.slug || detail.slug || "",
      source_url: item.source_url || detail.source_url || "",
    })
  );

  const uniqueRows = new Map();
  rows.forEach((row) => {
    const rowKey = [
      row.name,
      row.avg_fees ?? "na",
      row.duration,
      row.mode,
      row.slug_url,
    ].join("|");

    if (!uniqueRows.has(rowKey)) {
      uniqueRows.set(rowKey, row);
    }
  });

  return Array.from(uniqueRows.values()).sort((a, b) =>
    String(a.name || "").localeCompare(String(b.name || ""))
  );
};

const buildCollegeAdminMainCourseCards = async (collegeId, collegeName = "") => {
  const records = await loadCollegeMainCourseRecords(collegeId);
  const groupedRecords = new Map();

  records.forEach((record) => {
    const slug = record.slug || cleanCourseSlug(record.course_name);
    if (!slug) return;

    if (!groupedRecords.has(slug)) {
      groupedRecords.set(slug, []);
    }

    groupedRecords.get(slug).push(record);
  });

  const cards = await Promise.all(
    Array.from(groupedRecords.entries()).map(async ([slug, courseRecords]) => {
      const detail = await findMainCourseDetail(slug);
      if (!detail) return null;

      return {
        slug: detail.slug,
        course_name: detail.course_name,
        college_course_fees: buildCollegeAdminCourseFeeRows(
          collegeId,
          collegeName,
          detail,
          courseRecords
        ),
        main_course_card: {
          success: true,
          ...(await buildMainCourseDetailResponse(detail)),
        },
      };
    })
  );

  return cards
    .filter(Boolean)
    .sort((a, b) =>
      String(a.course_name || "").localeCompare(String(b.course_name || ""))
    );
};

const sendMainCourseCards = async (req, res, next) => {
  const bucket = String(req.query.bucket || "all").trim().toLowerCase();
  const page = 1;
  const limit = Infinity;
  const searchText = String(req.query.search || req.query.q || "")
    .trim()
    .toLowerCase();
  const stream = String(req.query.stream || "").trim().toLowerCase();
  const cacheKey = getMainCourseCardsResponseCacheKey(
    req.path,
    bucket,
    stream,
    searchText
  );

  if (
    mainCourseCardsResponseCache.expiresAt > Date.now() &&
    mainCourseCardsResponseCache.value.has(cacheKey)
  ) {
    res.type("application/json");
    return res.send(mainCourseCardsResponseCache.value.get(cacheKey));
  }

  const { cards, cardsByBucket, college_course_collection } =
    await getMainCourseCatalog();

  let filtered = cardsByBucket?.[bucket] || cards;

  if (stream) {
    filtered = filtered.filter(
      (card) => String(card.stream || "").toLowerCase() === stream
    );
  }

  if (searchText) {
    const searchSlug = cleanCourseSlug(searchText);
    filtered = filtered.filter((card) => {
      const courseName = String(card.course_name || "").toLowerCase();
      return (
        courseName.includes(searchText) ||
        String(card.slug || "").includes(searchSlug)
      );
    });
  }

  const total = filtered.length;
  if (!total && req.path === "/api/courses/cards") {
    return next();
  }

  const data = filtered;
  const payload = {
    success: true,
    bucket,
    page,
    limit,
    total,
    collection: MainCourse.collection.name,
    college_course_collection,
    data,
  };
  const serializedPayload = JSON.stringify(payload);

  if (mainCourseCardsResponseCache.expiresAt > Date.now()) {
    mainCourseCardsResponseCache.value.set(cacheKey, serializedPayload);
  }

  res.type("application/json");
  return res.send(serializedPayload);
};

const sendMainCourseDetail = async (req, res, next) => {
  const detail = await findMainCourseDetail(req.params.slug);

  if (!detail) {
    if (req.path.startsWith("/api/course/")) {
      return next();
    }

    return res.status(404).json({
      success: false,
      message: "Course not found",
    });
  }

  res.json({
    success: true,
    ...(await buildMainCourseDetailResponse(detail)),
  });
};

const updateMainCourseDetail = async (req, res) => {
  const detail = await findMainCourseDetail(req.params.slug);

  if (!detail?.primaryRecord?.id) {
    return res.status(404).json({
      success: false,
      message: "Course not found",
    });
  }

  const updatePayload = buildMainCourseUpdatePayload(
    req.body,
    detail.primaryRecord.raw_doc || {}
  );

  if (!Object.keys(updatePayload).length) {
    return res.status(400).json({
      success: false,
      message: "No valid fields provided for update",
    });
  }

  const updated = await MainCourse.findByIdAndUpdate(
    detail.primaryRecord.id,
    { $set: updatePayload },
    {
      new: true,
      runValidators: true,
      strict: false,
    }
  );

  if (!updated) {
    return res.status(404).json({
      success: false,
      message: "Course record not found",
    });
  }

  resetMainCourseCatalogCache();

  const requestedSlug =
    cleanCourseSlug(req.body?.course?.slug || req.body?.slug || "") ||
    req.params.slug;
  const refreshedDetail =
    (await findMainCourseDetail(requestedSlug)) ||
    (await findMainCourseDetail(req.params.slug));

  if (!refreshedDetail) {
    return res.json({
      success: true,
      message: "Main course updated successfully",
      record_id: String(updated._id),
    });
  }

  res.json({
    success: true,
    message: "Main course updated successfully",
    ...(await buildMainCourseDetailResponse(refreshedDetail)),
  });
};

const sendMainCourseColleges = async (req, res, next) => {
  const detail = await findMainCourseDetail(req.params.slug);

  if (!detail) {
    if (req.path.startsWith("/api/course/")) {
      return next();
    }

    return res.status(404).json({
      success: false,
      message: "Course not found",
    });
  }

  const { allCollegesData, collegesOffering } =
    await enrichOfferingsWithCollegeData(detail.matched_offerings);

  res.json({
    success: true,
    course_name: detail.course_name,
    slug: detail.slug,
    total: collegesOffering.length,
    colleges: collegesOffering,
    allCollegesData,
  });
};

app.get("/api/main-course-card", asyncHandler(sendMainCourseCards));
app.get("/api/courses/cards", asyncHandler(sendMainCourseCards));
app.get("/api/main-course-card/:slug", asyncHandler(sendMainCourseDetail));
app.put("/api/main-course-card/:slug", asyncHandler(updateMainCourseDetail));
app.get("/api/main-course/:slug", asyncHandler(sendMainCourseDetail));
app.get("/api/course/:slug", asyncHandler(sendMainCourseDetail));
app.get("/api/main-course-card/:slug/colleges", asyncHandler(sendMainCourseColleges));
app.get("/api/main-course/:slug/colleges", asyncHandler(sendMainCourseColleges));
app.get("/api/course/:slug/colleges", asyncHandler(sendMainCourseColleges));



app.get("/api/course/:slug", asyncHandler(async (req, res) => {
  const slug = req.params.slug;
  const exactName = req.query.name?.trim();

  if (!slug) return res.status(400).json({ success: false });

  const normalizedSlug = normalizeCourse(slug.replace(/-/g, " "));
  const normalizedExactName = exactName
    ? normalizeCourse(exactName)
    : null;

  const colleges = await College.find(
    { "rawScraped.courses": { $exists: true } },
    { id: 1, name: 1, rating: 1, heroImages: 1, rawScraped: 1 }
  ).lean();

  let courseRows = [];
  let uniqueCollegesMap = new Map();

  colleges.forEach(college => {
    (college.rawScraped?.courses || []).forEach(course => {
      const courseKey = normalizeCourse(course.name);

      let isMatch = false;

      // ✅ EXACT VARIANT MATCH
      if (normalizedExactName) {
        isMatch = courseKey === normalizedExactName;
      }
      // ✅ FAMILY MATCH
      else {
        isMatch =
          courseKey === normalizedSlug ||
          courseKey.includes(normalizedSlug);
      }

      if (!isMatch) return;

      courseRows.push({
        name: course.name,
        collegeId: college.id,
        collegeName: college.name,
        rating: Number(course.rating) || Number(college.rating) || 4,
        fees: course.fees || "N/A",
        duration: course.duration || "N/A",
        eligibility: course.eligibility || "N/A",
        mode: course.mode || "N/A",
        reviews: parseInt(course.reviews) || 0,
        details: {
          heading: course.details?.heading || `${college.name} ${course.name}`,
          overview_full_text:
            course.details?.overview_full_text || "",
          overview_paragraphs:
            course.details?.overview_paragraphs || [],
          highlights: course.details?.highlights || {}
        },
        collegeRaw: {
          admission: college.rawScraped?.admission || []
        }
      });

      if (!uniqueCollegesMap.has(college.id.toString())) {
        uniqueCollegesMap.set(college.id.toString(), {
          id: college.id,
          name: college.name,
          rating: college.rating,
          image: college.heroImages?.[0] || null,
          logo: college.rawScraped?.logo || null
        });
      }
    });
  });

  if (!courseRows.length)
    return res.status(404).json({ success: false });

  const bestMatch = courseRows.reduce((a, b) =>
    a.details.overview_full_text.length >
    b.details.overview_full_text.length
      ? a
      : b
  );

  res.json({
    success: true,
    course: {
      ...bestMatch,
      totalColleges: uniqueCollegesMap.size,
      avgRating: (
        courseRows.reduce((s, c) => s + c.rating, 0) /
        courseRows.length
      ).toFixed(1)
    },
    allCollegesData: courseRows,
    collegesOffering: Array.from(uniqueCollegesMap.values())
  });
}));




// ✅ IMPROVED NORMALIZER: Integrated courses ko alag identify karne ke liye




app.get("/api/course/:slug/colleges", asyncHandler(async (req, res) => {
  const slug = decodeURIComponent(req.params.slug)
    .toLowerCase()
    .replace(/-/g, " ")
    .trim();

  const regex = new RegExp(slug.split(" ").join(".*"), "i");

  const colleges = await College.find(
    { "rawScraped.courses.name": regex },
    {
      id: 1,
      name: 1,
      rating: 1,
      heroImages: 1
    }
  )
    .sort({ rating: -1 })
    .limit(20)
    .lean();

  res.json({
    success: true,
    total: colleges.length,
    colleges
  });
}));




app.get("/api/courses/cards", asyncHandler(async (req, res) => {
  const bucket = req.query.bucket || "primary";

  const courses = await College.aggregate([
    /* 1️⃣ GET COURSES SAFELY */
    {
      $project: {
        courses: { $ifNull: ["$rawScraped.courses", []] }
      }
    },
    { $unwind: "$courses" },

    /* 2️⃣ NORMALIZE NAME */
    {
      $addFields: {
        rawName: "$courses.name",
        cleanName: {
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

    /* 3️⃣ DEGREE = FIRST TOKEN (DATA DRIVEN) */
    {
      $addFields: {
        degree: {
          $arrayElemAt: [{ $split: ["$cleanName", " "] }, 0]
        }
      }
    },

    /* 4️⃣ SPECIALIZATION (BRACKET > REST) */
    {
      $addFields: {
        specialization: {
          $cond: [
            { $regexMatch: { input: "$rawName", regex: /\(/ } },
            {
              $toLower: {
                $trim: {
                  input: {
                    $arrayElemAt: [
                      { $split: ["$rawName", "("] },
                      1
                    ]
                  }
                }
              }
            },
            {
              $trim: {
                input: {
                  $substrBytes: [
                    "$cleanName",
                    { $add: [{ $strLenBytes: "$degree" }, 1] },
                    100
                  ]
                }
              }
            }
          ]
        }
      }
    },

    /* 5️⃣ GROUP (NO RANDOM FIRST) */
    {
      $group: {
        _id: {
          degree: "$degree",
          specialization: "$specialization"
        },
        names: { $addToSet: "$courses.name" },
        duration: { $first: "$courses.duration" },
        level: { $first: "$courses.mode" },
        fees: { $avg: "$courses.feesRange" },
        colleges: { $addToSet: "$_id" }
      }
    },

    /* 6️⃣ PICK BEST NAME (NON-WORKING FIRST) */
    {
      $addFields: {
        name: {
          $ifNull: [
            {
              $first: {
                $filter: {
                  input: "$names",
                  as: "n",
                  cond: {
                    $not: {
                      $regexMatch: {
                        input: "$$n",
                        regex: /working|executive|part time|online/i
                      }
                    }
                  }
                }
              }
            },
            { $first: "$names" } // fallback
          ]
        }
      }
    },

    /* 7️⃣ TOTAL COLLEGES */
    {
      $addFields: {
        totalColleges: { $size: "$colleges" }
      }
    },

    /* 8️⃣ AUTO TIER */
    {
      $addFields: {
        tier: {
          $cond: [
            { $gte: ["$totalColleges", 5] },
            "primary",
            {
              $cond: [
                { $gte: ["$totalColleges", 2] },
                "secondary",
                "longtail"
              ]
            }
          ]
        }
      }
    },

    /* 9️⃣ BUCKET FILTER */
    ...(bucket === "primary"
      ? [{ $match: { tier: "primary" } }]
      : bucket === "secondary"
      ? [{ $match: { tier: { $in: ["primary", "secondary"] } } }]
      : []),

    /* 🔟 FINAL SORT */
    { $sort: { totalColleges: -1, name: 1 } },
    { $limit: 500 }
  ]);

  res.json({
    success: true,
    bucket,
    total: courses.length,
    data: courses
  });
}));







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

// ================= BLOG IMAGE UPLOAD =================


// --- Blogs ---
app.post(
  "/api/blogs",
  asyncHandler(async (req, res) => {
    const blog = await Blog.create({
      id: generateId(),   // ✅ backend id
      title: req.body.title,
      author: req.body.author,
      date: req.body.date,
      category: req.body.category,
      imageUrl: req.body.imageUrl,
      excerpt: req.body.excerpt,
      content: req.body.content,
     //  htmlContent: req.body.htmlContent,
    });

    res.status(201).json({
      success: true,
      data: blog,
    });
  })
);


app.get(
  "/api/blogs",
  asyncHandler(async (req, res) => {
    const data = await Blog.find().lean();
    res.json({ success: true, data });
  })
);

app.get("/api/blogs/:id", asyncHandler(async (req, res) => {
  const blogId = Number(req.params.id);

  if (isNaN(blogId)) {
    return res.status(400).json({
      success: false,
      message: "Invalid blog id"
    });
  }

  const blog = await Blog.findOne({ id: blogId }).lean();

  if (!blog) {
    return res.status(404).json({
      success: false,
      message: "Blog not found"
    });
  }

  res.json({ success: true, data: blog });
}));


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

    resetCollegeCardCatalogCache();
    emit("college:updated", updated);
    emitCollegeRealtimeChange("updated", updated, { source: "api" });

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
    const blog = await Blog.findOne({ id: Number(req.params.id) });

    if (!blog) return sendError(res, "Blog not found", 404);

    // 🔥 DELETE CLOUDINARY IMAGES
    if (blog.content?.blocks?.length) {
      for (const block of blog.content.blocks) {
        if (block.type === "image") {
          const publicId = block.data?.file?.public_id;
          if (publicId) {
            await cloudinary.uploader.destroy(publicId);
          }
        }
      }
    }

    await Blog.deleteOne({ id: blog.id });

    emit("blog:deleted", { id: blog.id });

    res.json({
      success: true,
      message: "Blog + images deleted successfully",
    });
  })
);
app.put(
  "/api/blogs/:id",
  asyncHandler(async (req, res) => {
    const updated = await Blog.findOneAndUpdate(
      { id: Number(req.params.id) },
      {
        title: req.body.title,
        author: req.body.author,
        category: req.body.category,
        imageUrl: req.body.imageUrl,
        excerpt: req.body.excerpt,
        content: req.body.content,
      },
      { new: true }
    );

    if (!updated) return sendError(res, "Blog not found", 404);

    emit("blog:updated", updated);

    res.json({ success: true, data: updated });
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
      status: data.status,
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
    resetCollegeCardCatalogCache();

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
    return res.status(400).json({ success: false, error: "URL is required" });
  }

  const tempCollection = tempConn.collection("college_course_test");

  // 1️⃣ create job
  const job = await tempCollection.insertOne({
    sourceUrl: url,
    status: "queued",
    progress: 0,
    createdAt: new Date()
  });

  // 2️⃣ trigger python (fire & forget)
  fetch(`${process.env.PYTHON_SCRAPER_URL}/scrape`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      url,
      jobId: job.insertedId.toString()
    })
  }).catch(err => {
    console.error("Python trigger failed:", err.message);
  });

  // 3️⃣ return immediately
  res.json({
    success: true,
    tempId: job.insertedId.toString()
  });
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


app.get("/api/news", async (req, res) => {

  try {

    const feeds = [
      "https://feeds.bbci.co.uk/news/education/rss.xml",
      "https://timesofindia.indiatimes.com/rssfeeds/913168846.cms",
      "https://www.thehindu.com/education/feeder/default.rss"
    ];

    let allArticles = [];

    for (const url of feeds) {

      try {

        const feed = await parser.parseURL(url);

        feed.items.forEach(item => {

          allArticles.push({
            title: item.title || "",
            link: item.link || "",
            description:
              item.contentSnippet ||
              item.content ||
              item.summary ||
              "No description available",
            pubDate: item.pubDate || item.isoDate || "",
            image:
              item.enclosure?.url ||
              item["media:content"]?.url ||
              null,
            source: feed.title || "Unknown"
          });

        });

      } catch (err) {

        console.log("RSS failed:", url);

      }

    }

    // 🔹 Sort latest news first
    allArticles.sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate));

    // 🔹 Optional limit (latest 30 news)
    const latestNews = allArticles.slice(0, 30);

    res.json({
      status: "ok",
      total: latestNews.length,
      articles: latestNews
    });

  } catch (error) {

    console.error(error);

    res.status(500).json({
      status: "error",
      message: "Failed to fetch news"
    });

  }

});

app.get("/api/news/detail", async (req, res) => {
  try {

    const url = req.query.url;

    if (!url) {
      return res.status(400).json({
        error: "Article URL required"
      });
    }

    const response = await axios.get(url);
    const $ = cheerio.load(response.data);

    const title = $("h1").first().text().trim();

    const image =
      $('meta[property="og:image"]').attr("content") || null;

    let paragraphs = [];

    // 🔹 The Hindu
    if (url.includes("thehindu.com")) {

      $('div[itemprop="articleBody"] p').each((i, el) => {
        const text = $(el).text().trim();
        if (text.length > 40) paragraphs.push(text);
      });

    }

    // 🔹 BBC
    else if (url.includes("bbc.com")) {

      $(".ssrcss-uf6wea-RichTextComponentWrapper p").each((i, el) => {
        const text = $(el).text().trim();
        if (text.length > 40) paragraphs.push(text);
      });

    }

    // 🔹 Times of India
    else if (url.includes("indiatimes.com")) {

      $(".Normal p").each((i, el) => {
        const text = $(el).text().trim();
        if (text.length > 40) paragraphs.push(text);
      });

    }

    const content = paragraphs.join("\n\n");

    res.json({
      status: "ok",
      title,
      image,
      article_url: url,
      content
    });

  } catch (error) {

    console.error(error);

    res.status(500).json({
      error: "Failed to fetch article detail"
    });

  }
});

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

app.use("/api", (req, res) => {
  res.status(404).json({
    success: false,
    message: `API route not found: ${req.method} ${req.originalUrl}`,
  });
}); 



app.use((err, req, res, next) => {
  console.error("Unhandled Error:", err);
  sendError(res, err.message || "Server Error", 500);
});







// -------------------- START SERVER --------------------
const PORT = process.env.PORT || 5000;  




//------PORT LISTENING------//
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));



