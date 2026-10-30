export interface Note {
  owner: string;
  slug: string;
  body: string;
}

const notes: Note[] = [];

export function insert(note: Note): void {
  notes.push(note);
}

export function byOwner(owner: string): Note[] {
  return notes.filter((n) => n.owner === owner);
}
