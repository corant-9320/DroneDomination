/** Escape HTML special characters for safe innerHTML insertion. */
export function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Capitalize first letter; return em-dash for nullish/empty strings. */
export function capitalize(s: string | undefined | null): string {
  if (!s) return '—';
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Map combat step tone to a CSS color value. */
export function toneColor(tone: string): string {
  switch (tone) {
    case 'positive': return '#8f8';
    case 'negative': return '#f88';
    case 'critical': return '#fa0';
    case 'neutral':  return '#ccc';
    default:         return '#ccc';
  }
}
