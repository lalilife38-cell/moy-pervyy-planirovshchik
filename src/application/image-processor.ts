import { LIMITS } from "../domain/constants";
import type { DraftImage } from "../domain/types";
import { UserInputError } from "./profile-service";

export interface DecodedImage {
  width: number;
  height: number;
  close(): void;
  source: CanvasImageSource;
}

export interface ImageRuntime {
  decode(blob: Blob): Promise<DecodedImage>;
  encode(image: DecodedImage, width: number, height: number, mimeType: "image/jpeg" | "image/webp", quality: number): Promise<Blob>;
}

type ImageDecoder = (blob: Blob, options: ImageBitmapOptions) => Promise<ImageBitmap>;

export async function decodeImageWithOrientation(
  blob: Blob,
  decoder: ImageDecoder = createImageBitmap,
): Promise<DecodedImage> {
  const bitmap = await decoder(blob, { imageOrientation: "from-image" });
  return { width: bitmap.width, height: bitmap.height, source: bitmap, close: () => bitmap.close() };
}

export function targetImageSize(width: number, height: number, maximumSide = 1600): { width: number; height: number } {
  if (width <= 0 || height <= 0) throw new TypeError("Некорректный размер изображения.");
  const scale = Math.min(1, maximumSide / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

const browserRuntime: ImageRuntime = {
  async decode(blob) {
    if (!("createImageBitmap" in globalThis)) {
      throw new UserInputError("Этот браузер не поддерживает обработку фотографий.");
    }
    return decodeImageWithOrientation(blob);
  },
  async encode(image, width, height, mimeType, quality) {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) throw new UserInputError("Не удалось подготовить фотографию.");
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, width, height);
    context.drawImage(image.source, 0, 0, width, height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, mimeType, quality));
    if (!blob) throw new UserInputError("Не удалось сжать фотографию.");
    return blob;
  },
};

export async function processImage(file: Blob, runtime: ImageRuntime = browserRuntime): Promise<DraftImage> {
  if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) {
    throw new UserInputError("Поддерживаются только JPEG, PNG и WebP. GIF и другие файлы не добавлены.", "image");
  }
  const decoded = await runtime.decode(file);
  try {
    const size = targetImageSize(decoded.width, decoded.height);
    const mimeType: "image/jpeg" | "image/webp" = file.type === "image/webp" ? "image/webp" : "image/jpeg";
    for (const quality of [0.86, 0.76, 0.66, 0.56, 0.46, 0.36]) {
      const blob = await runtime.encode(decoded, size.width, size.height, mimeType, quality);
      if (blob.size <= LIMITS.imageBytesPerIdea) {
        return {
          blob,
          mimeType,
          width: size.width,
          height: size.height,
          savedAt: new Date().toISOString(),
        };
      }
    }
    throw new UserInputError("Не удалось сжать фотографию до 1 МБ. Выберите другое изображение.", "image");
  } finally {
    decoded.close();
  }
}
