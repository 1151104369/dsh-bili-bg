/**
 * dsh-bili-bg — 纯 Node 内建模块的 QR 编码器 + PNG 渲染。
 *
 * QR 编码核心（GF(2^8) 里德-所罗门纠错、RS 分块、8 种掩码与罚分选优、
 * 格式信息/版本信息 BCH、数据 zigzag 排布）忠实改编自 MIT 许可的
 * "qrcode-generator"（Kazuhiko Arase，https://github.com/kazuhikoarase/qrcode-generator）。
 * 输入按 UTF-8 字节做 Byte 模式编码，自动在 1..40 中挑选装得下的最小版本。
 * PNG 只用 node:zlib 压缩 IDAT，IHDR/IDAT/IEND 与 CRC32 均为手写实现。
 */
import zlib from 'node:zlib'

const EC_KEY = { 1: 'L', 0: 'M', 3: 'Q', 2: 'H' }

// ---------------------------------------------------------------------------
// GF(2^8) 数学（本原多项式 0x11D，指数 0..254）
// ---------------------------------------------------------------------------
const EXP_TABLE = new Array(256)
const LOG_TABLE = new Array(256)
for (let i = 0; i < 8; i++) EXP_TABLE[i] = 1 << i
for (let i = 8; i < 256; i++) {
  EXP_TABLE[i] = EXP_TABLE[i - 4] ^ EXP_TABLE[i - 5] ^ EXP_TABLE[i - 6] ^ EXP_TABLE[i - 8]
}
for (let i = 0; i < 255; i++) LOG_TABLE[EXP_TABLE[i]] = i

function gexp(n) {
  while (n < 0) n += 255
  while (n >= 256) n -= 255
  return EXP_TABLE[n]
}
function glog(n) {
  if (n < 1) throw new Error('glog(' + n + ')')
  return LOG_TABLE[n]
}
function gmult(x, y) {
  if (x === 0 || y === 0) return 0
  return EXP_TABLE[(LOG_TABLE[x] + LOG_TABLE[y]) % 255]
}

// ---------------------------------------------------------------------------
// 多项式（GF(2^8) 上的多项式环，加即异或）
// ---------------------------------------------------------------------------
class Polynomial {
  constructor(num, shift) {
    let offset = 0
    while (offset < num.length && num[offset] === 0) offset++
    this.num = new Array(num.length - offset + shift).fill(0)
    for (let i = 0; i < num.length - offset; i++) this.num[i] = num[i + offset]
  }
  get(i) { return this.num[i] }
  getLength() { return this.num.length }

  multiply(e) {
    const num = new Array(this.getLength() + e.getLength() - 1).fill(0)
    for (let i = 0; i < this.getLength(); i++) {
      for (let j = 0; j < e.getLength(); j++) {
        num[i + j] ^= gmult(this.get(i), e.get(j))
      }
    }
    return new Polynomial(num, 0)
  }

  mod(e) {
    if (this.getLength() - e.getLength() < 0) return this
    const ratio = glog(this.get(0)) - glog(e.get(0))
    const num = this.num.slice()
    for (let i = 0; i < e.getLength(); i++) {
      num[i] ^= gexp(glog(e.get(i)) + ratio)
    }
    return new Polynomial(num, 0).mod(e)
  }
}

function errorCorrectPolynomial(len) {
  let a = new Polynomial([1], 0)
  for (let i = 0; i < len; i++) {
    a = a.multiply(new Polynomial([1, gexp(i)], 0))
  }
  return a
}

// ---------------------------------------------------------------------------
// 位缓冲
// ---------------------------------------------------------------------------
class BitBuffer {
  constructor() {
    this.buffer = []
    this.length = 0
  }
  put(num, len) {
    for (let i = 0; i < len; i++) {
      this.putBit(((num >>> (len - i - 1)) & 1) === 1)
    }
  }
  putBit(bit) {
    const idx = Math.floor(this.length / 8)
    if (this.buffer.length <= idx) this.buffer.push(0)
    if (bit) this.buffer[idx] |= 0x80 >>> (this.length % 8)
    this.length++
  }
}

