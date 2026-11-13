// Runs on the audio thread: forwards each 128-sample mic block to the main thread
registerProcessor('recorder', class extends AudioWorkletProcessor {
    process([input]) {
        if (input && input[0]) this.port.postMessage(input[0].slice());
        return true;
    }
});
