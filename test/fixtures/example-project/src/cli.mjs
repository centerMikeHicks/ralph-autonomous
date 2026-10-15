import { formatGreeting } from './hello.mjs';

/** The CLI entry: prints the greeting for the first argument. */
export function run(argv, write = (s) => process.stdout.write(s)) {
  write(`${formatGreeting(argv[0])}\n`);
  return 0;
}
