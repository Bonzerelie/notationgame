// script.js (ESM)
import {
  Factory,
  Stave,
  StaveNote,
  Voice,
  Formatter,
  Beam,
  Barline
} from "https://unpkg.com/vexflow@4.2.3/build/esm/vexflow.js";

/* -----------------------
   DOM & UI Wiring
------------------------*/
const screens = {
  home: document.getElementById("home-screen"),
  game: document.getElementById("game-screen"),
};
const start1 = document.getElementById("start-1");
const start2 = document.getElementById("start-2");
const homeBtn = document.getElementById("home-btn");
const playBtn = document.getElementById("play-btn");
const optionsGrid = document.getElementById("options");
const feedbackEl = document.getElementById("feedback");
const modeLabel = document.getElementById("mode-label");
const streakEl = document.getElementById("streak");
const correctCountEl = document.getElementById("correct-count");
const totalCountEl = document.getElementById("total-count");

/* -----------------------
   Audio Setup (Web Audio)
------------------------*/
const BPM = 100;
const SEC_PER_BEAT = 60 / BPM; // 0.6s

const PITCHES = ["c4","d4","e4","f4","g4","a4","b4","c5"];
const audioFiles = Object.fromEntries(PITCHES.map(n => [n, `audio/${n}.mp3`]));

let audioCtx = null;
let masterGain = null;
let buffers = {};
let activeSources = [];

async function ensureAudio() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    masterGain = audioCtx.createGain();
    masterGain.connect(audioCtx.destination);
    masterGain.gain.value = 0.9;
    await loadAllSamples();
  }
  if (audioCtx.state === "suspended") {
    await audioCtx.resume();
  }
}

async function loadAllSamples() {
  const entries = Object.entries(audioFiles);
  await Promise.all(entries.map(async ([name, url]) => {
    const res = await fetch(url);
    const arr = await res.arrayBuffer();
    buffers[name] = await new Promise((resolve, reject) => {
      audioCtx.decodeAudioData(arr, resolve, reject);
    });
  }));
}

function stopAllAudio() {
  activeSources.forEach(s => { try { s.source.stop(0); } catch(e){} });
  activeSources = [];
}

/** Schedules a sequence of events with Web Audio at 100 BPM */
function playSequence(sequence) {
  if (!audioCtx) return;
  stopAllAudio();

  const startAt = audioCtx.currentTime + 0.05;
  let t = startAt;

  sequence.forEach(ev => {
    const durSec = ev.beats * SEC_PER_BEAT;
    if (ev.type === "note") {
      const buf = buffers[ev.pitch.toLowerCase()];
      if (buf) {
        const source = audioCtx.createBufferSource();
        const gain = audioCtx.createGain();
        source.buffer = buf;
        source.connect(gain);
        gain.connect(masterGain);

        // Short fade out to avoid clicks
        const fade = Math.min(0.04, Math.max(0.01, durSec * 0.15));
        gain.gain.setValueAtTime(1, t);
        gain.gain.linearRampToValueAtTime(0.0001, t + Math.max(0, durSec - 0.005));

        source.start(t);
        source.stop(t + durSec);

        activeSources.push({ source, gain });
      }
    }
    t += durSec;
  });
}

/* -----------------------
   Game Model
------------------------*/
const DURATIONS = [
  { name: "w", beats: 4 },
  { name: "h", beats: 2 },
  { name: "q", beats: 1 },
  { name: "8", beats: 0.5 }
];

const NOTE_OR_REST = ["note","note","note","rest"]; // 25% chance rest

const state = {
  bars: 1,
  streak: 0,
  correctCount: 0,
  totalCount: 0,
  current: null, // { correctIdx, options: [seq, seq, seq, seq], audioSeq }
};

/* Sequence element: { type: 'note'|'rest', pitch: 'C4'?, beats: number } */

