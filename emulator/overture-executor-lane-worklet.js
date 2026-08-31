import { ACK_TAGS } from "./generated/executor-wire.js";

// Production emulator lane: one AudioWorkletProcessor hosts the Rust executor
// adapter, an optional Moveforge MIDI-FX module, and a Moveforge synth module,
// so a due note reaches the synth inside the same render turn without any
// main-thread hop.
//
// This file interprets no time of its own. It hands the host's actual render
// quantum to Rust and forwards exactly what Rust emitted, in order.
//
// The node is constructed by the main thread with `numberOfInputs: 0`,
// `numberOfOutputs: 1` and `outputChannelCount: [2]`; everything else the lane
// does is driven by `port.onmessage`.

const AUDIO_BLOCK_FRAMES = 128;
const MIDI_FX_MAX_MESSAGES = 32;

// The adapter handle this lane addresses. One worklet is one WASM instance is
// one Executor Destination, so a lane never needs a second one. The Rack build
// of the same adapter carries four, because its four Chains are fed by the
// executor inside the one instance that holds the Rack.
const ADAPTER = 0;
const MAXIMUM_BLOCK_ACTIONS = 1536;
const MAXIMUM_CAPTURE_ACTIONS = 4096;
const MAXIMUM_CAPTURE_SAMPLES = 4194304;
const COMMAND_CAPACITY_EXCEEDED = ACK_TAGS["fragment-oversized"];
const UNSIGNED_32_SCALE = 0x1_0000_0000;

const BYTE_MASK = 0xffn;
const CHANNEL_SHIFT = 8n;
const NOTE_SHIFT = 16n;
const VELOCITY_SHIFT = 24n;

const ACTION_FIELD_PACKED = 0;
const ACTION_FIELD_DUE_FRAME = 1;

const NOTE_ON_KIND = 1;
const NOTE_ON_STATUS = 0x90;
const NOTE_OFF_STATUS = 0x80;

// `OVS1` puts the executor's frame after the magic, the outcome byte, the u64
// cursor, and the u128 incarnation. The Rust `encode_status` writer owns that
// layout.
const STATUS_FRAME_OFFSET = 29;
const STATUS_FRAME_END = STATUS_FRAME_OFFSET + 8;

function statusPageFrame(bytes) {
  if (bytes.byteLength < STATUS_FRAME_END) return 0;
  return Number(
    new DataView(bytes.buffer, bytes.byteOffset).getBigUint64(
      STATUS_FRAME_OFFSET,
      true,
    ),
  );
}

class OvertureExecutorLaneProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.adapter = null;
    this.capture = null;
    this.commandQueue = [];
    this.commandSubmitted = false;
    this.cueOutput = null;
    this.deliveredActionCount = 0;
    this.destroyed = false;
    this.errored = false;
    this.executorFrame = 0;
    this.fx = null;
    this.loading = false;
    this.ready = false;
    this.statusRequest = 0;
    this.synth = null;

    this.port.onmessage = (event) => this.onMessage(event.data);
  }

  // --- inbound messages -----------------------------------------------------

  onMessage(message) {
    if (this.errored) return;
    try {
      if (message?.type === "load") {
        if (this.loading || this.ready || this.destroyed) return;
        this.loading = true;
        void this.load(message);
        return;
      }
      if (!this.ready || this.destroyed) return;
      switch (message?.type) {
        case "command":
          this.enqueueCommand(message);
          return;
        case "status":
          this.requestStatus(message.after ?? null);
          return;
        case "configure":
          this.configure(message.configuration);
          return;
        case "restart":
          this.restart(message);
          return;
        case "destroy":
          this.destroy();
          return;
        case "midiIn":
          this.deliverMidi(
            Number(message.status) & 0xff,
            Number(message.d1) & 0x7f,
            Number(message.d2) & 0x7f,
          );
          return;
        case "setParam":
          this.setParam(message);
          return;
        case "capture":
          this.beginCapture(message);
          return;
        default:
          return;
      }
    } catch (error) {
      this.fail(error);
    }
  }

  async load(message) {
    try {
      const adapter = await WebAssembly.instantiate(message.executor, {});
      const synth = message.synth
        ? await WebAssembly.instantiate(message.synth, {})
        : null;
      const fx = message.midiFx
        ? await WebAssembly.instantiate(message.midiFx, {})
        : null;

      this.adapter = adapter.instance.exports;
      const nonce = message.nonce;
      if (
        !Array.isArray(nonce) ||
        nonce.length !== 4 ||
        this.adapter.overture_adapter_create(ADAPTER, ...nonce) !== 0
      ) {
        throw new Error("invalid executor incarnation");
      }
      this.configure(message.configuration);
      this.synth = synth ? this.loadSynth(synth.instance.exports) : null;
      this.cueOutput = null;
      this.fx = fx ? this.loadMidiFx(fx.instance.exports) : null;

      this.ready = true;
      this.port.postMessage({
        type: "ready",
        sampleRate,
        hasMidiFx: this.fx !== null,
        startFrame: currentFrame,
      });
    } catch (error) {
      this.fail(error);
    }
  }

  loadSynth(exports) {
    exports.sch_init();
    const memory = exports.memory.buffer;
    return {
      exports,
      keyBuffer: new Uint8Array(
        memory,
        exports.sch_key_buf(),
        exports.sch_key_buf_size(),
      ),
      left: new Float32Array(
        memory,
        exports.sch_left_ptr(),
        AUDIO_BLOCK_FRAMES,
      ),
      right: new Float32Array(
        memory,
        exports.sch_right_ptr(),
        AUDIO_BLOCK_FRAMES,
      ),
      valueBuffer: new Uint8Array(
        memory,
        exports.sch_val_buf(),
        exports.sch_val_buf_size(),
      ),
    };
  }

  loadCueOutput() {
    const length = this.adapter.overture_adapter_cue_output_len(ADAPTER);
    if (length !== AUDIO_BLOCK_FRAMES * 2) {
      throw new Error(`unexpected cue output length: ${length}`);
    }
    return new Int16Array(
      this.adapter.memory.buffer,
      this.adapter.overture_adapter_cue_output_ptr(ADAPTER),
      length,
    );
  }

  loadMidiFx(exports) {
    exports.mf_init();
    const memory = exports.memory.buffer;
    return {
      exports,
      keyBuffer: new Uint8Array(
        memory,
        exports.mf_key_buf(),
        exports.mf_key_buf_size(),
      ),
      output: new Uint8Array(
        memory,
        exports.mf_out_buf_ptr(),
        exports.mf_out_buf_size(),
      ),
      valueBuffer: new Uint8Array(
        memory,
        exports.mf_val_buf(),
        exports.mf_val_buf_size(),
      ),
    };
  }

  configure(configuration) {
    const result = this.adapter.overture_adapter_configure(
      ADAPTER,
      configuration.kind,
      configuration.index,
      configuration.revision,
      configuration.latencyProfile,
      configuration.channel,
      configuration.latencyFrames,
      configuration.ready ? 1 : 0,
    );
    if (result !== 0) throw new Error("invalid executor configuration");
  }

  restart(message) {
    const nonce = message.nonce;
    if (
      !Array.isArray(nonce) ||
      nonce.length !== 4 ||
      this.adapter.overture_adapter_create(ADAPTER, ...nonce) !== 0
    ) {
      throw new Error("invalid replacement executor incarnation");
    }
    this.configure(message.configuration);
    this.commandQueue.length = 0;
    this.commandSubmitted = false;
    this.statusRequest = 0;
    this.port.postMessage({ type: "restarted" });
  }

  destroy() {
    this.adapter.overture_adapter_destroy(ADAPTER);
    this.destroyed = true;
    this.ready = false;
    this.statusRequest = 0;
    this.capture = null;
    this.cueOutput = null;
    this.commandQueue.length = 0;
    this.commandSubmitted = false;
    this.port.postMessage({ type: "destroyed" });
  }

  enqueueCommand(message) {
    this.commandQueue.push(message);
    this.flushCommandQueue();
  }

  flushCommandQueue() {
    if (this.commandSubmitted) return;
    const message = this.commandQueue.shift();
    if (message === undefined) return;
    this.commandSubmitted = true;
    const command = new Uint8Array(message.command);
    if (command.byteLength > this.adapter.overture_adapter_command_capacity()) {
      this.port.postMessage({
        type: "ack",
        publication: message.publication,
        code: COMMAND_CAPACITY_EXCEEDED,
        operation: 0,
      });
      return;
    }
    new Uint8Array(
      this.adapter.memory.buffer,
      this.adapter.overture_adapter_command_ptr(ADAPTER),
      command.byteLength,
    ).set(command);
    const code = this.adapter.overture_adapter_submit(
      ADAPTER,
      message.publication >>> 0,
      Math.floor(message.publication / UNSIGNED_32_SCALE) >>> 0,
      command.byteLength,
    );
    this.port.postMessage({
      type: "ack",
      publication: message.publication,
      code,
      operationLow: this.adapter.overture_adapter_ack_operation_low(ADAPTER),
      operationHigh: this.adapter.overture_adapter_ack_operation_high(ADAPTER),
    });
  }

  requestStatus(after) {
    this.statusRequest = this.adapter.overture_adapter_request_status(
      ADAPTER,
      after === null ? 0 : 1,
      after === null ? 0 : after.low >>> 0,
      after === null ? 0 : after.high >>> 0,
    );
  }

  setParam(message) {
    const component = message.component === "midiFx" ? this.fx : this.synth;
    if (!component) return;
    this.writeCString(component.keyBuffer, message.key);
    this.writeCString(component.valueBuffer, message.value);
    if (message.component === "midiFx") component.exports.mf_set_param();
    else component.exports.sch_set_param();
  }

  writeCString(buffer, value) {
    if (!buffer) return;
    const text = String(value);
    const limit = buffer.length - 1;
    let written = 0;
    for (let index = 0; index < text.length && written < limit; index += 1) {
      const code = text.charCodeAt(index);
      buffer[written] = code < 0x80 ? code : 0x3f;
      written += 1;
    }
    buffer[written] = 0;
  }

  beginCapture(message) {
    if (this.capture) {
      this.port.postMessage({
        type: "error",
        message: "capture already running",
      });
      return;
    }
    const blockCount = Number(message.blocks);
    if (
      !Number.isInteger(blockCount) ||
      blockCount <= 0 ||
      blockCount * AUDIO_BLOCK_FRAMES > MAXIMUM_CAPTURE_SAMPLES
    ) {
      this.port.postMessage({
        type: "error",
        message: `unsupported capture length: ${message.blocks}`,
      });
      return;
    }
    this.capture = {
      blockCount,
      blocksWritten: 0,
      left: new Float32Array(blockCount * AUDIO_BLOCK_FRAMES),
      right: new Float32Array(blockCount * AUDIO_BLOCK_FRAMES),
      // What the executor delivered while the capture ran, in order. Audio
      // proves the chain sounded; this is the logical trace, taken from the
      // executor itself rather than recovered from the waveform. Bounded so a
      // dense Pattern cannot allocate without limit on the audio thread.
      actions: [],
      actionsTruncated: false,
      startFrame: 0,
    };
  }

  // --- due path -------------------------------------------------------------

  recordCapturedAction(packed, dueFrame) {
    const capture = this.capture;
    if (!capture) return;
    if (capture.actions.length >= MAXIMUM_CAPTURE_ACTIONS) {
      capture.actionsTruncated = true;
      return;
    }
    capture.actions.push({
      dueFrame,
      kind: Number(packed & BYTE_MASK),
      note: Number((packed >> NOTE_SHIFT) & BYTE_MASK),
      velocity: Number((packed >> VELOCITY_SHIFT) & BYTE_MASK),
    });
  }

  deliverPackedAction(packed) {
    const kind = Number(packed & BYTE_MASK);
    const channel = Number((packed >> CHANNEL_SHIFT) & BYTE_MASK);
    const note = Number((packed >> NOTE_SHIFT) & BYTE_MASK);
    const velocity = Number((packed >> VELOCITY_SHIFT) & BYTE_MASK);
    this.deliverMidi(
      (kind === NOTE_ON_KIND ? NOTE_ON_STATUS : NOTE_OFF_STATUS) |
        (channel & 0x0f),
      note,
      velocity,
    );
  }

  deliverMidi(status, data1, data2) {
    if (!this.synth) return;
    if (!this.fx) {
      this.synth.exports.sch_midi(status, data1, data2);
      return;
    }
    this.forwardMidiFxOutput(
      this.fx.exports.mf_process_midi_byte(status, data1, data2),
    );
  }

  forwardMidiFxOutput(count) {
    if (count < 0 || count > MIDI_FX_MAX_MESSAGES) {
      throw new Error(`MIDI FX output overflow: ${count}`);
    }
    for (let index = 0; index < count; index += 1) {
      const offset = index * 3;
      this.synth.exports.sch_midi(
        this.fx.output[offset],
        this.fx.output[offset + 1],
        this.fx.output[offset + 2],
      );
    }
  }

  process(_inputs, outputs) {
    const output = outputs[0];
    if (!output || output.length < 2) return true;
    if (!this.ready || this.destroyed || this.errored) {
      output[0].fill(0);
      output[1].fill(0);
      return true;
    }

    try {
      const frames = output[0].length;
      if (frames !== AUDIO_BLOCK_FRAMES) {
        throw new Error(`unexpected render quantum: ${frames}`);
      }
      if (this.adapter.overture_adapter_process(ADAPTER, frames) !== 0) {
        throw new Error("executor block failed");
      }
      this.commandSubmitted = false;
      this.flushCommandQueue();

      const actionCount = this.adapter.overture_adapter_action_count(ADAPTER);
      if (actionCount > MAXIMUM_BLOCK_ACTIONS) {
        throw new Error(`executor action overflow: ${actionCount}`);
      }
      for (let index = 0; index < actionCount; index += 1) {
        const packed = this.adapter.overture_adapter_action(
          ADAPTER,
          index,
          ACTION_FIELD_PACKED,
        );
        this.deliverPackedAction(packed);
        this.executorFrame = Number(
          this.adapter.overture_adapter_action(
            ADAPTER,
            index,
            ACTION_FIELD_DUE_FRAME,
          ),
        );
        this.deliveredActionCount += 1;
        this.recordCapturedAction(packed, this.executorFrame);
      }
      if (this.fx) {
        this.forwardMidiFxOutput(this.fx.exports.mf_tick(frames));
      }

      if (this.synth) {
        this.synth.exports.sch_render(frames);
        output[0].set(this.synth.left);
        output[1].set(this.synth.right);
      } else {
        this.cueOutput ??= this.loadCueOutput();
        for (let index = 0; index < frames; index += 1) {
          output[0][index] = this.cueOutput[index * 2] / 32768;
          output[1][index] = this.cueOutput[index * 2 + 1] / 32768;
        }
      }

      const capture = this.capture;
      if (capture) {
        if (capture.blocksWritten === 0) capture.startFrame = currentFrame;
        const offset = capture.blocksWritten * AUDIO_BLOCK_FRAMES;
        capture.left.set(output[0], offset);
        capture.right.set(output[1], offset);
        capture.blocksWritten += 1;
        if (capture.blocksWritten === capture.blockCount) {
          this.capture = null;
          const left = capture.left.buffer;
          const right = capture.right.buffer;
          this.port.postMessage(
            {
              type: "capture",
              left,
              right,
              startFrame: capture.startFrame,
              blockCount: capture.blockCount,
              sampleRate,
              deliveredActionCount: this.deliveredActionCount,
              executorFrame: this.executorFrame,
              actions: capture.actions,
              actionsTruncated: capture.actionsTruncated,
            },
            [left, right],
          );
        }
      }

      if (
        this.statusRequest !== 0 &&
        this.adapter.overture_adapter_status_ready(ADAPTER) ===
          this.statusRequest
      ) {
        const bytes = new Uint8Array(
          this.adapter.memory.buffer,
          this.adapter.overture_adapter_status_ptr(ADAPTER),
          this.adapter.overture_adapter_status_len(ADAPTER),
        ).slice();
        const request = this.statusRequest;
        this.statusRequest = 0;
        // The page's own frame and the render turn that produced it, read
        // together. Their difference is the only thing that lets the main
        // thread anchor an executor frame on the audio clock instead of on
        // when this message happened to be delivered.
        this.port.postMessage(
          {
            type: "status",
            request,
            bytes: bytes.buffer,
            executorFrame: statusPageFrame(bytes),
            workletFrame: currentFrame + frames,
          },
          [bytes.buffer],
        );
      }
    } catch (error) {
      output[0].fill(0);
      output[1].fill(0);
      this.fail(error);
    }
    return true;
  }

  fail(error) {
    if (this.errored) return;
    this.errored = true;
    this.capture = null;
    this.statusRequest = 0;
    this.port.postMessage({
      type: "error",
      message: String(error?.message ?? error),
    });
  }
}

registerProcessor("overture-executor-lane", OvertureExecutorLaneProcessor);
