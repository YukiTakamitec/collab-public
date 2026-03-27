/**
 * Fixed-capacity circular byte buffer. Oldest data is silently
 * overwritten when the buffer is full. Snapshot returns a copy
 * of the live contents in write order.
 */
export class RingBuffer {
  private buf: Buffer;
  private head = 0; // next write position
  private filled = 0; // bytes currently stored (up to capacity)
  private total = 0; // lifetime bytes written

  constructor(private readonly capacity: number) {
    this.buf = Buffer.alloc(capacity);
  }

  get bytesWritten(): number {
    return this.total;
  }

  write(data: Buffer): void {
    const len = data.length;
    this.total += len;

    if (len >= this.capacity) {
      // Data larger than buffer — keep only the tail
      data.copy(this.buf, 0, len - this.capacity, len);
      this.head = 0;
      this.filled = this.capacity;
      return;
    }

    const spaceToEnd = this.capacity - this.head;

    if (len <= spaceToEnd) {
      data.copy(this.buf, this.head);
    } else {
      data.copy(this.buf, this.head, 0, spaceToEnd);
      data.copy(this.buf, 0, spaceToEnd);
    }

    this.head = (this.head + len) % this.capacity;
    this.filled = Math.min(this.filled + len, this.capacity);
  }

  /** Return a copy of buffered data in write order. */
  snapshot(): Buffer {
    if (this.filled === 0) return Buffer.alloc(0);

    if (this.filled < this.capacity) {
      // Haven't wrapped yet — data starts at 0
      return Buffer.from(this.buf.subarray(0, this.filled));
    }

    // Wrapped: oldest data starts at head, newest ends just before head
    const result = Buffer.alloc(this.capacity);
    const tailLen = this.capacity - this.head;
    this.buf.copy(result, 0, this.head, this.head + tailLen);
    this.buf.copy(result, tailLen, 0, this.head);
    return result;
  }

  clear(): void {
    this.head = 0;
    this.filled = 0;
  }
}