function rand(arr){ return arr[Math.floor(Math.random()*arr.length)]; }
function choiceWeighted(weights){ // weights: [{item, w}]
  const total = weights.reduce((s, x) => s + x.w, 0);
  let r = Math.random() * total;
  for (const {item, w} of weights) { if ((r -= w) <= 0) return item; }
  return weights[weights.length - 1].item;
}
function pickNeighborPitch(pitch){
  const idx = PITCHES.indexOf(pitch.toLowerCase());
  if (idx === -1) return rand(PITCHES);
  const neighbors = [];
  if (idx > 0) neighbors.push(PITCHES[idx-1]);
  if (idx < PITCHES.length-1) neighbors.push(PITCHES[idx+1]);
  return rand(neighbors).toUpperCase();
}

function generateMeasure() {
  let beatsLeft = 4;
  const elements = [];
  while (beatsLeft > 0) {
    // Choose a duration that fits
    const choices = DURATIONS.filter(d => d.beats <= beatsLeft);
    // Lightweight rhythm shaping: bias away from too many wholes/eighths
    const weighted = choices.map(d => ({
      item: d,
      w: (d.name === "w") ? 1 : (d.name === "8") ? 2 : 3
    }));
    const d = choiceWeighted(weighted);

    // Pick note or rest (bias towards notes)
    let type = rand(NOTE_OR_REST);
    // Avoid consecutive rests & avoid leading/trailing rests too often
    if (elements.length === 0 || beatsLeft - d.beats === 0) type = "note";
    if (elements.length && elements[elements.length-1].type === "rest") type = "note";

    if (type === "note") {
      const pitch = rand(PITCHES).toUpperCase();
      elements.push({ type: "note", pitch: pitch.toUpperCase(), beats: d.beats });
    } else {
      elements.push({ type: "rest", beats: d.beats });
    }
    beatsLeft -= d.beats;
  }
  return elements;
}

function generateSequence(bars) {
  const measures = [];
  for (let i=0;i<bars;i++) measures.push(generateMeasure());
  return measures;
}

// Helpers to deep-copy sequences
function cloneMeasures(measures) { return measures.map(bar => bar.map(e => ({...e}))); }
function measuresToFlat(measures) { return measures.flat(); }

// Ensure two sequences differ (pitch/rhythm at least one position)
function sequencesEqual(a, b) {
  const fa = measuresToFlat(a), fb = measuresToFlat(b);
  if (fa.length !== fb.length) return false;
  for (let i=0;i<fa.length;i++){
    const A = fa[i], B = fb[i];
    if (A.type !== B.type) return false;
    if (A.beats !== B.beats) return false;
    if (A.type === "note" && A.pitch !== B.pitch) return false;
  }
  return true;
}

function makeDistractors(baseMeasures) {
  const variants = [];

  // V1: small melodic change: change one non-rest note by a step
  (function(){
    const m = cloneMeasures(baseMeasures);
    const all = m.flat();
    const noteIdxs = all.map((e,i)=> e.type==="note" ? i : -1).filter(i=>i>=0);
    if (noteIdxs.length) {
      const idx = rand(noteIdxs);
      const which = all[idx];
      which.pitch = pickNeighborPitch(which.pitch);
    }
    variants.push(m);
  })();

  // V2: rhythmic tweak: split one half->quarters OR quarter->eighths (inside a single bar)
  (function(){
    const m = cloneMeasures(baseMeasures);
    let done = false;
    for (let bi=0; bi<m.length && !done; bi++){
      for (let ei=0; ei<m[bi].length && !done; ei++){
        const el = m[bi][ei];
        // don't split rests exclusively to keep similarity; but sometimes okay
        if (el.beats === 2) {
          // split half into two quarters
          const repl = [
            { ...el, beats: 1 },
            { ...el, beats: 1 }
          ];
          m[bi].splice(ei, 1, ...repl);
          done = true;
        } else if (el.beats === 1) {
          // split quarter into two eighths
          const repl = [
            { ...el, beats: 0.5 },
            { ...el, beats: 0.5 }
          ];
          m[bi].splice(ei, 1, ...repl);
          done = true;
        }
      }
    }
    variants.push(m);
  })();

  // V3: swap two adjacent items inside a bar (keeps bar sums, often subtle)
  (function(){
    const m = cloneMeasures(baseMeasures);
    let done = false;
    for (let bi=0; bi<m.length && !done; bi++){
      if (m[bi].length >= 2) {
        const i = Math.floor(Math.random() * (m[bi].length - 1));
        const j = i + 1;
        const tmp = m[bi][i];
        m[bi][i] = m[bi][j];
        m[bi][j] = tmp;
        done = true;
      }
    }
    variants.push(m);
  })();

  // Ensure uniqueness vs base and each other; if duplicates slip in, regenerate simply by nudging a pitch
  for (let k=0; k<variants.length; k++){
    if (sequencesEqual(variants[k], baseMeasures)) {
      const m = variants[k];
      outer:
      for (let bi=0; bi<m.length; bi++){
        for (let ei=0; ei<m[bi].length; ei++){
          const el = m[bi][ei];
          if (el.type === "note") { el.pitch = pickNeighborPitch(el.pitch); break outer; }
        }
      }
    }
  }
  // Make sure all variants are pairwise different
  for (let i=0;i<variants.length;i++){
    for (let j=i+1;j<variants.length;j++){
      if (sequencesEqual(variants[i], variants[j])) {
        // tweak j slightly
        const m = variants[j];
        outer2:
        for (let bi=0; bi<m.length; bi++){
          for (let ei=0; ei<m[bi].length; ei++){
            const el = m[bi][ei];
            if (el.type === "note") { el.pitch = pickNeighborPitch(el.pitch); break outer2; }
          }
        }
      }
    }
  }
  return variants;
}