// ---------------------------------------------------------------------------
// RS 分块表：[count, totalCodewords, dataCodewords] 三元组，version 1..40
// 来自 ISO/IEC 18004 附表（与 qrcode-generator 一致）。
// ---------------------------------------------------------------------------
const RS_TABLE = [
  // v1
  { L: [1, 26, 19], M: [1, 26, 16], Q: [1, 26, 13], H: [1, 26, 9] },
  // v2
  { L: [1, 44, 34], M: [1, 44, 28], Q: [1, 44, 22], H: [1, 44, 16] },
  // v3
  { L: [1, 70, 55], M: [1, 70, 44], Q: [2, 35, 17], H: [2, 35, 13] },
  // v4
  { L: [1, 100, 80], M: [2, 50, 32], Q: [2, 50, 24], H: [4, 25, 9] },
  // v5
  { L: [1, 134, 108], M: [2, 67, 43], Q: [2, 33, 15, 2, 34, 16], H: [2, 33, 11, 2, 34, 12] },
  // v6
  { L: [2, 86, 68], M: [4, 43, 27], Q: [4, 43, 19], H: [4, 43, 15] },
  // v7
  { L: [2, 98, 78], M: [4, 49, 31], Q: [2, 32, 14, 4, 33, 15], H: [4, 39, 13, 1, 40, 14] },
  // v8
  { L: [2, 121, 97], M: [2, 60, 38, 2, 61, 39], Q: [4, 40, 18, 2, 41, 19], H: [4, 40, 14, 2, 41, 15] },
  // v9
  { L: [2, 146, 116], M: [3, 58, 36, 2, 59, 37], Q: [4, 36, 16, 4, 37, 17], H: [4, 36, 12, 4, 37, 13] },
  // v10
  { L: [2, 86, 68, 2, 87, 69], M: [4, 69, 43, 1, 70, 44], Q: [6, 43, 19, 2, 44, 20], H: [6, 43, 15, 2, 44, 16] },
  // v11
  { L: [4, 101, 81], M: [1, 80, 50, 4, 81, 51], Q: [4, 50, 22, 4, 51, 23], H: [3, 36, 12, 8, 37, 13] },
  // v12
  { L: [2, 116, 92, 2, 117, 93], M: [6, 58, 36, 2, 59, 37], Q: [4, 46, 20, 6, 47, 21], H: [7, 42, 14, 4, 43, 15] },
  // v13
  { L: [4, 133, 107], M: [8, 59, 37, 1, 60, 38], Q: [8, 44, 20, 4, 45, 21], H: [12, 33, 11, 4, 34, 12] },
  // v14
  { L: [3, 145, 115, 1, 146, 116], M: [4, 64, 40, 5, 65, 41], Q: [11, 36, 16, 5, 37, 17], H: [11, 36, 12, 5, 37, 13] },
  // v15
  { L: [5, 109, 87, 1, 110, 88], M: [5, 65, 41, 5, 66, 42], Q: [5, 54, 24, 7, 55, 25], H: [11, 36, 12, 7, 37, 13] },
  // v16
  { L: [5, 122, 98, 1, 123, 99], M: [7, 73, 45, 3, 74, 46], Q: [15, 43, 19, 2, 44, 20], H: [3, 45, 15, 13, 46, 16] },
  // v17
  { L: [1, 135, 107, 5, 136, 108], M: [10, 74, 46, 1, 75, 47], Q: [1, 50, 22, 15, 51, 23], H: [2, 42, 14, 17, 43, 15] },
  // v18
  { L: [5, 150, 120, 1, 151, 121], M: [9, 69, 43, 4, 70, 44], Q: [17, 50, 22, 1, 51, 23], H: [2, 42, 14, 19, 43, 15] },
  // v19
  { L: [3, 141, 113, 4, 142, 114], M: [3, 70, 44, 11, 71, 45], Q: [17, 47, 21, 4, 48, 22], H: [9, 39, 13, 16, 40, 14] },
  // v20
  { L: [3, 135, 107, 5, 136, 108], M: [3, 67, 41, 13, 68, 42], Q: [15, 54, 24, 5, 55, 25], H: [15, 43, 15, 10, 44, 16] },
  // v21
  { L: [4, 144, 116, 4, 145, 117], M: [17, 68, 42], Q: [17, 50, 22, 6, 51, 23], H: [19, 46, 16, 6, 47, 17] },
  // v22
  { L: [2, 139, 111, 7, 140, 112], M: [17, 74, 46], Q: [7, 54, 24, 16, 55, 25], H: [34, 37, 13] },
  // v23
  { L: [4, 151, 121, 5, 152, 122], M: [4, 75, 47, 14, 76, 48], Q: [11, 54, 24, 14, 55, 25], H: [16, 45, 15, 14, 46, 16] },
  // v24
  { L: [6, 147, 117, 4, 148, 118], M: [6, 73, 45, 14, 74, 46], Q: [11, 54, 24, 16, 55, 25], H: [30, 46, 16, 2, 47, 17] },
  // v25
  { L: [8, 132, 106, 4, 133, 107], M: [8, 75, 47, 13, 76, 48], Q: [7, 54, 24, 22, 55, 25], H: [22, 45, 15, 13, 46, 16] },
  // v26
  { L: [10, 142, 114, 2, 143, 115], M: [19, 74, 46, 4, 75, 47], Q: [28, 50, 22, 6, 51, 23], H: [33, 46, 16, 4, 47, 17] },
  // v27
  { L: [8, 152, 122, 4, 153, 123], M: [22, 73, 45, 3, 74, 46], Q: [8, 53, 23, 26, 54, 24], H: [12, 45, 15, 28, 46, 16] },
  // v28
  { L: [3, 147, 117, 10, 148, 118], M: [3, 73, 45, 23, 74, 46], Q: [4, 54, 24, 31, 55, 25], H: [11, 45, 15, 31, 46, 16] },
  // v29
  { L: [7, 146, 116, 7, 147, 117], M: [21, 73, 45, 7, 74, 46], Q: [1, 53, 23, 37, 54, 24], H: [19, 45, 15, 26, 46, 16] },
  // v30
  { L: [5, 145, 115, 10, 146, 116], M: [19, 75, 47, 10, 76, 48], Q: [15, 54, 24, 25, 55, 25], H: [23, 45, 15, 25, 46, 16] },
  // v31
  { L: [13, 145, 115, 3, 146, 116], M: [2, 74, 46, 29, 75, 47], Q: [42, 54, 24, 1, 55, 25], H: [23, 45, 15, 28, 46, 16] },
  // v32
  { L: [17, 145, 115], M: [10, 74, 46, 23, 75, 47], Q: [10, 54, 24, 35, 55, 25], H: [19, 45, 15, 35, 46, 16] },
  // v33
  { L: [17, 145, 115, 1, 146, 116], M: [14, 74, 46, 21, 75, 47], Q: [29, 54, 24, 19, 55, 25], H: [11, 45, 15, 46, 46, 16] },
  // v34
  { L: [13, 145, 115, 6, 146, 116], M: [14, 74, 46, 23, 75, 47], Q: [44, 54, 24, 7, 55, 25], H: [59, 46, 16, 1, 47, 17] },
  // v35
  { L: [12, 151, 121, 7, 152, 122], M: [12, 75, 47, 26, 76, 48], Q: [39, 54, 24, 14, 55, 25], H: [22, 45, 15, 41, 46, 16] },
  // v36
  { L: [6, 151, 121, 14, 152, 122], M: [6, 75, 47, 34, 76, 48], Q: [46, 54, 24, 10, 55, 25], H: [2, 45, 15, 64, 46, 16] },
  // v37
  { L: [17, 152, 122, 4, 153, 123], M: [29, 74, 46, 14, 75, 47], Q: [49, 54, 24, 10, 55, 25], H: [24, 45, 15, 46, 46, 16] },
  // v38
  { L: [4, 152, 122, 18, 153, 123], M: [13, 74, 46, 32, 75, 47], Q: [48, 54, 24, 14, 55, 25], H: [42, 45, 15, 32, 46, 16] },
  // v39
  { L: [20, 147, 117, 4, 148, 118], M: [40, 75, 47, 7, 76, 48], Q: [43, 54, 24, 22, 55, 25], H: [10, 45, 15, 67, 46, 16] },
  // v40
  { L: [19, 148, 118, 6, 149, 119], M: [18, 75, 47, 31, 76, 48], Q: [34, 54, 24, 34, 55, 25], H: [20, 45, 15, 61, 46, 16] },
]

