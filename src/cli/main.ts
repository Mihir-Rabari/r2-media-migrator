#!/usr/bin/env node
import * as path from 'node:path';
import { HELP, parseCli } from './args';
import { execute, Io, toErrorResult } from './commands';
import { ExitCode } from '../domain/errors';
import { globalRedactor } from '../security/redact';

/** Programmatic entry point (used by tests and by `main`). Never throws: returns an exit code. */
export async function runCli(argv: readonly string[], io?: Partial<Io>): Promise<number> {
  const full: Io = {
    out: io?.out ?? process.stdout,
    err: io?.err ?? process.stderr,
    env: io?.env ?? process.env,
    argv,
    mainJs: io?.mainJs ?? path.resolve(__dirname, 'main.js'),
    stdinIsTTY: io?.stdinIsTTY ?? !!process.stdin.isTTY,
  };
  let json = argv.includes('--json');
  try {
    const parsed = parseCli(argv);
    json = parsed.json;
    if (parsed.version) {
      return await execute({ ...parsed, command: 'version' }, full);
    }
    if (parsed.help && parsed.command === 'help') {
      full.out.write(HELP);
      return ExitCode.OK;
    }
    if (parsed.help) {
      full.out.write(HELP);
      return ExitCode.OK;
    }
    return await execute(parsed, full);
  } catch (e) {
    const r = toErrorResult(e);
    if (json) full.out.write(JSON.stringify({ type: 'error', code: r.code, message: r.message, exitCode: r.exitCode }) + '\n');
    else full.err.write(`error [${r.code}]: ${globalRedactor.string(r.message)}\n`);
    return r.exitCode;
  }
}

if (require.main === module) {
  runCli(process.argv.slice(2)).then(
    (code) => {
      // let stdout flush, then exit with the real code
      process.exitCode = code;
      setTimeout(() => process.exit(code), 50).unref();
    },
    (e) => {
      process.stderr.write(`fatal: ${globalRedactor.string(String(e))}\n`);
      process.exit(ExitCode.OPERATIONAL);
    },
  );
}
