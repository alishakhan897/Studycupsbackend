import sharp from 'sharp';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// ES Modules mein __dirname nahi hota, isliye ye 2 lines zaroori hain
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const directory = 'C:/Users/Hp/OneDrive/Pictures/studycups-education---college-portal (4)/studycups-education---college-portal (2)/studycups-education---college-portal (1)/public/icons'; 

if (!fs.existsSync(directory)) {
    console.error("❌ Error: Path nahi mila!");
    process.exit();
}

console.log("🚀 Converting PNGs to WebP...");

fs.readdirSync(directory).forEach(file => {
  if (path.extname(file).toLowerCase() === '.png') {
    const inputPath = path.join(directory, file);
    const outputPath = path.join(directory, file.replace('.png', '.webp'));

    sharp(inputPath)
      .webp({ quality: 80 })
      .toFile(outputPath)
      .then(() => console.log(`✅ Success: ${file}`))
      .catch(err => console.error(`❌ Error: ${file}`, err));
  }
});