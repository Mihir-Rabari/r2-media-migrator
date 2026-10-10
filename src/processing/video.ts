import { execFile } from 'node:child_process';

export interface ToolProbe {
  available: boolean;
  version?: string;
  error?: string;
}

/**
 * Video is a SEPARATE pipeline and is NOT optimised by this release: videos are inventoried, their
 * references are never rewritten, and originals are untouched. This module only reports whether the
 * encoder tooling exists so an operator can see what a future video stage would need.
 * Subprocesses use execFile with an argv array (no shell) and a hard timeout.
 */
export function probeTool(binary: 'ffmpeg' | 'ffprobe', timeoutMs = 5000): Promise<ToolProbe> {
  return new Promise((resolve) => {
    execFile(binary, ['-version'], { timeout: timeoutMs, windowsHide: true, maxBuffer: 1 << 20 }, (err, stdout) => {
      if (err) return resolve({ available: false, error: (err as NodeJS.ErrnoException).code ?? err.message });
      const first = String(stdout).split(/\r?\n/)[0] ?? '';
      resolve({ available: true, version: first.trim() });
    });
  });
}

/** Read basic stream facts for a local video file (bounded subprocess; never called with user-controlled argv). */
export function ffprobeFile(file: string, timeoutMs = 10_000): Promise<{ durationSec?: number; width?: number; height?: number; codec?: string } | null> {
  return new Promise((resolve) => {
    execFile(
      'ffprobe',
      ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name,width,height:format=duration', '-of', 'json', '--', file],
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 1 << 20 },
      (err, stdout) => {
        if (err) return resolve(null);
        try {
          const j = JSON.parse(String(stdout));
          const s = j.streams?.[0] ?? {};
          resolve({ durationSec: j.format?.duration ? Number(j.format.duration) : undefined, width: s.width, height: s.height, codec: s.codec_name });
        } catch {
          resolve(null);
        }
      },
    );
  });
}
