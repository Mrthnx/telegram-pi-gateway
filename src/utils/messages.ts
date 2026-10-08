const TELEGRAM_LIMIT = 4096;
const SAFE_LIMIT = 3800;

export function splitTelegramMessage(message: string): string[] {
  if (!message.trim()) return ["(Sin respuesta de Pi)"];
  const chunks: string[] = [];
  let remaining = message;

  while (remaining.length > SAFE_LIMIT) {
    const breakpoint = findBreakpoint(remaining, SAFE_LIMIT);
    chunks.push(remaining.slice(0, breakpoint).trimEnd());
    remaining = remaining.slice(breakpoint).trimStart();
  }
  chunks.push(remaining);

  if (chunks.length === 1) return chunks;
  return chunks.map((chunk, index) => `Respuesta ${index + 1}/${chunks.length}\n\n${chunk}`.slice(0, TELEGRAM_LIMIT));
}

function findBreakpoint(text: string, limit: number): number {
  const preferred = ["\n\n", "\n", ". ", " "];
  for (const marker of preferred) {
    const index = text.lastIndexOf(marker, limit);
    if (index > limit * 0.6) return index + marker.length;
  }
  return limit;
}
