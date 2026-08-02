type VideoCodecCapability = {
  mimeType: string;
};

export function preferVp8VideoCodec<T extends VideoCodecCapability>(
  codecs: readonly T[],
) {
  const vp8: T[] = [];
  const remaining: T[] = [];

  for (const codec of codecs) {
    if (codec.mimeType.toLowerCase() === "video/vp8") vp8.push(codec);
    else remaining.push(codec);
  }

  return [...vp8, ...remaining];
}
