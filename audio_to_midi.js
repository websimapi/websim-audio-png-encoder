import * as MidiWriter from 'midi-writer-js';

export async function convertAudioBytesToMIDI(bytes, mime = 'audio/*') {
  const blob = new Blob([bytes], { type: mime });
  const arrayBuffer = await blob.arrayBuffer();
  const audioBuffer = await safeDecodeAudioBuffer(arrayBuffer);
  // Downmix to mono
  const sr = audioBuffer.sampleRate;
  const ch0 = audioBuffer.getChannelData(0);
  const mono = audioBuffer.numberOfChannels > 1
    ? avgChannels(audioBuffer)
    : ch0;

  // Frame parameters
  const frameSize = 1024;
  const hopSize = 512;
  const frames = frameSignal(mono, frameSize, hopSize);

  // Onset envelope and tempo estimation
  const energy = frames.map(f => rms(f));
  const onsetEnv = diffPos(energy);
  const tempo = estimateTempo(onsetEnv, sr, hopSize) || 120;

  // Pitch per frame via autocorrelation
  const pitches = frames.map(f => detectPitchACF(f, sr));
  // Group frames to notes
  const minNoteFrames = 2;
  const notes = groupNotes(pitches, hopSize / sr, minNoteFrames);

  // Build MIDI tracks
  const tpq = 128;
  const writer = new MidiWriter.Writer();
  const melody = new MidiWriter.Track();
  melody.addEvent(new MidiWriter.ProgramChangeEvent({ instrument: 1 }));   // Acoustic Grand Piano (ch 1)

  const bass = new MidiWriter.Track();
  bass.addEvent(new MidiWriter.ProgramChangeEvent({ instrument: 33 }));    // Acoustic Bass (ch 2)

  const drums = new MidiWriter.Track();
  drums.setChannel(10); // Percussion channel

  const secPerBeat = 60 / tempo;
  let notesCount = 0;

  for (const n of notes) {
    const durationBeats = Math.max(0.25, n.durationSec / secPerBeat); // min 16th
    const durStr = beatsToDuration(durationBeats);
    const pitchStr = midiToNoteName(n.midi);
    melody.addEvent(new MidiWriter.NoteEvent({ pitch: [pitchStr], duration: durStr, velocity: 80 }));
    // Bass layer one octave down on longer notes
    if (durationBeats >= 0.5) {
      const bassNote = midiToNoteName(Math.max(24, n.midi - 12));
      bass.addEvent(new MidiWriter.NoteEvent({ pitch: [bassNote], duration: durStr, velocity: 70 }));
    }
    notesCount++;
  }

  // Simple percussion from onsets
  const beatSec = secPerBeat;
  let tSec = 0;
  for (let i = 0; i < onsetEnv.length; i++) {
    if (onsetEnv[i] > median(onsetEnv) * 2.5) {
      const durStr = beatsToDuration(0.25);
      drums.addEvent(new MidiWriter.NoteEvent({ pitch: ['42'], duration: durStr, velocity: 60 })); // Closed Hi-Hat
      tSec += hopSize / sr;
    }
  }

  writer.addTrack(melody);
  writer.addTrack(bass);
  writer.addTrack(drums);

  const midiDataUri = writer.dataUri();
  const midiBytes = dataUriToBytes(midiDataUri);
  return { blob: new Blob([midiBytes], { type: 'audio/midi' }), tempo, notesCount };
}

// Helpers
function avgChannels(buf) {
  const len = buf.length;
  const out = new Float32Array(len);
  const chs = [];
  for (let c = 0; c < buf.numberOfChannels; c++) chs.push(buf.getChannelData(c));
  for (let i = 0; i < len; i++) {
    let s = 0;
    for (let c = 0; c < chs.length; c++) s += chs[c][i];
    out[i] = s / chs.length;
  }
  return out;
}

function frameSignal(sig, frameSize, hopSize) {
  const frames = [];
  for (let i = 0; i + frameSize <= sig.length; i += hopSize) {
    frames.push(sig.subarray(i, i + frameSize));
  }
  return frames;
}

function rms(frame) {
  let s = 0;
  for (let i = 0; i < frame.length; i++) s += frame[i] * frame[i];
  return Math.sqrt(s / frame.length);
}

