import { Mp3Encoder } from "@breezystack/lamejs";

/**
 * Browser-side MP3 clip encoder. Cyanite similarity only needs a
 * representative slice, and the Next.js proxy caps request bodies at 10MB —
 * so we send a centered 60s mono 128kbps MP3 (~1MB) instead of the raw WAV.
 */
const CLIP_SECONDS = 60;
const SAMPLE_RATE = 44100;
const BITRATE_KBPS = 128;

export async function encodeClipMp3(file: File): Promise<Blob> {
  const decodeContext = new AudioContext();
  let audioBuffer: AudioBuffer;
  try {
    audioBuffer = await decodeContext.decodeAudioData(await file.arrayBuffer());
  } finally {
    await decodeContext.close();
  }

  const clipLength = Math.min(
    audioBuffer.length,
    Math.floor(CLIP_SECONDS * audioBuffer.sampleRate),
  );
  const clipStart = Math.floor((audioBuffer.length - clipLength) / 2);

  // OfflineAudioContext resamples to 44.1k and mixes down in one render pass.
  const offline = new OfflineAudioContext(
    1,
    Math.ceil((clipLength / audioBuffer.sampleRate) * SAMPLE_RATE),
    SAMPLE_RATE,
  );
  const source = offline.createBufferSource();
  source.buffer = audioBuffer;
  source.connect(offline.destination);
  source.start(0, clipStart / audioBuffer.sampleRate, clipLength / audioBuffer.sampleRate);
  const rendered = await offline.startRendering();

  return encodeMonoMp3(rendered.getChannelData(0));
}

function encodeMonoMp3(samples: Float32Array): Blob {
  const encoder = new Mp3Encoder(1, SAMPLE_RATE, BITRATE_KBPS);
  const pcm = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }

  const blockSize = 1152;
  const parts: BlobPart[] = [];
  for (let i = 0; i < pcm.length; i += blockSize) {
    const chunk = encoder.encodeBuffer(
      pcm.subarray(i, Math.min(i + blockSize, pcm.length)),
    );
    if (chunk.length > 0) parts.push(new Uint8Array(chunk));
  }
  const flush = encoder.flush();
  if (flush.length > 0) parts.push(new Uint8Array(flush));

  return new Blob(parts, { type: "audio/mpeg" });
}
