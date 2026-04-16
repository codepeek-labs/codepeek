'use strict';

// Sound generator — synthesizes WAV data at runtime with multiple preset packs.

const SAMPLE_RATE = 22050;

function writeWavHeader(buffer, samples) {
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + samples * 2, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(SAMPLE_RATE, 24);
  buffer.writeUInt32LE(SAMPLE_RATE * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(samples * 2, 40);
}

function wave(type, freq, t) {
  const ph = 2 * Math.PI * freq * t;
  switch (type) {
    case 'sine': return Math.sin(ph);
    case 'triangle': return 2 * Math.abs(2 * (t * freq - Math.floor(t * freq + 0.5))) - 1;
    case 'square': return Math.sign(Math.sin(ph));
    case 'saw': return 2 * (t * freq - Math.floor(t * freq + 0.5));
    default: return Math.sin(ph);
  }
}

// Render a melody from a note list: notes = [{ freq, dur, wave, delay?, vol? }]
function generateMelody(notes, baseVolume = 0.35) {
  const totalDuration = notes.reduce((m, n) => Math.max(m, (n.delay || 0) + n.dur), 0);
  const samples = Math.floor(SAMPLE_RATE * totalDuration);
  const buffer = Buffer.alloc(44 + samples * 2);
  writeWavHeader(buffer, samples);

  const mix = new Float32Array(samples);
  for (const n of notes) {
    const startSample = Math.floor((n.delay || 0) * SAMPLE_RATE);
    const noteSamples = Math.floor(n.dur * SAMPLE_RATE);
    const vol = (n.vol || 1) * baseVolume;
    for (let i = 0; i < noteSamples && startSample + i < samples; i++) {
      const t = i / SAMPLE_RATE;
      // Simplified ADSR: 5ms attack + exponential decay.
      const attack = Math.min(1, t / 0.005);
      const decay = Math.exp(-t / (n.dur * 0.5));
      const env = attack * decay;
      mix[startSample + i] += wave(n.wave || 'sine', n.freq, t) * env * vol;
    }
  }

  for (let i = 0; i < samples; i++) {
    const v = Math.max(-1, Math.min(1, mix[i]));
    buffer.writeInt16LE(Math.round(v * 32767), 44 + i * 2);
  }
  return buffer;
}

// ===== Preset packs =====

const PACKS = {
  // Soft piano feel: sine waves + quick arpeggios.
  soft: {
    sessionStart: [
      { freq: 659.25, dur: 0.09, wave: 'sine' },
      { freq: 987.77, dur: 0.16, wave: 'sine', delay: 0.08 }
    ],
    toolUse: [
      { freq: 1174.66, dur: 0.025, wave: 'sine' }
    ],
    permission: [
      { freq: 880, dur: 0.1, wave: 'sine' },
      { freq: 659.25, dur: 0.14, wave: 'sine', delay: 0.11 }
    ],
    question: [
      { freq: 523.25, dur: 0.08, wave: 'sine' },
      { freq: 659.25, dur: 0.12, wave: 'sine', delay: 0.08 }
    ],
    complete: [
      { freq: 523.25, dur: 0.08, wave: 'sine' },
      { freq: 659.25, dur: 0.08, wave: 'sine', delay: 0.07 },
      { freq: 783.99, dur: 0.2, wave: 'sine', delay: 0.14 }
    ]
  },

  // Wind chimes: high-frequency triangle waves with long decay.
  chime: {
    sessionStart: [
      { freq: 1568, dur: 0.3, wave: 'triangle', vol: 0.6 }
    ],
    toolUse: [
      { freq: 2093, dur: 0.05, wave: 'triangle', vol: 0.4 }
    ],
    permission: [
      { freq: 1318.5, dur: 0.25, wave: 'triangle' },
      { freq: 1046.5, dur: 0.3, wave: 'triangle', delay: 0.12 }
    ],
    question: [
      { freq: 1174.66, dur: 0.35, wave: 'triangle', vol: 0.7 }
    ],
    complete: [
      { freq: 1318.5, dur: 0.15, wave: 'triangle' },
      { freq: 1568, dur: 0.15, wave: 'triangle', delay: 0.08 },
      { freq: 2093, dur: 0.4, wave: 'triangle', delay: 0.16 }
    ]
  },

  // 8-bit retro: square waves (the former default).
  '8bit': {
    sessionStart: [
      { freq: 440, dur: 0.12, wave: 'square' },
      { freq: 659, dur: 0.12, wave: 'square' }
    ],
    toolUse: [
      { freq: 880, dur: 0.04, wave: 'square', vol: 0.5 }
    ],
    permission: [
      { freq: 660, dur: 0.08, wave: 'square' },
      { freq: 660, dur: 0.08, wave: 'square', delay: 0.1 },
      { freq: 880, dur: 0.12, wave: 'square', delay: 0.2 }
    ],
    question: [
      { freq: 523, dur: 0.08, wave: 'triangle' }
    ],
    complete: [
      { freq: 523, dur: 0.12, wave: 'square' },
      { freq: 659, dur: 0.12, wave: 'square' },
      { freq: 784, dur: 0.18, wave: 'square' }
    ]
  },

  // Minimal: very short notification beeps.
  minimal: {
    sessionStart: [{ freq: 1000, dur: 0.04, wave: 'sine' }],
    toolUse:     [{ freq: 1500, dur: 0.015, wave: 'sine', vol: 0.4 }],
    permission:  [{ freq: 800, dur: 0.06, wave: 'sine' }, { freq: 800, dur: 0.06, wave: 'sine', delay: 0.09 }],
    question:    [{ freq: 700, dur: 0.05, wave: 'sine' }],
    complete:    [{ freq: 1200, dur: 0.08, wave: 'sine' }]
  },

  // Silent (placeholder; nothing is played).
  silent: {
    sessionStart: [{ freq: 0, dur: 0.01, wave: 'sine', vol: 0 }],
    toolUse:     [{ freq: 0, dur: 0.01, wave: 'sine', vol: 0 }],
    permission:  [{ freq: 0, dur: 0.01, wave: 'sine', vol: 0 }],
    question:    [{ freq: 0, dur: 0.01, wave: 'sine', vol: 0 }],
    complete:    [{ freq: 0, dur: 0.01, wave: 'sine', vol: 0 }]
  }
};

const SOUND_CACHE = {};

function getSoundDataUrl(packName, type) {
  const cacheKey = `${packName}:${type}`;
  if (SOUND_CACHE[cacheKey]) return SOUND_CACHE[cacheKey];

  const pack = PACKS[packName] || PACKS.soft;
  const notes = pack[type] || pack.toolUse;
  const buf = generateMelody(notes);
  const url = `data:audio/wav;base64,${buf.toString('base64')}`;
  SOUND_CACHE[cacheKey] = url;
  return url;
}

function getAllSounds(packName = 'soft') {
  return {
    pack: packName,
    sessionStart: getSoundDataUrl(packName, 'sessionStart'),
    toolUse: getSoundDataUrl(packName, 'toolUse'),
    permission: getSoundDataUrl(packName, 'permission'),
    question: getSoundDataUrl(packName, 'question'),
    complete: getSoundDataUrl(packName, 'complete')
  };
}

function listPacks() {
  return Object.keys(PACKS).filter(k => k !== 'silent').concat('silent');
}

module.exports = { getSoundDataUrl, getAllSounds, listPacks };