const PATTERN_POSITION_TABLE = [
  [], // v1
  [6, 18], [6, 22], [6, 26], [6, 30], [6, 34],
  [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50], [6, 30, 54],
  [6, 32, 58], [6, 34, 62], [6, 26, 46, 66], [6, 26, 48, 70], [6, 26, 50, 74],
  [6, 30, 54, 78], [6, 30, 56, 82], [6, 30, 58, 86], [6, 34, 62, 90],
  [6, 28, 50, 72, 94], [6, 26, 50, 74, 98], [6, 30, 54, 78, 102], [6, 28, 54, 80, 106],
  [6, 32, 58, 84, 110], [6, 30, 58, 86, 114], [6, 34, 62, 90, 118],
  [6, 26, 50, 74, 98, 122], [6, 30, 54, 78, 102, 126], [6, 26, 52, 78, 104, 130],
  [6, 30, 56, 82, 108, 134], [6, 34, 60, 86, 112, 138], [6, 30, 58, 86, 114, 142],
  [6, 34, 62, 90, 118, 146], [6, 30, 54, 78, 102, 126, 150], [6, 24, 50, 76, 102, 128, 154],
  [6, 28, 54, 80, 106, 132, 158], [6, 32, 58, 84, 110, 136, 162], [6, 26, 54, 82, 110, 138, 166],
  [6, 30, 58, 86, 114, 142, 170],
]

