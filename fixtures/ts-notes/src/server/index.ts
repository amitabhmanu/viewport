// HTTP entry point. Depends on auth and notes.
import { requireUser } from "../auth/session.js";
import { createNote, listNotes } from "../notes/service.js";

export function handle(path: string, token: string, body?: string): unknown {
  const user = requireUser(token);
  if (path === "/notes" && body !== undefined) return createNote(user, body);
  return listNotes(user);
}
