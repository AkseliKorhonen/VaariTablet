import { describe, expect, test } from "vitest";
import { preferVp8VideoCodec } from "./video-codecs";

describe("preferVp8VideoCodec", () => {
  test("moves VP8 ahead of other video codecs without mutating the capabilities", () => {
    const codecs = [
      { mimeType: "video/H264" },
      { mimeType: "video/rtx" },
      { mimeType: "video/VP8" },
      { mimeType: "video/VP9" },
    ];

    expect(preferVp8VideoCodec(codecs).map((codec) => codec.mimeType)).toEqual([
      "video/VP8",
      "video/H264",
      "video/rtx",
      "video/VP9",
    ]);
    expect(codecs[0]?.mimeType).toBe("video/H264");
  });

  test("preserves the original order when VP8 is unavailable", () => {
    const codecs = [
      { mimeType: "video/H264" },
      { mimeType: "video/VP9" },
    ];

    expect(preferVp8VideoCodec(codecs)).toEqual(codecs);
  });
});