// ---------------------------------------------------------------------------
// BCH 格式信息 / 版本信息
// ---------------------------------------------------------------------------
const G15 = (1 << 10) | (1 << 8) | (1 << 5) | (1 << 4) | (1 << 2) | (1 << 1) | (1 << 0)
const G15_MASK = (1 << 14) | (1 << 12) | (1 << 10) | (1 << 4) | (1 << 1)
const G18 = (1 << 12) | (1 << 11) | (1 << 10) | (1 << 9) | (1 << 8) | (1 << 5) | (1 << 2) | (1 << 0)

function bchDigit(data) {
  let digit = 0
  while (data !== 0) { digit++; data >>>= 1 }
  return digit
}
function getBCHTypeInfo(data) {
  let d = data << 10
  while (bchDigit(d) - bchDigit(G15) >= 0) d ^= G15 << (bchDigit(d) - bchDigit(G15))
  return ((data << 10) | d) ^ G15_MASK
}
function getBCHTypeNumber(data) {
  let d = data << 12
  while (bchDigit(d) - bchDigit(G18) >= 0) d ^= G18 << (bchDigit(d) - bchDigit(G18))
  return (data << 12) | d
}

// ---------------------------------------------------------------------------
// 矩阵排布（功能图形 + 数据 zigzag + 掩码）
// ---------------------------------------------------------------------------
const MASKS = [
  (i, j) => (i + j) % 2 === 0,
  (i, j) => i % 2 === 0,
  (i, j) => j % 3 === 0,
  (i, j) => (i + j) % 3 === 0,
  (i, j) => (Math.floor(i / 2) + Math.floor(j / 3)) % 2 === 0,
  (i, j) => ((i * j) % 2) + ((i * j) % 3) === 0,
  (i, j) => (((i * j) % 2) + ((i * j) % 3)) % 2 === 0,
  (i, j) => (((i * j) % 3) + ((i + j) % 2)) % 2 === 0,
]

function placeFinder(m, size, row, col) {
  for (let r = -1; r <= 7; r++) {
    if (row + r <= -1 || size <= row + r) continue
    for (let c = -1; c <= 7; c++) {
      if (col + c <= -1 || size <= col + c) continue
      if ((0 <= r && r <= 6 && (c === 0 || c === 6)) ||
          (0 <= c && c <= 6 && (r === 0 || r === 6)) ||
          (2 <= r && r <= 4 && 2 <= c && c <= 4)) {
        m[row + r][col + c] = true
      } else {
        m[row + r][col + c] = false
      }
    }
  }
}

