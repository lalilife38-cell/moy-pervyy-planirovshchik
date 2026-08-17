import { describe, expect, it, vi } from "vitest";
import {
  decodeImageWithOrientation,
  processImage,
  targetImageSize,
  type DecodedImage,
  type ImageRuntime,
} from "../src/application/image-processor";

function runtimeWithEncodedSize(size: number): { runtime: ImageRuntime; decode: ReturnType<typeof vi.fn>; encode: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> } {
  const close = vi.fn();
  const image: DecodedImage = { width: 3200, height: 2400, source: {} as CanvasImageSource, close };
  const decode = vi.fn(async () => image);
  const encode = vi.fn(async (_image, _width, _height, mimeType: string) =>
    new Blob([new Uint8Array(size)], { type: mimeType }));
  return { runtime: { decode, encode }, decode, encode, close };
}

describe("обработка изображений", () => {
  it("просит браузер применить ориентацию из метаданных перед перекодированием", async () => {
    const close = vi.fn();
    const bitmap = { width: 1200, height: 1600, close } as unknown as ImageBitmap;
    const decoder = vi.fn(async () => bitmap);
    const source = new Blob(["orientation=6"], { type: "image/jpeg" });
    const decoded = await decodeImageWithOrientation(source, decoder);
    expect(decoder).toHaveBeenCalledWith(source, { imageOrientation: "from-image" });
    decoded.close();
    expect(close).toHaveBeenCalledOnce();
  });

  it("уменьшает большую сторону до 1600 пикселей", () => {
    expect(targetImageSize(3200, 2400)).toEqual({ width: 1600, height: 1200 });
    expect(targetImageSize(800, 600)).toEqual({ width: 800, height: 600 });
  });

  it.each([
    ["image/jpeg", "image/jpeg"],
    ["image/png", "image/jpeg"],
    ["image/webp", "image/webp"],
  ] as const)("принимает %s и выдаёт локально перекодированный %s", async (sourceType, resultType) => {
    const { runtime, encode, close } = runtimeWithEncodedSize(1000);
    const source = new Blob(["EXIF-private-original-data"], { type: sourceType });
    const result = await processImage(source, runtime);
    expect(result.mimeType).toBe(resultType);
    expect(result.blob).not.toBe(source);
    expect(result.blob.size).toBe(1000);
    expect(encode).toHaveBeenCalledWith(expect.anything(), 1600, 1200, resultType, 0.86);
    expect(close).toHaveBeenCalledOnce();
  });

  it("отклоняет GIF с понятным объяснением", async () => {
    const { runtime } = runtimeWithEncodedSize(1000);
    await expect(processImage(new Blob(["gif"], { type: "image/gif" }), runtime)).rejects.toThrow("JPEG, PNG и WebP");
  });

  it("подбирает качество и блокирует результат больше 1 МБ", async () => {
    const { runtime, encode, close } = runtimeWithEncodedSize(1024 * 1024 + 1);
    await expect(processImage(new Blob(["large"], { type: "image/jpeg" }), runtime)).rejects.toThrow("до 1 МБ");
    expect(encode).toHaveBeenCalledTimes(6);
    expect(close).toHaveBeenCalledOnce();
  });
});
