export { escapeRe };

// escapes a string for use inside a RegExp
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
