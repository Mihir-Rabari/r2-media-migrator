import * as fs from 'node:fs';
import { MediaUrlResolver, ResolverOptions } from './resolver';
import { readMappingFile } from '../reporting/report';

/**
 * Resolver backed by the exported mapping file. Re-reads the file when its mtime changes (checked at most every
 * `checkEveryMs`), so a running application picks up newly verified assets without a restart and without a DB query
 * per image. A missing/corrupt mapping yields an EMPTY resolver: unresolved is safe, guessed is not.
 */
export class MappingResolver {
  private resolver: MediaUrlResolver;
  private mtime = -1;
  private lastCheck = 0;
  constructor(private readonly opts: ResolverOptions, private readonly file: string, private readonly checkEveryMs = 5000, private readonly now: () => number = Date.now) {
    this.resolver = new MediaUrlResolver(opts, []);
    this.refresh(true);
  }
  get current(): MediaUrlResolver {
    if (this.now() - this.lastCheck >= this.checkEveryMs) this.refresh(false);
    return this.resolver;
  }
  private refresh(force: boolean): void {
    this.lastCheck = this.now();
    let m = -1;
    try {
      m = fs.statSync(this.file).mtimeMs;
    } catch {
      /* no mapping yet */
    }
    if (!force && m === this.mtime) return;
    this.mtime = m;
    this.resolver = new MediaUrlResolver(this.opts, m === -1 ? [] : readMappingFile(this.file));
  }
}
