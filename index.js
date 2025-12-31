
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


const app = express();
app.use(express.json()); 

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



const CourseSchema = new mongoose.Schema(
  {
    id: Number,
    name: String,
    duration: String,
    level: String,
    fees: Number,
    eligibility: String,
    about: String,
    programType: String,
    intake: String,
    longEligibility: String,
    admissionProcess: [{ step: Number, title: String, description: String }],
    highlights: [String],
    skills: [String],
    structure: [{ year: String, topics: [String] }],
    statistics: {
      studentsEnrolled: String,
      placementRate: String,
      recruiters: String,
      ranking: String,
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

const CollegeSchema = new mongoose.Schema(
  {
    id: { type: Number, index: true, unique: true },

    name: String,
    location: String,
    established: Number,
    type: String,
    stream: String,
    rating: Number,
    reviewCount: Number,
    description: String,
    highlights: [String],
    gallery: [String],
    courses: [CourseSchema],
    heroImages: [String],
    heroDownloaded: { type: Boolean, default: false },

    // VERY IMPORTANT FIELD:
    rawScraped: {
      type: Object,
      default: {},
    },

  },
  { timestamps: true }
);


CollegeSchema.index({ name: "text", location: 1 });

const College = mongoose.model("college", CollegeSchema);


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

const Exam = mongoose.model("exam", ExamSchema);


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
const Event = mongoose.model("event", EventSchema);


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
const Testimonial = mongoose.model("testimonial", TestimonialSchema);

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
const Blog = mongoose.model("blog", BlogSchema);


const RegistrationSchema = new mongoose.Schema(
  {
    id: Number,
    name: String,
    email: String,
    phone: String,
    course: String,
  },
  { timestamps: true }
);

const Registration = mongoose.model("registration", RegistrationSchema);



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

const Contact = mongoose.model("contact", ContactSchema);



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




// Read single
app.get(
  "/api/colleges/:id",
  asyncHandler(async (req, res) => {
    const college = await College.findOne({ id: Number(req.params.id) });
    if (!college) return sendError(res, "College not found", 404);
    res.json({ success: true, data: college });
  })
);

// Update
app.put(
  "/api/colleges/:id",
  asyncHandler(async (req, res) => {
    if (req.body.courses && Array.isArray(req.body.courses)) {
      req.body.courses = req.body.courses.map((c) => ({ ...c, id: c.id || generateId() }));
    }
    const updated = await College.findOneAndUpdate({ id: Number(req.params.id) }, req.body, { new: true });
    if (!updated) return sendError(res, "College not found", 404);
    emit("college:updated", updated);
    res.json({ success: true, data: updated });
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


// --- Exams ---
app.post(
  "/api/exams",
  asyncHandler(async (req, res) => {
    const exam = await Exam.create({ ...req.body, id: generateId() });
    emit("exam:created", exam);
    res.status(201).json({ success: true, data: exam });
  })
);

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
  "/api/blogs/:id",
  asyncHandler(async (req, res) => {
    const updated = await Blog.findOneAndUpdate({ id: Number(req.params.id) }, req.body, { new: true });
    if (!updated) return sendError(res, "Blog not found", 404);
    emit("blog:updated", updated);
    res.json({ success: true, data: updated });
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





// -------------------- START SERVER --------------------
const PORT = process.env.PORT || 5000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
