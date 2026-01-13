import mongoose from "mongoose";
import axios from "axios";
import fs from "fs";
import dotenv from "dotenv";
import { v2 as cloudinary } from "cloudinary";
import { ObjectId } from "mongodb";


dotenv.config();

/* ================= CLOUDINARY ================= */
cloudinary.config({
  cloud_name: process.env.CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

/* ================= HELPERS ================= */

function cleanCollegeName(fullName = "") {
  return fullName
    .split(":")[0]
    .replace(/fees|admission|ranking|cutoff|placement|courses/gi, "")
    .replace(/202\d/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

async function downloadImg(url) {
  const file = `temp_${Date.now()}.jpg`;
  const writer = fs.createWriteStream(file);

  const resp = await axios({
    url,
    method: "GET",
    responseType: "stream",
    timeout: 15000
  });

  resp.data.pipe(writer);
  await new Promise(r => writer.on("finish", r));

  return file;
}

async function getGoogleCampusImages(name) {
  try {
    const { data } = await axios.get(
      "https://www.googleapis.com/customsearch/v1",
      {
        params: {
          q: `${name} campus India`,
          searchType: "image",
          imgType: "photo",
          num: 3,
          cx: process.env.GOOGLE_CX,
          key: process.env.GOOGLE_KEY
        }
      }
    );

    if (!data.items) return [];
    return data.items.map(i => i.link).slice(0, 2);
  } catch {
    return [];
  }
}

/* ================= MAIN ================= */

async function run() {
  const tempId = process.argv[2];
  console.log("🆔 tempId received:", tempId);
if (!tempId) {
  console.log("❌ tempId missing");
  process.exit(1);
}

const _id = new ObjectId(tempId);
console.log("🆔 Converted ObjectId:", _id.toString());


  // ✅ CONNECT FIRST
  await mongoose.connect(process.env.MONGO_URI);

  // ⬇️ ADD THIS (database force select)
const db = mongoose.connection.client.db("studycups");
console.log("✅ IMAGE SCRIPT DB:", db.databaseName);

// ⬇️ collection force select
const TempCollege = db.collection("college_course_test");
console.log("✅ IMAGE SCRIPT COLLECTION:", TempCollege.collectionName);

  const college = await TempCollege.findOne({ _id });


  if (!college) {
    console.log("❌ Temp college not found:", tempId);
    process.exit(0);
  }

  if (college.heroDownloaded) {
    console.log("⚠️ Hero already exists");
    process.exit(0);
  }

  const name = cleanCollegeName(college.college_name || college.full_name);
  const links = await getGoogleCampusImages(name);

  let heroImages = [];

  for (const link of links) {
    try {
      const file = await downloadImg(link);
      const uploaded = await cloudinary.uploader.upload(file, {
        folder: "studycups/temp/hero"
      });
      heroImages.push(uploaded.secure_url);
      fs.unlinkSync(file);
    } catch {}
  }

  // ✅ UPDATE TEMP DB ONLY
  await TempCollege.updateOne(
  { _id },
  {
    $set: {
      heroImages,
      heroDownloaded: true
    }
  }
);


  console.log("✅ Hero generated for tempId:", tempId);
  process.exit(0);
}

run();
