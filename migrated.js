import mongoose from "mongoose";
import dotenv from "dotenv";
dotenv.config();

/* CONNECT DB */
await mongoose.connect(process.env.MONGO_URI);

/* SCRAPED COLLECTION */
const ScrapedCollege = mongoose.connection
  .useDb("studycups")
  .model(
    "college_course_test",
    new mongoose.Schema({}, { strict: false }),
    "college_course_test"
  );

/* LIVE COLLECTION */
const LiveCollege = mongoose.connection
  .useDb("studentcap")
  .model(
    "colleges",
    new mongoose.Schema({}, { strict: false }),
    "colleges"
  );

/* UNIQUE ID */
function generateId() {
  return Number(Date.now() + "" + Math.floor(Math.random() * 9999));
}

/* REMOVE _id IN DEPTH */
function removeMongoIds(obj) {
  if (Array.isArray(obj)) {
    obj.forEach(removeMongoIds);
  } else if (obj && typeof obj === "object") {
    delete obj._id;
    for (let k of Object.keys(obj)) {
      removeMongoIds(obj[k]);
    }
  }
}

async function startMigration() {

  const scraped = await ScrapedCollege.find().lean();
  console.log("SCRAPED RECORDS:", scraped.length);

  for (let s of scraped) {

    try {

      const collegeName =
        (s.full_name?.split(":")[0] ||
         s.college_name?.split(":")[0] ||
         "")
        .replace(/Fees.*|Admission.*|Courses.*|Cutoff.*/gi, "")
        .trim();

      const doc = {
        id: generateId(),

        /* CORE IDENTIFICATION */
        name: collegeName,
        full_name: s.full_name || s.college_name || "",
        location: s.location || "",
        established: s.estd_year ? Number(s.estd_year) : null,
        type: s.college_type || "",

        /* RATINGS */
        rating: s.rating ? Number(s.rating) : null,
        reviewCount: s.review_count
          ? Number(String(s.review_count).replace(/\D/g, ""))
          : 0,

        /* CONTENT */
        description: s.about_text || "",
        highlights: s.about_list || [],

        /* MEDIA */
        gallery: Array.isArray(s.gallery)
          ? s.gallery.map(g => g.image || g)
          : [],

        heroImages: [],
        heroDownloaded: false,

        /* 🔐 FULL RAW BACKUP (NO DATA LOSS) */
        rawScraped: {
          ...s
        }
      };

      removeMongoIds(doc.rawScraped);

      await LiveCollege.updateOne(
        { name: doc.name, location: doc.location },
        { $set: doc },
        { upsert: true }
      );

      console.log("MIGRATED:", doc.name);

    } catch (err) {
      console.log("ERROR:", s.college_name, err.message);
    }
  }

  console.log("MIGRATION COMPLETED");
  process.exit(0);
}

startMigration();