function diffPos(arr) {
  const out = new Array(arr.length).fill(0);
  for (let i = 1; i < arr.length; i++) {
    const d = arr[i] - arr[i - 1];
    out[i] = d > 0 ? d : 0;
  }
  return out;
}

function estimateTempo(onsetEnv, sr, hop) {
  // Autocorrelation over onset envelope to find lag
  const ac = autocorr(onsetEnv);
  // Ignore zero lag
  ac[0] = 0;
  // Map lag index to BPM
  let bestLag = 0, bestVal = -Infinity;
  for (let lag = Math.floor(sr / hop / 240); lag < Math.floor(sr / hop / 40); lag++) {
    if (ac[lag] > bestVal) { bestVal = ac[lag]; bestLag = lag; }
  }
  const secPerLag = (bestLag * hop) / sr;
  const bpm = secPerLag > 0 ? 60 / secPerLag : 0;
  // Snap to reasonable range
  if (bpm < 60) return bpm * 2;
  if (bpm > 180) return bpm / 2;
  return bpm;
}

function autocorr(x) {
  const n = x.length;
  const ac = new Array(n).fill(0);
  for (let lag = 0; lag < n; lag++) {
    let s = 0;
    for (let i = 0; i + lag < n; i++) s += x[i] * x[i + lag];
    ac[lag] = s;
  }
  return ac;
}

function detectPitchACF(frame, sr) {
  // Autocorrelation-based pitch, search 50–1000 Hz
  const minLag = Math.floor(sr / 1000);
  const maxLag = Math.floor(sr / 50);
  const ac = autocorr(frame);
  // Normalize
  const max = Math.max(...ac);
  if (max <= 1e-6) return { freq: 0, midi: 0, conf: 0 };
  let bestLag = 0, bestVal = 0;
  for (let lag = minLag; lag <= maxLag; lag++) {
    const v = ac[lag];
    if (v > bestVal) { bestVal = v; bestLag = lag; }
  }
  const freq = bestLag ? sr / bestLag : 0;
  const conf = bestVal / max;
  const midi = freqToMidi(freq);
  return conf > 0.2 ? { freq, midi, conf } : { freq: 0, midi: 0, conf: 0 };
}

function freqToMidi(f) {
  if (!f || !isFinite(f) || f <= 0) return 0;
  return Math.round(69 + 12 * Math.log2(f / 440));
}

function groupNotes(pitches, frameSec, minFrames) {
  const notes = [];
  let curMidi = 0, start = 0;
  for (let i = 0; i < pitches.length; i++) {
    const m = pitches[i].midi;
    if (!curMidi && m) { curMidi = m; start = i; continue; }
    if (curMidi && (!m || Math.abs(m - curMidi) > 1)) {
      const len = i - start;
      if (len >= minFrames) {
        notes.push({ midi: curMidi, durationSec: len * frameSec });
      }
      curMidi = m; start = m ? i : 0;
    }
  }
  // tail
  if (curMidi) {
    const len = pitches.length - start;
    if (len >= minFrames) {
      notes.push({ midi: curMidi, durationSec: len * frameSec });
    }
  }
  return notes;
}

function beatsToDuration(beats) {
  // Map beats to MIDIWriter duration strings
  if (beats >= 4) return '1';
  if (beats >= 2) return '2';
  if (beats >= 1) return '4';
  if (beats >= 0.5) return '8';
  if (beats >= 0.25) return '16';
  return '32';
}

function midiToNoteName(n) {
  const names = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
  const note = names[n % 12] || 'C';
  const octave = Math.floor(n / 12) - 1;
  return `${note}${octave}`;
}

function dataUriToBytes(uri) {
  const base64 = uri.split(',')[1];
  const bin = atob(base64);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return buf;
}

function median(arr) {
  const a = arr.slice().sort((x,y)=>x-y);
  const m = Math.floor(a.length/2);
  return a.length ? (a.length%2 ? a[m] : (a[m-1]+a[m])/2) : 0;
}

async function safeDecodeAudioBuffer(arrayBuffer) {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  const ctx = new Ctx();
  try {
    // Safari-compatible promise wrapper
    const buf = await new Promise((res, rej) => {
      ctx.decodeAudioData(arrayBuffer, res, rej);
    });
    return buf;
  } finally {
    try { ctx.close(); } catch (_) {}
  }
}