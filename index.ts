const fs = require('node:fs')

const frameSize = 2048;
const hopSize = 512;

function loadPcm(filePath: string): Float32Array {
    const buffer = fs.readFileSync(filePath);

    if (buffer.length % 4 !== 0) {
        throw new Error(
            'Invalid PCM file: byte length must be divisible by 4'
        );
    }

    const samples = new Float32Array(buffer.length / 4);

    for (let i = 0; i < samples.length; i++) {
        samples[i] = buffer.readFloatLE(i * 4);
    }

    return samples;
}

function createFramesUsingHann(
    pcm: Float32Array,
    frameSize: number,
    hopSize: number
): Float32Array[] {
    if (frameSize <= 0 || !Number.isInteger(frameSize)) {
        throw new Error('Frame size must be a positive integer');
    }

    if (hopSize <= 0 || !Number.isInteger(hopSize)) {
        throw new Error('Hop size must be a positive integer');
    }

    const frames: Float32Array[] = [];

    for (
        let start = 0;
        start + frameSize <= pcm.length;
        start += hopSize
    ) {
        const currentFrame = new Float32Array(frameSize);

        for (let j = 0; j < frameSize; j++) {
            // Hann window coefficient
            const hannCoefficient =
                (1 - Math.cos(
                    (2 * Math.PI * j) / (frameSize - 1)
                )) / 2;

            // Apply window directly while copying samples
            currentFrame[j] = pcm[start + j]! * hannCoefficient;
        }

        frames.push(currentFrame);
    }

    return frames;
}

function prepareFFT(frame: Float32Array): {
    real: Float64Array;
    imaginary: Float64Array;
} {
    return {
        real: new Float64Array(frame),
        imaginary: new Float64Array(frame.length)
    };
}

function reverseBits(index: number, bitCount: number): number {
    let reversed = 0;

    for (let i = 0; i < bitCount; i++) {
        reversed = (reversed << 1) | (index & 1);
        index >>= 1;
    }

    return reversed;
}

function bitReverse(
    real: Float64Array,
    imaginary: Float64Array
): void {
    const size = real.length;

    if (size !== imaginary.length) {
        throw new Error('Real and imaginary arrays must have equal lengths');
    }

    if (size < 2 || !Number.isInteger(Math.log2(size))) {
        throw new Error('FFT size must be a power of 2 and at least 2');
    }

    const bitCount = Math.log2(size);

    for (let i = 0; i < size; i++) {
        const reversedIndex = reverseBits(i, bitCount);

        if (reversedIndex > i) {
            [real[i], real[reversedIndex]] =
                [real[reversedIndex]!, real[i]!];

            [imaginary[i], imaginary[reversedIndex]] =
                [imaginary[reversedIndex]!, imaginary[i]!];
        }
    }
}

// Execution

const pcm = loadPcm('./assets/output/test.pcm');

console.log('PCM samples:', pcm.length);

const frames = createFramesUsingHann(
    pcm,
    frameSize,
    hopSize
);

console.log('Total frames:', frames.length);

// Prepare first frame for FFT
if (frames.length > 0) {
    const { real, imaginary } = prepareFFT(frames[0]!);

    bitReverse(real, imaginary);

    console.log('FFT input prepared:', real.length);
}
