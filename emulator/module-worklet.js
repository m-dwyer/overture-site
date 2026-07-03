class ModuleProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ready = false;
    this.exports = null;
    this.mode = null;
    this.inLeft = null;
    this.inRight = null;
    this.left = null;
    this.right = null;
    this.keyBuf = null;
    this.valBuf = null;
    this.outBuf = null;
    this.queue = [];

    this.port.onmessage = (event) => {
      if (event.data?.type === "loadWasm") {
        this.load(event.data.bytes);
        return;
      }
      if (!this.ready) {
        this.queue.push(event.data);
        return;
      }
      this.handle(event.data);
    };
  }

  async load(bytes) {
    try {
      const module = await WebAssembly.instantiate(bytes, {});
      this.exports = module.instance.exports;
      const memory = this.exports.memory.buffer;

      this.ready = false;
      this.left = this.right = this.inLeft = this.inRight = null;
      this.keyBuf = this.valBuf = this.outBuf = null;

      if (typeof this.exports.mf_init === "function") {
        this.mode = "midi_fx";
        this.exports.mf_init();
        this.keyBuf = new Uint8Array(
          memory,
          this.exports.mf_key_buf(),
          this.exports.mf_key_buf_size(),
        );
        this.valBuf = new Uint8Array(
          memory,
          this.exports.mf_val_buf(),
          this.exports.mf_val_buf_size(),
        );
        this.outBuf = new Uint8Array(
          memory,
          this.exports.mf_out_buf_ptr(),
          this.exports.mf_out_buf_size(),
        );
      } else if (typeof this.exports.sch_init === "function") {
        this.mode = "audio";
        this.exports.sch_init();
        this.left = new Float32Array(memory, this.exports.sch_left_ptr(), 128);
        this.right = new Float32Array(
          memory,
          this.exports.sch_right_ptr(),
          128,
        );
        this.inLeft = new Float32Array(
          memory,
          this.exports.sch_in_left_ptr(),
          128,
        );
        this.inRight = new Float32Array(
          memory,
          this.exports.sch_in_right_ptr(),
          128,
        );
        this.keyBuf = new Uint8Array(
          memory,
          this.exports.sch_key_buf(),
          this.exports.sch_key_buf_size(),
        );
        this.valBuf = new Uint8Array(
          memory,
          this.exports.sch_val_buf(),
          this.exports.sch_val_buf_size(),
        );
      } else {
        throw new Error("WASM exports neither sch_init nor mf_init");
      }

      this.ready = true;
      this.queue.splice(0).forEach((message) => this.handle(message));
      this.port.postMessage({ type: "ready", mode: this.mode });
    } catch (error) {
      this.port.postMessage({
        type: "error",
        message: String(error?.message || error),
      });
    }
  }

  writeCString(buf, value) {
    if (!buf) return;
    const s = String(value);
    const max = buf.length - 1;
    let n = 0;
    for (let i = 0; i < s.length && n < max; i++) {
      const code = s.charCodeAt(i);
      buf[n++] = code < 0x80 ? code : 0x3f;
    }
    buf[n] = 0;
  }

  emitOutgoingMidi(count) {
    if (!count || !this.outBuf) return;
    const max = Math.min(count, Math.floor(this.outBuf.length / 3));
    for (let i = 0; i < max; i++) {
      this.port.postMessage({
        type: "midiOut",
        status: this.outBuf[i * 3],
        d1: this.outBuf[i * 3 + 1],
        d2: this.outBuf[i * 3 + 2],
      });
    }
  }

  handle(message) {
    if (!message || !this.exports) return;
    if (message.type === "reset") {
      this.resetInstance();
      return;
    }
    if (this.mode === "midi_fx") {
      if (message.type === "param") {
        if (typeof message.key !== "string") return;
        this.writeCString(this.keyBuf, message.key);
        this.writeCString(this.valBuf, Number(message.value).toFixed(6));
        this.exports.mf_set_param();
      } else if (message.type === "midiIn") {
        const n = this.exports.mf_process_midi_byte(
          Number(message.status) & 0xff,
          Number(message.d1) & 0x7f,
          Number(message.d2) & 0x7f,
        );
        this.emitOutgoingMidi(n);
      }
      return;
    }

    if (message.type === "param") {
      if (typeof message.key !== "string") return;
      this.writeCString(this.keyBuf, message.key);
      this.writeCString(this.valBuf, Number(message.value).toFixed(6));
      this.exports.sch_set_param();
    } else if (message.type === "midiIn") {
      this.exports.sch_midi(
        Number(message.status) & 0xff,
        Number(message.d1) & 0x7f,
        Number(message.d2) & 0x7f,
      );
    } else if (message.type === "allNotesOff") {
      this.writeCString(this.keyBuf, "all_notes_off");
      this.writeCString(this.valBuf, "1");
      this.exports.sch_set_param();
    }
  }

  resetInstance() {
    if (!this.exports || !this.mode) return;
    try {
      if (this.mode === "midi_fx") this.exports.mf_init();
      else this.exports.sch_init();
      this.port.postMessage({ type: "ready", mode: this.mode });
    } catch (error) {
      this.port.postMessage({
        type: "error",
        message: String(error?.message || error),
      });
    }
  }

  process(inputs, outputs) {
    const output = outputs[0];
    if (!output || output.length < 2) return true;
    const frames = output[0].length;

    if (this.mode === "midi_fx") {
      output[0].fill(0);
      output[1].fill(0);
      if (this.ready) this.emitOutgoingMidi(this.exports.mf_tick(frames));
      return true;
    }

    if (!this.ready) {
      output[0].fill(0);
      output[1].fill(0);
      return true;
    }

    const input = inputs[0];
    if (input && input.length >= 1) {
      this.inLeft.set(input[0].subarray(0, frames));
      this.inRight.set(
        input.length > 1
          ? input[1].subarray(0, frames)
          : input[0].subarray(0, frames),
      );
    } else {
      this.inLeft.fill(0);
      this.inRight.fill(0);
    }

    this.exports.sch_render(frames);
    output[0].set(this.left.subarray(0, frames));
    output[1].set(this.right.subarray(0, frames));
    return true;
  }
}

registerProcessor("module-processor", ModuleProcessor);
