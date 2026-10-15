export function formatGreeting(name) {
  return `Hello, ${name && String(name).trim() ? String(name).trim() : 'world'}!`;
}