function placeAlignment(m, row, col) {
  for (let r = -2; r <= 2; r++) {
    for (let c = -2; c <= 2; c++) {
      if (r === -2 || r === 2 || c === -2 || c === 2 || (r === 0 && c === 0)) {
        m[row + r][col + c] = true
      } else {
        m[row + r][col + c] = false
      }
    }
  }
}

function placeFormat(m, size, data) {
  const bits = getBCHTypeInfo(data)
  for (let i = 0; i < 15; i++) {
    const mod = ((bits >> i) & 1) === 1
    if (i < 6) m[i][8] = mod
    else if (i < 8) m[i + 1][8] = mod
    else m[size - 15 + i][8] = mod
    if (i < 8) m[8][size - i - 1] = mod
    else if (i < 9) m[8][15 - i - 1 + 1] = mod
    else m[8][15 - i - 1] = mod
  }
  m[size - 8][8] = true // 固定暗模块
}

function placeVersion(m, size, version) {
  const bits = getBCHTypeNumber(version)
  for (let i = 0; i < 18; i++) {
    const mod = ((bits >> i) & 1) === 1
    m[Math.floor(i / 3)][i % 3 + size - 8 - 3] = mod
    m[i % 3 + size - 8 - 3][Math.floor(i / 3)] = mod
  }
}

function mapData(m, size, data, maskPattern) {
  const mask = MASKS[maskPattern]
  let bitIndex = 0
  let direction = 1
  for (let i = size - 1; i > 0; i -= 2) {
    if (i === 6) i -= 1
    for (let count = 0; count < size; count++) {
      const j = direction === 1 ? size - 1 - count : count
      for (let k = 0; k < 2; k++) {
        const col = i - k
        if (m[j][col] !== null) continue
        let dark = false
        if (bitIndex < data.length * 8) {
          dark = ((data[bitIndex >>> 3] >>> (7 - (bitIndex & 7))) & 1) === 1
          bitIndex++
        }
        if (mask(j, col)) dark = !dark
        m[j][col] = dark
      }
    }
    direction = -direction
  }
}

function buildMatrix(version, ecCode, data, maskPattern) {
  const size = version * 4 + 17
  const m = Array.from({ length: size }, () => new Array(size).fill(null))
  placeFinder(m, size, 0, 0)
  placeFinder(m, size, 0, size - 7)
  placeFinder(m, size, size - 7, 0)
  const pos = PATTERN_POSITION_TABLE[version - 1]
  for (const row of pos) {
    for (const col of pos) {
      if (m[row][col] !== null) continue
      placeAlignment(m, row, col)
    }
  }
  for (let r = 8; r < size - 8; r++) {
    if (m[r][6] !== null) continue
    m[r][6] = r % 2 === 0
  }
  for (let c = 8; c < size - 8; c++) {
    if (m[6][c] !== null) continue
    m[6][c] = c % 2 === 0
  }
  placeFormat(m, size, (ecCode << 3) | maskPattern)
  if (version >= 7) placeVersion(m, size, version)
  mapData(m, size, data, maskPattern)
  return m
}

// 罚分选优（忠实复刻 qrcode-generator 的 getLostPoint）
function lostPoint(m) {
  const size = m.length
  let point = 0
  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      let sameCount = 0
      const dark = m[row][col]
      for (let r = -1; r <= 1; r++) {
        if (row + r < 0 || size <= row + r) continue
        for (let c = -1; c <= 1; c++) {
          if (col + c < 0 || size <= col + c) continue
          if (r === 0 && c === 0) continue
          if (dark === m[row + r][col + c]) sameCount++
        }
      }
      if (sameCount > 5) point += 3 + sameCount - 5
    }
  }
  for (let row = 0; row < size - 1; row++) {
    for (let col = 0; col < size - 1; col++) {
      let count = 0
      if (m[row][col]) count++
      if (m[row + 1][col]) count++
      if (m[row][col + 1]) count++
      if (m[row + 1][col + 1]) count++
      if (count === 0 || count === 4) point += 3
    }
  }
  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size - 6; col++) {
      if (m[row][col] &&
          !m[row][col + 1] && m[row][col + 2] && m[row][col + 3] && m[row][col + 4] &&
          !m[row][col + 5] && m[row][col + 6]) {
        point += 40
      }
    }
  }
  for (let col = 0; col < size; col++) {
    for (let row = 0; row < size - 6; row++) {
      if (m[row][col] &&
          !m[row + 1][col] && m[row + 2][col] && m[row + 3][col] && m[row + 4][col] &&
          !m[row + 5][col] && m[row + 6][col]) {
        point += 40
      }
    }
  }
  let darkCount = 0
  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      if (m[row][col]) darkCount++
    }
  }
  const ratio = Math.abs(100 * darkCount / size / size - 50) / 5
  point += ratio * 10
  return point
}

