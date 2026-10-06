'use strict';

// 服务端媒体时长探测：不依赖 ffprobe，按容器格式直接解析。
// 目前支持：
// - MP4 / QuickTime（video/mp4、.mp4/.m4v/.mov）：遍历 moov/trak…/mvhd，
//   读取 timescale 与 duration（version 0/1 两种布局），取整毫秒（四舍五入）。
// - WebM / Matroska（video/webm、.webm/.mkv）：解析 EBML，取
//   Segment/Info 下的 TimecodeScale（默认 1,000,000 纳秒）与 Duration（浮点）。
// 任何无法识别 / 结构损坏 / 缺少必要字段的文件一律返回 null（调用方据此拒绝候选）。
//
// 设计：仅随机读取文件头部与所需容器盒子，不把整个文件载入内存（媒体可能达数 GB）；
// moov 位于文件尾部（未经过 faststart）时会顺序跳过 mdat 大盒子直到读到 moov。

const fs = require('fs');

const MAX_HEADER_BYTES = 4 * 1024 * 1024 * 1024; // 防御性上限：盒子偏移不得超过 4GB 扫描范围
const READ_CHUNK = 64 * 1024;

function readExact(fd, pos, length) {
  const buf = Buffer.alloc(length);
  let off = 0;
  while (off < length) {
    const n = fs.readSync(fd, buf, off, length - off, pos + off);
    if (n <= 0) return null; // 意外 EOF
    off += n;
  }
  return buf;
}

/* ---------------- MP4 / ISO BMFF ---------------- */

// 在父区间 [start, end) 内查找指定路径的盒子；path 为盒子四字符码数组（如 ['moov','mvhd']）。
// 返回命中盒子的 { type, start(box header 起点), data(载荷起点), size(整盒大小) } 或 null。
function findBoxes(fd, start, end, types) {
  const found = [];
  let pos = start;
  while (pos + 8 <= end) {
    const head = readExact(fd, pos, 8);
    if (!head) break;
    let size = head.readUInt32BE(0);
    const type = head.toString('latin1', 4, 8);
    let headerLen = 8;
    if (size === 1) {
      const ext = readExact(fd, pos + 8, 8);
      if (!ext) break;
      const hi = ext.readUInt32BE(0);
      const lo = ext.readUInt32BE(4);
      // 超过安全整数的盒子无法在本场景出现（视频文件 < 8EB）
      size = hi * 2 ** 32 + lo;
      headerLen = 16;
    } else if (size === 0) {
      size = end - pos; // box 延伸到文件（父区间）末尾
    }
    if (!Number.isFinite(size) || size < headerLen || pos + size > end) break;

    if (types.has(type)) {
      found.push({ type, start: pos, data: pos + headerLen, size, end: pos + size });
    }
    pos += size;
    if (pos - start > MAX_HEADER_BYTES) break;
  }
  return found;
}

function parseMp4Duration(fd, fileSize) {
  const top = findBoxes(fd, 0, fileSize, new Set(['moov', 'mdat', 'ftyp']));
  const moov = top.find((b) => b.type === 'moov');
  if (!moov) return null;
  const mvhdBoxes = findBoxes(fd, moov.data, moov.end, new Set(['mvhd']));
  if (!mvhdBoxes.length) return null;
  const mvhd = mvhdBoxes[0];

  const versionBuf = readExact(fd, mvhd.data, 1);
  if (!versionBuf) return null;
  const version = versionBuf[0];

  let timescalePos;
  let durationPos;
  if (version === 1) {
    // version(1) + flags(3) + creation(8) + modification(8) + timescale(4) + duration(8)
    timescalePos = mvhd.data + 4 + 8 + 8;
    durationPos = timescalePos + 4;
  } else {
    // version(1) + flags(3) + creation(4) + modification(4) + timescale(4) + duration(4)
    timescalePos = mvhd.data + 4 + 4 + 4;
    durationPos = timescalePos + 4;
  }
  const fixed = readExact(fd, timescalePos, version === 1 ? 12 : 8);
  if (!fixed) return null;
  const timescale = fixed.readUInt32BE(0);
  const duration = version === 1
    ? fixed.readUInt32BE(4) * 2 ** 32 + fixed.readUInt32BE(8)
    : fixed.readUInt32BE(4);
  if (!Number.isFinite(timescale) || timescale <= 0 || !Number.isFinite(duration) || duration <= 0) {
    return null;
  }
  return Math.round((duration / timescale) * 1000);
}

/* ---------------- WebM / Matroska (EBML) ---------------- */

