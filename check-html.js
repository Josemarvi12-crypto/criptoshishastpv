const fs = require("fs");

const html = fs.readFileSync("index.html", "utf8");
const app = fs.readFileSync("app.js", "utf8");
const htmlIds = new Set([...html.matchAll(/id="([^"]+)"/g)].map((match) => match[1]));
const referencedIds = [...app.matchAll(/querySelector\("#([^"]+)"\)/g)].map((match) => match[1]);
const missingIds = [...new Set(referencedIds.filter((id) => !htmlIds.has(id)))];

if (missingIds.length) {
  console.error(`Faltan elementos HTML usados por app.js: ${missingIds.join(", ")}`);
  process.exit(1);
}

if (!html.includes("firebase-app-compat.js") || !html.includes("firebase-firestore-compat.js")) {
  console.error("Los scripts Firebase Compat necesarios no están cargados.");
  process.exit(1);
}

if (!html.includes("app.js?v=20260612b") || !html.includes("firebase-service.js?v=20260612b")) {
  console.error("Las versiones de caché de los scripts no están actualizadas.");
  process.exit(1);
}

console.log(`HTML correcto: ${htmlIds.size} IDs y ${referencedIds.length} referencias comprobadas.`);