function bestMask(version, ecCode, data) {
  let best = 0
  let bestPoint = -1
  for (let i = 0; i < 8; i++) {
    const point = lostPoint(buildMatrix(version, ecCode, data, i))
    if (bestPoint === -1 || point < bestPoint) {
      bestPoint = point
      best = i
    }
  }
  return best
}

// ---------------------------------------------------------------------------
// RS 编码与码字交织
// ---------------------------------------------------------------------------
function rsBlocks(version, ecCode) {
  const triples = RS_TABLE[version - 1][EC_KEY[ecCode]]
  const blocks = []
  for (let i = 0; i < triples.length; i += 3) {
    for (let j = 0; j < triples[i]; j++) blocks.push([triples[i + 1], triples[i + 2]])
  }
  return blocks
}

function createData(version, ecCode, bytes) {
  const blocks = rsBlocks(version, ecCode)
  let totalDataCount = 0
  for (const b of blocks) totalDataCount += b[1]

  const buf = new BitBuffer()
  buf.put(4, 4) // MODE_8BIT_BYTE = 0100
  buf.put(bytes.length, version < 10 ? 8 : 16)
  for (const byte of bytes) buf.put(byte, 8)

  const needed = totalDataCount * 8
  if (buf.length > needed) throw new Error('QR 数据过长')
  if (buf.length + 4 <= needed) buf.put(0, 4) // 终止符
  while (buf.length % 8 !== 0) buf.putBit(false) // 补齐到字节
  let pad = true
  while (buf.length < needed) { // 填充字节 0xEC/0x11
    buf.put(pad ? 0xEC : 0x11, 8)
    pad = !pad
  }
  return createBytes(buf.buffer, blocks)
}

function createBytes(buffer, blocks) {
  let offset = 0
  let maxDc = 0
  let maxEc = 0
  const dcdata = new Array(blocks.length)
  const ecdata = new Array(blocks.length)
  for (let r = 0; r < blocks.length; r++) {
    const total = blocks[r][0]
    const dataCount = blocks[r][1]
    const ecCount = total - dataCount
    maxDc = Math.max(maxDc, dataCount)
    maxEc = Math.max(maxEc, ecCount)
    const dc = new Array(dataCount)
    for (let i = 0; i < dataCount; i++) dc[i] = 0xff & buffer[i + offset]
    offset += dataCount
    dcdata[r] = dc
    const rsPoly = errorCorrectPolynomial(ecCount)
    const modPoly = new Polynomial(dc, rsPoly.getLength() - 1).mod(rsPoly)
    const ec = new Array(ecCount)
    for (let i = 0; i < ecCount; i++) {
      const idx = i + modPoly.getLength() - ecCount
      ec[i] = idx >= 0 ? modPoly.get(idx) : 0
    }
    ecdata[r] = ec
  }
  let totalCount = 0
  for (const b of blocks) totalCount += b[0]
  const data = new Array(totalCount)
  let index = 0
  for (let i = 0; i < maxDc; i++) {
    for (let r = 0; r < blocks.length; r++) {
      if (i < dcdata[r].length) data[index++] = dcdata[r][i]
    }
  }
  for (let i = 0; i < maxEc; i++) {
    for (let r = 0; r < blocks.length; r++) {
      if (i < ecdata[r].length) data[index++] = ecdata[r][i]
    }
  }
  return data
}

// ---------------------------------------------------------------------------
// 编码层
// ---------------------------------------------------------------------------
function ecNumber(ecLevel) {
  switch (String(ecLevel).toUpperCase()) {
    case 'L': return 1
    case 'M': return 0
    case 'Q': return 3
    case 'H': return 2
    default: throw new Error('无效 ecLevel: ' + ecLevel)
  }
}

