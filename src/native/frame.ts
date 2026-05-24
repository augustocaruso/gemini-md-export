const MAX_NATIVE_FRAME_BYTES = 16 * 1024 * 1024;

export const encodeNativeFrame = (message: unknown): Buffer<ArrayBufferLike> => {
  const payload = Buffer.from(JSON.stringify(message), 'utf-8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(payload.length, 0);
  return Buffer.concat([header, payload]);
};

export const decodeNativeFrameBuffer = (
  buffer: Buffer<ArrayBufferLike>,
): { messages: unknown[]; remaining: Buffer<ArrayBufferLike> } => {
  const messages: unknown[] = [];
  let offset = 0;
  while (buffer.length - offset >= 4) {
    const length = buffer.readUInt32LE(offset);
    if (length > MAX_NATIVE_FRAME_BYTES) {
      throw new Error(`Native Messaging frame too large: ${length} bytes`);
    }
    if (buffer.length - offset < 4 + length) break;
    const payload = buffer.subarray(offset + 4, offset + 4 + length);
    messages.push(JSON.parse(payload.toString('utf-8')));
    offset += 4 + length;
  }
  return { messages, remaining: buffer.subarray(offset) };
};
