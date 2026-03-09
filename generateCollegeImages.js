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
  const inputId = process.argv[2];
  console.log("ID received:", inputId);

  if (!inputId) {
    console.log("ID missing");
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGO_URI);

  const db = mongoose.connection.client.db("studentcap");
  console.log("IMAGE SCRIPT DB:", db.databaseName);

  const CollegeCollection = db.collection("new_college");
  console.log("IMAGE SCRIPT COLLECTION:", CollegeCollection.collectionName);

  let college = null;

  if (ObjectId.isValid(inputId)) {
    college = await CollegeCollection.findOne({ _id: new ObjectId(inputId) });
  }

  if (!college && !Number.isNaN(Number(inputId))) {
    college = await CollegeCollection.findOne({ id: Number(inputId) });
  }

  if (!college) {
    console.log("College not found in studentcap.new_college:", inputId);
    process.exit(0);
  }

  const existingHeroImages = Array.isArray(college.heroImages)
    ? college.heroImages.filter(Boolean)
    : [];

  if (existingHeroImages.length > 0 || college.heroDownloaded) {
    console.log("Hero already exists, skipping");
    process.exit(0);
  }

  const cmsName = college?.cms?.basic?.name?.value;
  const name = cleanCollegeName(
    cmsName || college.name || college.college_name || college.full_name
  );

  if (!name) {
    console.log("College name missing, cannot search images");
    process.exit(0);
  }

  const links = await getGoogleCampusImages(name);

  let heroImages = [];

  for (const link of links) {
    try {
      const file = await downloadImg(link);
      const uploaded = await cloudinary.uploader.upload(file, {
        folder: "studycups/colleges/hero"
      });
      heroImages.push(uploaded.secure_url);
      fs.unlinkSync(file);
    } catch {
      // ignore one-off image failures
    }
  }

  if (!heroImages.length) {
    console.log("No hero image generated");
    process.exit(0);
  }

  await CollegeCollection.updateOne(
    { _id: college._id },
    {
      $set: {
        heroImages,
        heroDownloaded: true
      }
    }
  );

  console.log("Hero generated for college:", college._id.toString());
  process.exit(0);
}

run();