/* -----------------------
   Notation Rendering
------------------------*/
function pitchToVexKey(p){ // "C4" -> "c/4"
  return `${p[0].toLowerCase()}/${p.slice(1)}`;
}
function durToVex(d){ // beats -> VexFlow duration code
  if (d === 4) return "w";
  if (d === 2) return "h";
  if (d === 1) return "q";
  if (d === 0.5) return "8";
  throw new Error("Unsupported duration");
}

/** Create and draw one option (1 or 2 bars) into a given container */
function renderOption(container, measures) {
  container.innerHTML = ""; // clear
  const width = container.clientWidth;
  const height = 140;
  const factory = new Factory({
    renderer: { elementId: container.id, width, height, background: "#0b0e14" }
  });
  const context = factory.getContext();

  const margin = 14;
  const staveWidth = (measures.length === 1) ? (width - margin*2) : Math.floor((width - margin*3) / 2);

  const staves = [];
  for (let i=0; i<measures.length; i++){
    const x = margin + i * (staveWidth + margin);
    const stave = new Stave(x, 16, staveWidth);
    if (i === 0) {
      stave.addClef("treble").addTimeSignature("4/4");
    }
    if (i === measures.length-1) {
      stave.setEndBarType(Barline.type.END);
    }
    stave.setContext(context).draw();
    staves.push(stave);

    // Build notes
    const notes = measures[i].map(el => {
      if (el.type === "rest") {
        return new StaveNote({ clef: "treble", keys: ["b/4"], duration: durToVex(el.beats) + "r" });
      } else {
        return new StaveNote({ clef: "treble", keys: [pitchToVexKey(el.pitch)], duration: durToVex(el.beats) });
      }
    });

    // Voice (4/4)
    const voice = new Voice({ num_beats: 4, beat_value: 4, resolution: Voice.TIMES_1 });
    voice.addTickables(notes);

    // Auto-beam eighths
    const beams = Beam.generateBeams(notes);

    // Format & draw
    new Formatter().joinVoices([voice]).format([voice], staveWidth - 20);
    voice.draw(context, stave);
    beams.forEach(b => b.setContext(context).draw());
  }
}

/* -----------------------
   UI Rendering of Options
------------------------*/
function buildOptionCard(idx) {
  const wrap = document.createElement("div");
  wrap.className = "option-card";
  wrap.dataset.index = String(idx);

  const header = document.createElement("div");
  header.className = "option-header";
  header.innerHTML = `<span class="option-tag">Option ${String.fromCharCode(65+idx)}</span>
                      <span class="muted">4/4 • Treble • 100 BPM</span>`;

  const canvasHost = document.createElement("div");
  canvasHost.className = "option-canvas";
  // VexFlow Factory needs an element id; ensure unique:
  canvasHost.id = `option-canvas-${Date.now()}-${Math.random().toString(36).slice(2)}`;

  wrap.appendChild(header);
  wrap.appendChild(canvasHost);
  optionsGrid.appendChild(wrap);
  return { card: wrap, canvasHost };
}

