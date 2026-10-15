/**
 * Minimal argv parser shared by the kit's verifier scripts.
 *
 *   const a = parseArgs(process.argv.slice(2), { flags: ['json', 'strict'], opts: ['spec', 'plan'] });
 *   a.json -> boolean, a.spec -> string | undefined, a._ -> positional arguments
 *
 * Both `--spec file` and `--spec=file` are accepted. An unknown option throws, so a typo
 * is a usage error (exit 2) instead of a silently ignored flag.
 */
export function parseArgs(argv, { flags = [], opts = [] } = {}) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const raw = argv[i];
    if (!raw.startsWith('--')) { out._.push(raw); continue; }
    const eq = raw.indexOf('=');
    const name = eq < 0 ? raw.slice(2) : raw.slice(2, eq);
    if (flags.includes(name)) {
      out[name] = eq < 0 ? true : !/^(false|0|no)$/i.test(raw.slice(eq + 1));
    } else if (opts.includes(name)) {
      if (eq >= 0) out[name] = raw.slice(eq + 1);
      else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) { out[name] = argv[i + 1]; i += 1; }
      else throw new Error(`option --${name} needs a value`);
    } else {
      throw new Error(`unknown option --${name}`);
    }
  }
  return out;
}

/** Print a usage error and exit 2 (the kit's "cannot run" code). */
export function usageExit(message, usage) {
  console.error(message);
  if (usage) console.error(`usage: ${usage}`);
  process.exit(2);
}
