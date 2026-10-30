// Notes logic. CommonJS-style require kept on purpose to exercise the scanner.
import { createRequire } from "node:module";
import { insert, byOwner } from "../storage/notes.js";

const require = createRequire(import.meta.url);
const { slugify } = require("./slug.cjs") as { slugify: (s: string) => string };

export function createNote(owner: string, body: string): { slug: string } {
  const slug = slugify(body.slice(0, 20));
  insert({ owner, slug, body });
  return { slug };
}

export function listNotes(owner: string): string[] {
  return byOwner(owner).map((n) => n.slug);
}