/* -----------------------
   Round Lifecycle
------------------------*/
function newRound() {
  // Clear feedback styles
  feedbackEl.classList.remove("ok","bad");
  feedbackEl.textContent = "Pick the notation that matches what you hear.";

  // Generate base measures and distractors
  const baseMeasures = generateSequence(state.bars);
  const distractors = makeDistractors(baseMeasures);
  const options = [baseMeasures, ...distractors];

  // Shuffle options while remembering the correct index
  const indices = [0,1,2,3];
  indices.sort(()=> Math.random() - 0.5);
  const correctIdx = indices.indexOf(0);
  const shuffled = indices.map(i => options[i]);

  // Store current round
  state.current = {
    correctIdx,
    options: shuffled,
    audioSeq: measuresToFlat(baseMeasures) // flat events feed audio
  };

  // Render option cards
  optionsGrid.innerHTML = "";
  shuffled.forEach((measures, i) => {
    const { card, canvasHost } = buildOptionCard(i);
    // Stop audio whenever a button/card is pressed
    card.addEventListener("click", () => {
      stopAllAudio();
      handleAnswer(i, card);
    });
    // Draw the notation
    renderOption(canvasHost, measures);
  });
}

function handleAnswer(i, cardEl) {
  const isCorrect = (i === state.current.correctIdx);
  state.totalCount += 1;
  totalCountEl.textContent = String(state.totalCount);

  if (isCorrect) {
    state.correctCount += 1;
    state.streak += 1;
    feedbackEl.textContent = "✅ Correct!";
    feedbackEl.classList.remove("bad");
    feedbackEl.classList.add("ok");
    cardEl.classList.add("correct");

    // Milestones
    if (state.streak > 0 && state.streak % 5 === 0) {
      feedbackEl.textContent = `🔥 That's ${state.streak} correct in a row — nice one! Can you get to ${state.streak + 5}?`;
    }
  } else {
    state.streak = 0;
    feedbackEl.textContent = "❌ Not quite. Try the next one!";
    feedbackEl.classList.remove("ok");
    feedbackEl.classList.add("bad");
    cardEl.classList.add("incorrect");
  }

  correctCountEl.textContent = String(state.correctCount);
  streakEl.textContent = String(state.streak);

  // Brief pause then next round
  setTimeout(() => {
    stopAllAudio();
    newRound();
  }, 900);
}

/* -----------------------
   Screen Navigation
------------------------*/
function show(screen) {
  Object.values(screens).forEach(s => s.classList.remove("active"));
  screens[screen].classList.add("active");
}

start1.addEventListener("click", async () => {
  stopAllAudio();
  await ensureAudio(); // user gesture ensured
  state.bars = 1;
  modeLabel.textContent = "1 Bar";
  show("game");
  newRound();
});

start2.addEventListener("click", async () => {
  stopAllAudio();
  await ensureAudio();
  state.bars = 2;
  modeLabel.textContent = "2 Bars";
  show("game");
  newRound();
});

homeBtn.addEventListener("click", () => {
  stopAllAudio();
  show("home");
  // Reset simple HUD (optional)
  // state.streak = 0; state.correctCount = 0; state.totalCount = 0;
  // streakEl.textContent = "0"; correctCountEl.textContent="0"; totalCountEl.textContent="0";
});

playBtn.addEventListener("click", async () => {
  stopAllAudio();
  await ensureAudio();
  if (state.current && state.current.audioSeq) {
    playSequence(state.current.audioSeq);
  }
});

// Ensure any button stops audio (global capture)
document.addEventListener("click", (e) => {
  const t = e.target;
  if (t instanceof HTMLElement && (t.tagName === "BUTTON")) {
    stopAllAudio();
  }
}, true);

/* -----------------------
   Accessibility niceties
------------------------*/
document.addEventListener("keydown", (e) => {
  // Space = play when on game screen
  if (screens.game.classList.contains("active") && e.code === "Space") {
    e.preventDefault();
    playBtn.click();
  }
});
