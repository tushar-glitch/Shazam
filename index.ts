const fs = require('node:fs')
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

const res = loadPcm('./assets/output/test.pcm')
console.log('Sample', res.length)