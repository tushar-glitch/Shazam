// Iterative radix-2 Fast Fourier Transform: turns a slice of sound into the
// strength of each frequency in it. Works in place on real + imaginary arrays.
export class FFT {
    // Per FFT size: bit-reversed order + twiddles for every stage. They depend only on the
    // size, so they are computed once (with the same formulas, so results are unchanged).
    private static readonly tables = new Map<number, { reversed: Uint32Array; cos: Float64Array[]; sin: Float64Array[] }>();

    static transform(real: Float64Array, imaginary: Float64Array): void {
        const size = real.length;

        if (size !== imaginary.length) {
            throw new Error('Real and imaginary arrays must have equal lengths');
        }
        if (size < 2 || !Number.isInteger(Math.log2(size))) {
            throw new Error('FFT size must be a power of 2 and at least 2');
        }

        const { reversed, cos, sin } = FFT.tablesFor(size);

        // Rearrange input into bit-reversed order
        for (let i = 0; i < size; i++) {
            const r = reversed[i]!;
            if (r > i) {
                const tr = real[i]!; real[i] = real[r]!; real[r] = tr;
                const ti = imaginary[i]!; imaginary[i] = imaginary[r]!; imaginary[r] = ti;
            }
        }

        for (let stage = 0, stageSize = 2; stageSize <= size; stage++, stageSize *= 2) {
            const halfSize = stageSize / 2;
            const stageCos = cos[stage]!, stageSin = sin[stage]!;

            for (let k = 0; k < halfSize; k++) {
                const wr = stageCos[k]!;
                const wi = stageSin[k]!;

                for (let i = k; i < size; i += stageSize) {
                    const j = i + halfSize;

                    // W * B
                    const tr = wr * real[j]! - wi * imaginary[j]!;
                    const ti = wr * imaginary[j]! + wi * real[j]!;
                    const ar = real[i]!;
                    const ai = imaginary[i]!;

                    real[i] = ar + tr;      // A + W*B
                    imaginary[i] = ai + ti;
                    real[j] = ar - tr;      // A - W*B
                    imaginary[j] = ai - ti;
                }
            }
        }
    }

    private static tablesFor(size: number) {
        let tables = FFT.tables.get(size);
        if (!tables) {
            const bitCount = Math.log2(size);
            const reversed = Uint32Array.from({ length: size }, (_, i) => FFT.reverseBits(i, bitCount));
            const cos: Float64Array[] = [], sin: Float64Array[] = [];
            for (let stageSize = 2; stageSize <= size; stageSize *= 2) {
                const angle = -2 * Math.PI / stageSize;
                cos.push(Float64Array.from({ length: stageSize / 2 }, (_, k) => Math.cos(angle * k)));
                sin.push(Float64Array.from({ length: stageSize / 2 }, (_, k) => Math.sin(angle * k)));
            }
            tables = { reversed, cos, sin };
            FFT.tables.set(size, tables);
        }
        return tables;
    }

    private static reverseBits(index: number, bitCount: number): number {
        let reversed = 0;
        for (let i = 0; i < bitCount; i++) {
            reversed = (reversed << 1) | (index & 1);
            index >>= 1;
        }
        return reversed;
    }
}
