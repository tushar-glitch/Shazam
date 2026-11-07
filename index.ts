    const fs = require('node:fs')

    const frameSize = 2048;
    const hopSize = 512;

    function loadPcm(filePath: string): Float32Array {
    const buffer = fs.readFileSync(filePath);

    if (buffer.length % 4 !== 0) {
        throw new Error("Invalid PCM file: byte length must be divisible by 4");
    }

    const samples = new Float32Array(buffer.length / 4);

    for (let i = 0; i < samples.length; i++) {
        samples[i] = buffer.readFloatLE(i * 4);
    }

    return samples;
    }

    function createFrames(pcm: Float32Array, frameSize: number, hopSize: number) : Float32Array[]{
        var frame: Float32Array[] = []
        const totalSampleSize = pcm.length
        for(let i=0;i<=totalSampleSize - frameSize;i+=hopSize){
            const currentFrame = new Float32Array(frameSize);
            for(let j=i;j<=i+frameSize;++j) currentFrame[j-i] = pcm[j]!;
            frame.push(currentFrame)
        }
        return frame
    }

    const res = loadPcm('./assets/output/test.pcm')
    console.log('Sample', res.length)

    const res2 = createFrames(res, frameSize, hopSize)
    console.log('Sample2', res2.length)