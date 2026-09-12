export function packetSchema(paths: readonly string[]): Record<string, unknown> {
  const declared = normalizePaths(paths);

  const fileProperties: Record<string, unknown> = Object.create(null);
  for (const path of declared) {
    fileProperties[path] = { type: "string" };
  }

  return {
    type: "object",
    additionalProperties: false,
    required: ["files", "note"],
    properties: {
      files: {
        type: "object",
        additionalProperties: false,
        required: declared.slice(),
        properties: fileProperties,
      },
      note: { type: "string" },
    },
  };
}

export function parsePacketResponse(
  value: unknown,
  paths: readonly string[],
): Record<string, string> {
  const declared = normalizePaths(paths);

  if (!isPlainObject(value)) {
    throw new TypeError("response must be a plain object");
  }

  let hasFiles = false;
  let hasNote = false;
  for (const key of Object.keys(value)) {
    if (key === "files") {
      hasFiles = true;
    } else if (key === "note") {
      hasNote = true;
    } else {
      throw new TypeError("response contains an unexpected key");
    }
  }
  if (!hasFiles || !hasNote) {
    throw new TypeError("response must contain exactly files and note");
  }

  const filesDescriptor = Object.getOwnPropertyDescriptor(value, "files");
  const filesValue = filesDescriptor ? filesDescriptor.value : undefined;
  if (!isPlainObject(filesValue)) {
    throw new TypeError("files must be a plain object");
  }

  const declaredSet = new Set(declared);
  const fileKeys = Object.keys(filesValue);
  for (const key of fileKeys) {
    if (!declaredSet.has(key)) {
      throw new TypeError("files contains an unexpected key");
    }
  }
  if (fileKeys.length !== declared.length) {
    throw new TypeError("files is missing one or more declared paths");
  }

  const noteDescriptor = Object.getOwnPropertyDescriptor(value, "note");
  const noteValue = noteDescriptor ? noteDescriptor.value : undefined;
  if (typeof noteValue !== "string") {
    throw new TypeError("note must be a string");
  }

  const result: Record<string, string> = Object.create(null);
  for (const path of declared) {
    const contentDescriptor = Object.getOwnPropertyDescriptor(filesValue, path);
    const content = contentDescriptor ? contentDescriptor.value : undefined;
    if (typeof content !== "string") {
      throw new TypeError("file content must be a string");
    }
    if (utf8ByteLength(content) > MAX_CONTENT_BYTES) {
      throw new RangeError("file content exceeds 2MiB when encoded as UTF-8");
    }
    result[path] = content;
  }

  return result;
}

const MAX_CONTENT_BYTES = 2 * 1024 * 1024;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function normalizePaths(paths: readonly string[]): readonly string[] {
  if (!Array.isArray(paths)) {
    throw new TypeError("paths must be an array");
  }
  if (paths.length === 0) {
    throw new RangeError("paths must not be empty");
  }

  const seen = new Set<string>();
  const result: string[] = [];
  for (let index = 0; index < paths.length; index += 1) {
    if (!Object.hasOwn(paths, index)) {
      throw new TypeError("paths must not be sparse");
    }
    const candidate = paths[index];
    if (typeof candidate !== "string") {
      throw new TypeError("each path must be a string");
    }
    if (candidate.trim().length === 0) {
      throw new TypeError("paths must not be blank");
    }
    if (seen.has(candidate)) {
      throw new TypeError("paths must not contain duplicates");
    }
    seen.add(candidate);
    result.push(candidate);
  }
  return result;
}

function utf8ByteLength(text: string): number {
  let bytes = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code < 0x80) {
      bytes += 1;
    } else if (code < 0x800) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else {
        bytes += 3;
      }
    } else {
      bytes += 3;
    }
  }
  return bytes;
}
