import childProcess from 'node:child_process';
import { engineConfig } from '../engine/index.js';

// Decodes any audio file (mp3, m4a, wav, ...) to mono float32 PCM via ffmpeg
export class AudioDecoder {
    static decode(filePath: string): Float32Array {
        const result = childProcess.spawnSync(
            'ffmpeg',
            ['-loglevel', 'error', '-i', filePath, '-ac', '1', '-ar', String(engineConfig.sampleRate), '-f', 'f32le', '-'],
            { maxBuffer: 1 << 30 }
        );

        if (result.error) throw result.error;
        if (result.status !== 0) throw new Error(`ffmpeg failed: ${result.stderr.toString()}`);

        const out = result.stdout;
        return new Float32Array(out.buffer.slice(out.byteOffset, out.byteOffset + out.length));
    }
}
