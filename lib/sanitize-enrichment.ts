export function sanitizeEnrichmentDescription(value: string) {
  return value
    .replace(
      /\s*\(\s*\[[^\]]+\]\(\s*https?:\/\/[^)]+\)\s*\)\s*/gi,
      " ",
    )
    .replace(/\s*\[[^\]]+\]\(\s*https?:\/\/[^)]+\)\s*/gi, " ")
    .replace(/\s*\(\s*https?:\/\/[^)]+\)\s*/gi, " ")
    .replace(/\s*https?:\/\/\S+/gi, " ")
    .replace(/\(\s*\)/g, " ")
    .replace(/\s+([,.;:!?])/g, "$1")
    .replace(/\s{2,}/g, " ")
    .trim();
}
