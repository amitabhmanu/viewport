// Token check. Uses storage through a tsconfig path alias.
import { getUserByToken } from "@storage/users.js";

export function requireUser(token: string): string {
  const user = getUserByToken(token);
  if (!user) throw new Error("unauthorized");
  return user;
}
