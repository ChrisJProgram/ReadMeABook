/**
 * Component: Audio Probe Parser (D6) Tests
 * Documentation: documentation/phase3/README.md
 */

import { describe, expect, it } from 'vitest';
import { parseFfprobeOutput } from '@/lib/utils/audio-probe';

describe('parseFfprobeOutput', () => {
  it('reads bitrate/channels/codec from the audio stream', () => {
    const out = JSON.stringify({
      streams: [{ bit_rate: '125000', channels: 2, codec_name: 'aac' }],
      format: { bit_rate: '130000', duration: '41400.5' },
    });
    expect(parseFfprobeOutput(out)).toEqual({ kbps: 125, channels: 2, codec: 'aac' });
  });

  it('falls back to the container bitrate when the stream omits it (common for m4b)', () => {
    const out = JSON.stringify({
      streams: [{ channels: 1, codec_name: 'aac' }],
      format: { bit_rate: '64123' },
    });
    expect(parseFfprobeOutput(out)).toEqual({ kbps: 64, channels: 1, codec: 'aac' });
  });

  it('returns nulls for missing fields rather than guessing', () => {
    expect(parseFfprobeOutput(JSON.stringify({ streams: [], format: {} }))).toEqual({
      kbps: null,
      channels: null,
      codec: null,
    });
    expect(parseFfprobeOutput(JSON.stringify({}))).toEqual({
      kbps: null,
      channels: null,
      codec: null,
    });
  });

  it('rejects zero/garbage bitrates and channel counts', () => {
    const out = JSON.stringify({
      streams: [{ bit_rate: '0', channels: 0, codec_name: '' }],
      format: { bit_rate: 'not-a-number' },
    });
    expect(parseFfprobeOutput(out)).toEqual({ kbps: null, channels: null, codec: null });
  });

  it('survives non-JSON input', () => {
    expect(parseFfprobeOutput('ffprobe: command not found')).toEqual({
      kbps: null,
      channels: null,
      codec: null,
    });
  });
});
