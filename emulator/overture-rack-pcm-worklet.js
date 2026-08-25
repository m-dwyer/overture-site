// The Rack's output, drained.
//
// This processor owns no Rack, holds no WASM and decides nothing. It takes one
// already-mixed block per render quantum and plays silence when it has none.
//
// One source. The Rack runs in a Worker and hands blocks over a
// `SharedArrayBuffer` ring, which this reads with one copy, speaking to nobody.
// A page without cross-origin isolation has no ring and no Rack: it fails at
// boot rather than arriving here to be fed by messages.
//
// It interprets no time of its own, and every block here was mixed by Rust.
//
// The node is constructed with `numberOfInputs: 0`, `numberOfOutputs: 1` and
// `outputChannelCount: [2]`.

const AUDIO_BLOCK_FRAMES = 128;
const AUDIO_BLOCK_SAMPLES = AUDIO_BLOCK_FRAMES * 2;

// Interleaved `i16` is what the Source and effect ABIs carry, so the Rack mixes
// in it and the conversion to the host's float planes happens here, at the
// boundary. Dividing by 32768 keeps the negative full scale exact.
const I16_FULL_SCALE = 32768;

// Mirrors `rack-worker-protocol.ts`. An AudioWorklet module cannot import from
// the bundle, so these are copied; they are a wire format and change together.
const RING_BLOCKS = 64;
const RING_SLOT = { write: 0, read: 1 };
const RING_HEADER_INT32S = 8;

class OvertureRackPcmProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    // Counted rather than logged: an underrun is audible, and the count is what
    // turns "it sounded wrong" into a number the Worker's watermark answers for.
    this.underruns = 0;
    /** @type {Int32Array | null} */
    this.ringInts = null;
    /** @type {Int16Array | null} */
    this.ringSamples = null;
    /** @type {{ frames: number, left: Float32Array, right: Float32Array, underrunsAtStart: number } | null} */
    this.capture = null;
    this.port.onmessage = (event) => this.onMessage(event.data);
  }

  onMessage(message) {
    if (message?.type === "ring") {
      this.ringInts = new Int32Array(message.ring, 0, RING_HEADER_INT32S);
      this.ringSamples = new Int16Array(
        message.ring,
        RING_HEADER_INT32S * 4,
        RING_BLOCKS * AUDIO_BLOCK_SAMPLES,
      );
      return;
    }
    // Acceptance evidence, not a capability the Rack has any use for: this is
    // the only point at which the Rack's audio is observable, and it is what
    // reaches master. Arming allocates
    // the whole window once so the recording itself copies and nothing more.
    if (message?.type === "capture") {
      const blocks = message.blocks;
      if (!Number.isInteger(blocks) || blocks <= 0) return;
      const frames = blocks * AUDIO_BLOCK_FRAMES;
      this.capture = {
        frames: 0,
        left: new Float32Array(frames),
        right: new Float32Array(frames),
        underrunsAtStart: this.underruns,
      };
      return;
    }
    if (message?.type === "counters") {
      this.port.postMessage({ type: "counters", underruns: this.underruns });
    }
  }

  process(_inputs, outputs) {
    const output = outputs[0];
    if (!output || output.length < 2) return true;
    const left = output[0];
    const right = output[1];
    this.fill(left, right);
    // After the fill, including the underrun paths: a capture that skipped a
    // silent quantum would never fill, and the caller would wait forever for
    // exactly the failure it is looking for.
    this.record(left, right);
    return true;
  }

  fill(left, right) {
    // Read the indices, copy one block, publish the new read index. No
    // allocation and no message.
    if (this.ringInts === null || this.ringSamples === null) {
      left.fill(0);
      right.fill(0);
      return;
    }
    const write = Atomics.load(this.ringInts, RING_SLOT.write);
    const read = Atomics.load(this.ringInts, RING_SLOT.read);
    if (write === read) {
      this.underruns += 1;
      left.fill(0);
      right.fill(0);
      return;
    }
    const block = this.ringSamples;
    const offset = (read % RING_BLOCKS) * AUDIO_BLOCK_SAMPLES;
    Atomics.store(this.ringInts, RING_SLOT.read, read + 1);

    const frames = Math.min(left.length, AUDIO_BLOCK_FRAMES);
    for (let frame = 0; frame < frames; frame += 1) {
      left[frame] = block[offset + frame * 2] / I16_FULL_SCALE;
      right[frame] = block[offset + frame * 2 + 1] / I16_FULL_SCALE;
    }
    // A host quantum longer than one Rack block leaves the tail silent rather
    // than repeating samples, which would be a rhythm this file invented.
    if (frames < left.length) {
      left.fill(0, frames);
      right.fill(0, frames);
    }
  }

  record(left, right) {
    const capture = this.capture;
    if (capture === null) return;
    const wanted = Math.min(left.length, capture.left.length - capture.frames);
    capture.left.set(left.subarray(0, wanted), capture.frames);
    capture.right.set(right.subarray(0, wanted), capture.frames);
    capture.frames += wanted;
    if (capture.frames < capture.left.length) return;
    this.capture = null;
    this.port.postMessage(
      {
        type: "capture",
        left: capture.left.buffer,
        right: capture.right.buffer,
        sampleRate,
        underruns: this.underruns - capture.underrunsAtStart,
      },
      [capture.left.buffer, capture.right.buffer],
    );
  }
}

registerProcessor("overture-rack-pcm", OvertureRackPcmProcessor);
