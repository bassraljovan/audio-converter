// Output formats and ffmpeg argument building.
// Shared by the main process (CommonJS require) and the renderer (plain <script>).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Formats = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const ALL_RATES = [8000, 11025, 16000, 22050, 32000, 44100, 48000, 88200, 96000, 176400, 192000];

  const FORMATS = {
    mp3: {
      label: 'MP3', ext: 'mp3', kind: 'lossy', note: 'Plays everywhere',
      modes: ['cbr', 'vbr'], bitrates: [32, 48, 64, 96, 112, 128, 160, 192, 224, 256, 320],
      defaultBitrate: 320, rates: ALL_RATES.filter(r => r <= 48000), art: true,
    },
    aac: {
      label: 'AAC', ext: 'm4a', kind: 'lossy', note: 'Apple Music, iPhone',
      bitrates: [64, 96, 128, 160, 192, 256, 320], defaultBitrate: 256,
      rates: ALL_RATES.filter(r => r <= 96000), art: true,
    },
    ogg: {
      label: 'OGG', ext: 'ogg', kind: 'lossy', note: 'Vorbis, open format',
      qualities: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10], defaultQuality: 6,
      rates: ALL_RATES.filter(r => r <= 192000), art: false,
    },
    opus: {
      label: 'Opus', ext: 'opus', kind: 'lossy', note: 'Best quality per kbps',
      bitrates: [24, 32, 48, 64, 96, 128, 160, 192, 256], defaultBitrate: 128,
      rates: [8000, 12000, 16000, 24000, 48000], art: false,
    },
    wma: {
      label: 'WMA', ext: 'wma', kind: 'lossy', note: 'Older Windows players',
      bitrates: [64, 96, 128, 160, 192], defaultBitrate: 192,
      rates: [22050, 32000, 44100, 48000], art: false,
    },
    wav: {
      label: 'WAV', ext: 'wav', kind: 'lossless', note: 'Uncompressed PCM',
      depths: ['8', '16', '24', '32', '32f'], defaultDepth: '16', rates: ALL_RATES, art: false,
    },
    aiff: {
      label: 'AIFF', ext: 'aiff', kind: 'lossless', note: 'Uncompressed, Mac',
      depths: ['16', '24', '32'], defaultDepth: '16', rates: ALL_RATES, art: false,
    },
    flac: {
      label: 'FLAC', ext: 'flac', kind: 'lossless', note: 'Compressed lossless',
      depths: ['16', '24'], defaultDepth: '16', rates: ALL_RATES, art: true,
      levels: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], defaultLevel: 5,
    },
    alac: {
      label: 'ALAC', ext: 'm4a', kind: 'lossless', note: 'Apple Lossless',
      depths: ['16', '24'], defaultDepth: '16', rates: ALL_RATES.filter(r => r <= 384000), art: true,
    },
  };

  const DEPTH_LABEL = { '8': '8-bit', '16': '16-bit', '24': '24-bit', '32': '32-bit', '32f': '32-bit float' };

  const NORMALIZE = {
    off: null,
    streaming: { label: 'Streaming (−14 LUFS)', I: -14, TP: -1 },
    podcast: { label: 'Podcast (−16 LUFS)', I: -16, TP: -1.5 },
    broadcast: { label: 'Broadcast (−23 LUFS)', I: -23, TP: -2 },
  };

  const DEFAULT_SETTINGS = {
    format: 'mp3',
    mp3Mode: 'cbr', bitrate: 320, vbrQuality: 0, oggQuality: 6, depth: '16', flacLevel: 5,
    sampleRate: 'original', channels: 'original',
    normalize: 'off', gainDb: 0, fadeIn: 0, fadeOut: 0, trimSilence: false,
    keepMetadata: true, keepArt: true,
    outputMode: 'source', outputDir: '', suffix: '', onExists: 'rename', concurrency: 0,
  };

  const PRESETS = [
    { id: 'mp3-320', label: 'MP3 · 320 kbps · Best', s: { format: 'mp3', mp3Mode: 'cbr', bitrate: 320 } },
    { id: 'mp3-v0', label: 'MP3 · VBR V0 · Transparent', s: { format: 'mp3', mp3Mode: 'vbr', vbrQuality: 0 } },
    { id: 'mp3-128', label: 'MP3 · 128 kbps · Small', s: { format: 'mp3', mp3Mode: 'cbr', bitrate: 128 } },
    { id: 'podcast', label: 'Podcast · MP3 96k mono −16 LUFS', s: { format: 'mp3', mp3Mode: 'cbr', bitrate: 96, channels: '1', sampleRate: '44100', normalize: 'podcast' } },
    { id: 'aac-256', label: 'Apple · AAC 256 kbps', s: { format: 'aac', bitrate: 256 } },
    { id: 'cd', label: 'CD quality · WAV 16-bit 44.1 kHz', s: { format: 'wav', depth: '16', sampleRate: '44100', channels: '2' } },
    { id: 'studio', label: 'Studio · WAV 24-bit 48 kHz', s: { format: 'wav', depth: '24', sampleRate: '48000' } },
    { id: 'archive', label: 'Archive · FLAC 24-bit max compression', s: { format: 'flac', depth: '24', flacLevel: 8 } },
    { id: 'master', label: 'Streaming master · WAV 24-bit −14 LUFS', s: { format: 'wav', depth: '24', normalize: 'streaming' } },
    { id: 'voice', label: 'Voice memo · Opus 32 kbps mono', s: { format: 'opus', bitrate: 32, channels: '1' } },
  ];

  function pick(list, want, fallback) {
    return list.includes(want) ? want : fallback;
  }

  /**
   * Build the ffmpeg arguments that sit between the input and the output file.
   * @param {object} s     settings (DEFAULT_SETTINGS shape)
   * @param {object} info  probe result for the input: { duration, sampleRate, hasCover }
   */
  function buildArgs(s, info) {
    const f = FORMATS[s.format];
    if (!f) throw new Error('Unknown format: ' + s.format);
    info = info || {};
    const args = [];
    const art = s.keepArt && f.art && info.hasCover;

    args.push('-map', '0:a:0');
    if (art) args.push('-map', `0:${info.coverIndex}`, '-c:v', 'copy', '-disposition:v:0', 'attached_pic');
    else args.push('-vn');
    args.push('-sn', '-dn');
    if (!s.keepMetadata) args.push('-map_metadata', '-1', '-map_chapters', '-1');

    // Codec
    switch (s.format) {
      case 'mp3':
        args.push('-c:a', 'libmp3lame');
        if (s.mp3Mode === 'vbr') args.push('-q:a', String(clampInt(s.vbrQuality, 0, 9)));
        else args.push('-b:a', pick(f.bitrates, Number(s.bitrate), f.defaultBitrate) + 'k');
        args.push('-id3v2_version', '3');
        break;
      case 'aac':
        args.push('-c:a', 'aac', '-b:a', pick(f.bitrates, Number(s.bitrate), f.defaultBitrate) + 'k', '-movflags', '+faststart');
        break;
      case 'ogg':
        args.push('-c:a', 'libvorbis', '-q:a', String(clampInt(s.oggQuality, 0, 10)));
        break;
      case 'opus':
        args.push('-c:a', 'libopus', '-b:a', pick(f.bitrates, Number(s.bitrate), f.defaultBitrate) + 'k', '-vbr', 'on');
        break;
      case 'wma':
        args.push('-c:a', 'wmav2', '-b:a', pick(f.bitrates, Number(s.bitrate), f.defaultBitrate) + 'k');
        break;
      case 'wav': {
        const d = pick(f.depths, s.depth, f.defaultDepth);
        const codec = { '8': 'pcm_u8', '16': 'pcm_s16le', '24': 'pcm_s24le', '32': 'pcm_s32le', '32f': 'pcm_f32le' }[d];
        args.push('-c:a', codec);
        break;
      }
      case 'aiff': {
        const d = pick(f.depths, s.depth, f.defaultDepth);
        args.push('-c:a', { '16': 'pcm_s16be', '24': 'pcm_s24be', '32': 'pcm_s32be' }[d], '-write_id3v2', '1');
        break;
      }
      case 'flac': {
        const d = pick(f.depths, s.depth, f.defaultDepth);
        args.push('-c:a', 'flac', '-compression_level', String(clampInt(s.flacLevel, 0, 12)));
        if (d === '24') args.push('-sample_fmt', 's32', '-bits_per_raw_sample', '24');
        else args.push('-sample_fmt', 's16');
        break;
      }
      case 'alac': {
        const d = pick(f.depths, s.depth, f.defaultDepth);
        args.push('-c:a', 'alac', '-sample_fmt', d === '24' ? 's32p' : 's16p');
        if (d === '24') args.push('-bits_per_raw_sample', '24');
        args.push('-movflags', '+faststart');
        break;
      }
    }

    // Sample rate: an explicit choice wins; otherwise keep the source rate if the
    // format accepts it, else the nearest supported rate at or above it.
    let rate = null;
    if (s.sampleRate !== 'original') rate = Number(s.sampleRate);
    else if (info.sampleRate && !f.rates.includes(info.sampleRate)) rate = nearestRate(f.rates, info.sampleRate);
    else if (info.sampleRate && s.normalize !== 'off') rate = info.sampleRate; // loudnorm upsamples to 192k
    if (rate) args.push('-ar', String(rate));

    if (s.channels === '1' || s.channels === '2') args.push('-ac', s.channels);

    const filters = buildFilters(s, info);
    if (filters.length) args.push('-af', filters.join(','));

    return args;
  }

  function buildFilters(s, info) {
    const out = [];
    const fadeIn = Math.max(0, Number(s.fadeIn) || 0);
    const fadeOut = Math.max(0, Number(s.fadeOut) || 0);
    const gain = Number(s.gainDb) || 0;
    const sil = 'silenceremove=start_periods=1:start_duration=0.05:start_threshold=-60dB';

    if (s.trimSilence) {
      // Trim the head, then reverse to trim the tail. While reversed, a fade-in is
      // a fade-out at the real end, which needs no knowledge of the final length.
      out.push(sil, 'areverse', sil);
      if (fadeOut) out.push(`afade=t=in:d=${fadeOut}`);
      out.push('areverse');
    }
    if (gain) out.push(`volume=${gain}dB`);
    const n = NORMALIZE[s.normalize];
    if (n) out.push(`loudnorm=I=${n.I}:TP=${n.TP}:LRA=11`);
    if (fadeIn) out.push(`afade=t=in:st=0:d=${fadeIn}`);
    if (fadeOut && !s.trimSilence && info.duration) {
      const st = Math.max(0, info.duration - fadeOut);
      out.push(`afade=t=out:st=${st.toFixed(3)}:d=${fadeOut}`);
    }
    return out;
  }

  function nearestRate(rates, want) {
    const up = rates.filter(r => r >= want);
    return up.length ? up[0] : rates[rates.length - 1];
  }

  function clampInt(v, lo, hi) {
    v = Math.round(Number(v));
    if (!Number.isFinite(v)) v = lo;
    return Math.min(hi, Math.max(lo, v));
  }

  return { FORMATS, DEPTH_LABEL, NORMALIZE, DEFAULT_SETTINGS, PRESETS, ALL_RATES, buildArgs };
});
