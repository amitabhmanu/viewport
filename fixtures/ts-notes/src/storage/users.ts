const tokens = new Map<string, string>([["t-1", "alice"]]);

export function getUserByToken(token: string): string | undefined {
  return tokens.get(token);
}