function utf8Bytes(str) {
  const bytes = []
  for (let i = 0; i < str.length; i++) {
    let code = str.charCodeAt(i)
    if (code >= 0xD800 && code <= 0xDBFF && i + 1 < str.length) {
      const next = str.charCodeAt(i + 1)
      if (next >= 0xDC00 && next <= 0xDFFF) {
        code = 0x10000 + ((code - 0xD800) << 10) + (next - 0xDC00)
        i++
      }
    }
    if (code <= 0x7F) bytes.push(code)
    else if (code <= 0x7FF) bytes.push(0xC0 | (code >> 6), 0x80 | (code & 0x3F))
    else if (code <= 0xFFFF) bytes.push(0xE0 | (code >> 12), 0x80 | ((code >> 6) & 0x3F), 0x80 | (code & 0x3F))
    else bytes.push(0xF0 | (code >> 18), 0x80 | ((code >> 12) & 0x3F), 0x80 | ((code >> 6) & 0x3F), 0x80 | (code & 0x3F))
  }
  return bytes
}

function dataCodewords(version, ecCode) {
  const triples = RS_TABLE[version - 1][EC_KEY[ecCode]]
  let n = 0
  for (let i = 0; i < triples.length; i += 3) n += triples[i] * triples[i + 2]
  return n
}
function neededBits(byteLen, version) {
  return 4 + (version < 10 ? 8 : 16) + 8 * byteLen
}

function chooseVersion(byteLen, ecCode) {
  for (let v = 1; v <= 40; v++) {
    if (neededBits(byteLen, v) <= dataCodewords(v, ecCode) * 8) return v
  }
  throw new Error('文本过长，无法编码为 QR（> 版本 40 容量）')
}

// ---------------------------------------------------------------------------
// 公开 API
// ---------------------------------------------------------------------------
export function qrVersion(text, { ecLevel = 'M' } = {}) {
  return chooseVersion(utf8Bytes(String(text)).length, ecNumber(ecLevel))
}

export function qrMatrix(text, { ecLevel = 'M' } = {}) {
  const code = ecNumber(ecLevel)
  const bytes = utf8Bytes(String(text))
  const version = chooseVersion(bytes.length, code)
  const data = createData(version, code, bytes)
  const mask = bestMask(version, code, data)
  const m = buildMatrix(version, code, data, mask)
  return m.map((row) => row.map((v) => v === true))
}

// ---------------------------------------------------------------------------
// PNG 渲染（仅 node:zlib）
// ---------------------------------------------------------------------------
const CRC_TABLE = (() => {
  const t = new Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1
    }
    t[n] = c >>> 0
  }
  return t
})()

function crc32(buf) {
  let c = 0xFFFFFFFF
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8)
  return (c ^ 0xFFFFFFFF) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const typeBuf = Buffer.from(type, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0)
  return Buffer.concat([len, typeBuf, data, crc])
}

export function pngSignature() {
  return Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
}

export function qrPng(text, { ecLevel = 'M', margin = 4, scale = 4 } = {}) {
  const matrix = qrMatrix(text, { ecLevel })
  const n = matrix.length
  const dim = (n + 2 * margin) * scale

  const scanlines = []
  for (let y = 0; y < dim; y++) {
    const row = Buffer.alloc(1 + dim * 4) // 过滤器字节 + RGBA
    const my = Math.floor(y / scale) - margin
    for (let x = 0; x < dim; x++) {
      const mx = Math.floor(x / scale) - margin
      const dark = mx >= 0 && my >= 0 && mx < n && my < n && matrix[my][mx]
      const off = 1 + x * 4
      row[off] = dark ? 0 : 255
      row[off + 1] = dark ? 0 : 255
      row[off + 2] = dark ? 0 : 255
      row[off + 3] = 255
    }
    scanlines.push(row)
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(dim, 0) // width
  ihdr.writeUInt32BE(dim, 4) // height
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // color type: RGBA
  // compression=0, filter=0, interlace=0
  const idat = zlib.deflateSync(Buffer.concat(scanlines))

  return Buffer.concat([
    pngSignature(),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ])
}