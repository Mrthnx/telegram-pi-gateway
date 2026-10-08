import { readdir, realpath, stat } from "node:fs/promises";
import { basename, relative, resolve, sep } from "node:path";

export type Project = {
  name: string;
  path: string;
  relativePath: string;
};

const IGNORED_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  ".next",
  ".nuxt",
  "vendor",
  "coverage",
  ".cache",
  ".turbo",
  "target",
]);

const PROJECT_MARKERS = new Set([
  "package.json",
  "go.mod",
  "Cargo.toml",
  "pyproject.toml",
  "pom.xml",
  "build.gradle",
  "deno.json",
  "bun.lock",
  "pnpm-lock.yaml",
]);

export async function assertInsideWorkDir(workDir: string, candidate: string): Promise<string> {
  const root = await realpath(workDir);
  const resolved = resolve(root, candidate);
  const actual = await realpath(resolved);
  const rel = relative(root, actual);
  if (rel === "" || (!rel.startsWith("..") && !rel.startsWith(sep) && !resolve(rel).startsWith("/.."))) {
    return actual;
  }
  throw new Error("Path is outside WORK_DIR");
}

export async function discoverProjects(workDir: string, maxDepth = 4): Promise<Project[]> {
  const root = await realpath(workDir);
  const projects: Project[] = [];
  await walk(root, 0, projects, root, maxDepth);
  return projects.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

export async function findProjects(workDir: string, query: string): Promise<Project[]> {
  const normalizedQuery = normalize(query);

  try {
    const direct = await assertInsideWorkDir(workDir, query);
    const info = await stat(direct);
    if (info.isDirectory()) {
      return [{ name: basename(direct), path: direct, relativePath: relative(await realpath(workDir), direct) || "." }];
    }
  } catch {
    // Not a valid relative path; continue with fuzzy search.
  }

  const projects = await discoverProjects(workDir);
  if (!normalizedQuery) return projects.slice(0, 20);

  return projects
    .map((project) => ({ project, score: scoreProject(project, normalizedQuery) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.project.relativePath.localeCompare(b.project.relativePath))
    .slice(0, 10)
    .map((item) => item.project);
}

async function walk(dir: string, depth: number, projects: Project[], root: string, maxDepth: number): Promise<void> {
  if (depth > maxDepth) return;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }

  const names = new Set(entries.map((entry) => entry.name));
  if (entries.some((entry) => entry.isDirectory() && entry.name === ".git") || entries.some((entry) => PROJECT_MARKERS.has(entry.name))) {
    projects.push({ name: basename(dir), path: dir, relativePath: relative(root, dir) || "." });
    if (names.has(".git")) return;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (IGNORED_DIRS.has(entry.name)) continue;
    await walk(resolve(dir, entry.name), depth + 1, projects, root, maxDepth);
  }
}

function scoreProject(project: Project, query: string): number {
  const name = normalize(project.name);
  const rel = normalize(project.relativePath);
  if (name === query || rel === query) return 100;
  if (name.startsWith(query)) return 80;
  if (rel.includes(query)) return 60;
  if (name.includes(query)) return 50;
  return isSubsequence(query, rel) ? 25 : 0;
}

function normalize(value: string): string {
  return value.trim().toLowerCase().replaceAll("\\", "/");
}

function isSubsequence(query: string, value: string): boolean {
  let index = 0;
  for (const char of value) {
    if (char === query[index]) index += 1;
    if (index === query.length) return true;
  }
  return false;
}
