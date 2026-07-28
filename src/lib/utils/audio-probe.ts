/**
 * Component: Audio Probe (D6 — post-import actuals)
 * Documentation: documentation/phase3/README.md
 *
 * Measures the REAL bitrate/channels of an imported audio file via the ffprobe
 * bundled in the unified image. This is a different number from the
 * pre-download "implied" kbps (size ÷ runtime, total): here we read the actual
 * stream, and knowing the channel count finally makes a per-channel figure
 * possible — 128 kbps stereo is 64/channel, which for narration sounds
 * materially worse than 128 mono.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const PROBE_TIMEOUT_MS = 15_000;

export interface AudioProbeResult {
  /** Actual total bitrate in kbps (stream first, container as fallback). */
  kbps: number | null;
  /** Channel count of the first audio stream. */
  channels: number | null;
  codec: string | null;
}

/**
 * Parse `ffprobe -of json` output. Pure — unit-tested directly.
 * Prefers the audio stream's own bit_rate; falls back to the container
 * (format) bit_rate, which m4b/mp3 always carry even when the stream omits it.
 */
export function parseFfprobeOutput(jsonText: string): AudioProbeResult {
  let data: unknown;
  try {
    data = JSON.parse(jsonText);
  } catch {
    return { kbps: null, channels: null, codec: null };
  }

  const root = (data ?? {}) as { streams?: unknown; format?: { bit_rate?: unknown } };
  const stream = (Array.isArray(root.streams) ? root.streams[0] : undefined) as
    | { bit_rate?: unknown; channels?: unknown; codec_name?: unknown }
    | undefined;

  const toKbps = (v: unknown): number | null => {
    const bps = typeof v === 'string' ? parseInt(v, 10) : typeof v === 'number' ? v : NaN;
    return Number.isFinite(bps) && bps > 0 ? Math.round(bps / 1000) : null;
  };

  const kbps = toKbps(stream?.bit_rate) ?? toKbps(root.format?.bit_rate);

  const channels =
    typeof stream?.channels === 'number' && stream.channels > 0 ? stream.channels : null;

  const codec = typeof stream?.codec_name === 'string' && stream.codec_name ? stream.codec_name : null;

  return { kbps, channels, codec };
}

/**
 * Probe an audio file on disk. Throws only on spawn-level failures; callers
 * treat any failure as non-fatal (the import must never fail on a probe).
 */
export async function probeAudioFile(filePath: string): Promise<AudioProbeResult> {
  const { stdout } = await execFileAsync(
    'ffprobe',
    [
      '-v', 'error',
      '-select_streams', 'a:0',
      '-show_entries', 'stream=bit_rate,channels,codec_name',
      '-show_entries', 'format=bit_rate,duration',
      '-of', 'json',
      filePath,
    ],
    { timeout: PROBE_TIMEOUT_MS, maxBuffer: 1024 * 1024 }
  );

  return parseFfprobeOutput(stdout);
}
