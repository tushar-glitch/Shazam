import { engineConfig } from '../engine/index.js';

// Opens the mic, resamples it to the engine's sample rate, and streams raw samples
export class Microphone {
    private stream: MediaStream | undefined;
    private context: AudioContext | undefined;

    async start(onSamples: (samples: Float32Array) => void): Promise<void> {
        // Voice-call processing (echo cancellation etc.) destroys music, so turn it off
        this.stream = await navigator.mediaDevices.getUserMedia({
            audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
        });

        // The browser resamples the mic to 11025 Hz for us
        this.context = new AudioContext({ sampleRate: engineConfig.sampleRate });
        await this.context.audioWorklet.addModule('/frontend/worklet.js');

        const recorder = new AudioWorkletNode(this.context, 'recorder');
        recorder.port.onmessage = (event: MessageEvent<Float32Array>) => onSamples(event.data);

        // The worklet writes no output, so this plays silence; it only keeps the graph running
        this.context.createMediaStreamSource(this.stream).connect(recorder).connect(this.context.destination);
    }

    // Safe to call even if start() failed half-way
    async stop(): Promise<void> {
        this.stream?.getTracks().forEach(track => track.stop());
        await this.context?.close();
        this.stream = undefined;
        this.context = undefined;
    }
}
