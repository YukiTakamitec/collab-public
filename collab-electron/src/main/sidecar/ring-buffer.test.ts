import { describe, test, expect } from "bun:test";
import { RingBuffer } from "./ring-buffer";

describe("RingBuffer", () => {
  test("write and snapshot returns written data", () => {
    const buf = new RingBuffer(1024);
    buf.write(Buffer.from("hello world"));
    const snap = buf.snapshot();
    expect(snap.toString()).toBe("hello world");
  });

  test("snapshot returns empty buffer when nothing written", () => {
    const buf = new RingBuffer(1024);
    const snap = buf.snapshot();
    expect(snap.length).toBe(0);
  });

  test("wraps around when capacity exceeded", () => {
    const buf = new RingBuffer(10);
    buf.write(Buffer.from("abcdefgh")); // 8 bytes
    buf.write(Buffer.from("12345")); // 5 bytes, total 13 > 10
    const snap = buf.snapshot();
    // 13 bytes into 10-byte ring: oldest 3 bytes (abc) lost
    // Remaining: defgh12345
    expect(snap.length).toBe(10);
    expect(snap.toString()).toBe("defgh12345");
  });

  test("handles write exactly at capacity", () => {
    const buf = new RingBuffer(5);
    buf.write(Buffer.from("abcde"));
    const snap = buf.snapshot();
    expect(snap.toString()).toBe("abcde");
  });

  test("handles write larger than capacity", () => {
    const buf = new RingBuffer(5);
    buf.write(Buffer.from("abcdefghij"));
    const snap = buf.snapshot();
    // Only last 5 bytes survive
    expect(snap.toString()).toBe("fghij");
  });

  test("multiple small writes accumulate", () => {
    const buf = new RingBuffer(1024);
    buf.write(Buffer.from("aaa"));
    buf.write(Buffer.from("bbb"));
    buf.write(Buffer.from("ccc"));
    const snap = buf.snapshot();
    expect(snap.toString()).toBe("aaabbbccc");
  });

  test("clear resets buffer", () => {
    const buf = new RingBuffer(1024);
    buf.write(Buffer.from("data"));
    buf.clear();
    const snap = buf.snapshot();
    expect(snap.length).toBe(0);
  });

  test("bytesWritten tracks total", () => {
    const buf = new RingBuffer(10);
    buf.write(Buffer.from("abc"));
    buf.write(Buffer.from("def"));
    expect(buf.bytesWritten).toBe(6);
  });
});