// EBML 元素 ID / size 均为 VINT：首字节前导零个数 +1 即总字节数；
// size 的长度标记位按 RFC 8794 处理：全 1（0xFF…）表示未知长度。
function readVint(buf, offset, isSize) {
  if (offset >= buf.length) return null;
  const first = buf[offset];
  if (first === 0) return null;
  let len = 1;
  while (len <= 8 && !(first & (0x80 >> (len - 1)))) len++;
  if (len > 8 || offset + len > buf.length) return null;

  let id = first;
  let size = first & (0xff >> len); // 清掉长度标记位（ID 保留标记位）
  for (let i = 1; i < len; i++) {
    id = id * 256 + buf[offset + i];
    size = size * 256 + buf[offset + i];
  }
  if (isSize) {
    // 未知长度：所有载荷位为 1（如 len=1 -> 0x7f，len=4 -> 0x0fffffff）
    const allOnes = 2 ** (7 * len) - 1;
    if (size === allOnes) size = null;
  }
  return { id, size, len };
}

// 在区间 [start,end) 内枚举直接子元素（不递归）；返回 [{id,data,size,end}]。
// 只读取元素头部（ID + size VINT），大体积兄弟元素（如 Cluster）仅按偏移整体跳过、不读其载荷。
function ebmlChildren(fd, start, end) {
  const out = [];
  let pos = start;
  while (pos + 1 < end) {
    const head = readChunkAt(fd, pos, Math.min(READ_CHUNK, end - pos));
    if (!head || !head.length) break;
    const idV = readVint(head, 0, false);
    const sizeV = readVint(head, idV.len, true);
    if (!idV || !sizeV) break;
    const headerLen = idV.len + sizeV.len;
    const size = sizeV.size == null ? end - (pos + headerLen) : sizeV.size;
    if (!Number.isFinite(size) || pos + headerLen + size > end) break;
    out.push({ id: idV.id, data: pos + headerLen, size, end: pos + headerLen + size });
    pos += headerLen + size;
  }
  return out;
}

// readExact 的分块变体（区间不足时返回实际可读字节）
function readChunkAt(fd, pos, maxLen) {
  return readExact(fd, pos, maxLen);
}

function readFloatBE(buf) {
  if (buf.length === 4) return buf.readFloatBE(0);
  if (buf.length === 8) return buf.readDoubleBE(0);
  return null;
}

// 常用 EBML ID
const ID = {
  EBML: 0x1a45dfa3,
  Segment: 0x18538067,
  Info: 0x1549a966,
  TimecodeScale: 0x2ad7b1,
  Duration: 0x4489,
};

function parseWebmDuration(fd, fileSize) {
  // 顶层找 Segment（EBML 头本身先跳过即可）
  const top = ebmlChildren(fd, 0, fileSize);
  const segment = top.find((e) => e.id === ID.Segment);
  if (!segment) return null;
  const info = ebmlChildren(fd, segment.data, segment.end).find((e) => e.id === ID.Info);
  if (!info) return null;

  let scale = 1000000; // EBML 默认 1,000,000 ns
  let duration = null;
  for (const el of ebmlChildren(fd, info.data, info.end)) {
    if (el.id === ID.TimecodeScale) {
      const b = readExact(fd, el.data, el.size);
      if (!b) return null;
      scale = b.length >= 6 ? Number(b.readBigUInt64BE()) : b.readUIntBE(0, b.length);
      if (!Number.isFinite(scale) || scale <= 0) return null;
    } else if (el.id === ID.Duration) {
      const b = readExact(fd, el.data, el.size);
      if (!b) return null;
      duration = readFloatBE(b);
    }
  }
  if (!Number.isFinite(duration) || duration <= 0) return null;
  // duration 以 timescale 为单位；毫秒 = duration * scale / 1e6
  return Math.round((duration * scale) / 1e6);
}

// 探测入口：成功返回正整数毫秒，任何失败返回 null。
function probeDurationMs(filePath) {
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size < 16) return null;
    // ftyp 品牌判断（mp4 系列）；否则尝试 WebM/EBML；再不行回退一次 MP4（容错无 ftyp 的文件）
    const head = readExact(fd, 0, 12);
    if (!head) return null;
    // WebM/Matroska 以 EBML 头（1A 45 DF A3）开始；否则按 ISO BMFF（MP4）盒子解析
    const isWebm = head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3;
    if (isWebm) return parseWebmDuration(fd, stat.size);
    return parseMp4Duration(fd, stat.size);
  } catch (_) {
    return null;
  } finally {
    if (fd != null) { try { fs.closeSync(fd); } catch (_) { /* 忽略 */ } }
  }
}

module.exports = { probeDurationMs };
