import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const sourceRoot = path.join(root, "src");
const failures = [];

async function listFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await listFiles(absolute));
    else files.push(absolute);
  }
  return files;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

for (const legacyPath of ["_worker.js", "worker-entry.js"]) {
  try {
    await stat(path.join(root, legacyPath));
    failures.push(`Legacy monolith still exists: ${legacyPath}`);
  } catch {
    // Expected: production code lives under src/.
  }
}

const files = (await listFiles(sourceRoot)).filter((file) => file.endsWith(".js"));
const moduleGraph = new Map();
const sourceByFile = new Map();
const importPattern = /(?:import|export)\s+(?:[^"']+?\s+from\s+)?["'](\.[^"']+)["']/g;

for (const file of files) {
  const relative = path.relative(root, file).replaceAll(path.sep, "/");
  const source = await readFile(file, "utf8");
  sourceByFile.set(file, source);
  const lineCount = source.split("\n").length;

  if (lineCount > 800) failures.push(`${relative} exceeds the 800-line module budget (${lineCount})`);
  if (source.includes("This JavaScript file is part of a legitimate")) {
    failures.push(`${relative} contains the removed anti-analysis comment block`);
  }
  if (/\blet\s+config_JSON\s*[,;]/.test(source) && relative !== "src/core/worker.js" && relative !== "src/config/store.js") {
    failures.push(`${relative} stores request configuration at module scope`);
  }
  if (/\bformatIdentifier\b/.test(source)) failures.push(`${relative} contains removed dead function formatIdentifier`);

  const imports = [];
  for (const match of source.matchAll(importPattern)) {
    const target = path.resolve(path.dirname(file), match[1]);
    const resolved = path.extname(target) ? target : `${target}.js`;
    try {
      await stat(resolved);
      imports.push(resolved);
    } catch {
      failures.push(`${relative} imports missing module ${match[1]}`);
    }
  }
  moduleGraph.set(file, imports);
}

const allSource = [...sourceByFile.values()].join("\n");
const exportPatterns = [
  /\bexport\s+(?:async\s+)?function\s+([\p{ID_Start}_$][\p{ID_Continue}$]*)/gu,
  /\bexport\s+class\s+([\p{ID_Start}_$][\p{ID_Continue}$]*)/gu,
  /\bexport\s+(?:const|let|var)\s+([\p{ID_Start}_$][\p{ID_Continue}$]*)/gu,
];

for (const [file, source] of sourceByFile) {
  const relative = path.relative(root, file).replaceAll(path.sep, "/");
  for (const pattern of exportPatterns) {
    for (const match of source.matchAll(pattern)) {
      const name = match[1];
      const references = [...allSource.matchAll(new RegExp(escapeRegExp(name), "gu"))].length;
      if (references <= 1) failures.push(`${relative} exports unused symbol ${name}`);
    }
  }
}

const visiting = new Set();
const visited = new Set();
function visit(file, chain = []) {
  if (visiting.has(file)) {
    const cycleStart = chain.indexOf(file);
    failures.push(`Circular module dependency: ${[...chain.slice(cycleStart), file]
      .map((item) => path.relative(root, item).replaceAll(path.sep, "/"))
      .join(" -> ")}`);
    return;
  }
  if (visited.has(file)) return;
  visiting.add(file);
  for (const dependency of moduleGraph.get(file) ?? []) visit(dependency, [...chain, file]);
  visiting.delete(file);
  visited.add(file);
}

for (const file of files) visit(file);

if (failures.length) {
  console.error(failures.map((failure) => `- ${failure}`).join("\n"));
  process.exit(1);
}

console.log(`Architecture check passed for ${files.length} source modules.`);
