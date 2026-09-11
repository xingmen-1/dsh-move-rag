/**
 * Knowledge base engine: text extraction (PDF/Word/plain), fixed-size chunking,
 * local hashed-embedding vectors, and cosine retrieval. Extracted from the
 * dynamic prototype so the permanent plugin owns the same behavior.
 */function createEngine(ctx) {

    const NL = String.fromCharCode(10)
    const SEP = String.fromCharCode(92)
    const DEFAULT_ROOT = process.env.DSH_KNOWLEDGE_ROOT
      || ((process.env.HOME || process.env.USERPROFILE || '.') + SEP + 'knowledge-docs')
    const DIM = 512
    const CHUNK_SIZE = 700
    const CHUNK_OVERLAP = 120
    const DEFAULT_TOPK = 4
    const MAX_UPLOAD_BYTES = 16 * 1024 * 1024
    const MAX_LOCAL_BYTES = 256 * 1024 * 1024
    const TEXT_EXT = ['txt', 'md', 'markdown', 'json', 'jsonl', 'csv', 'tsv', 'log', 'html', 'htm', 'xml', 'yml', 'yaml', 'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'py', 'java', 'kt', 'go', 'rs', 'c', 'h', 'cpp', 'hpp', 'cs', 'rb', 'php', 'swift', 'sql', 'sh', 'bash', 'ps1', 'bat', 'toml', 'ini', 'cfg', 'conf', 'srt', 'vtt', 'tex', 'rst']
    const IMAGE_EXT = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'svg']
    const fs = ctx.get('fs')
    const shell = ctx.get('shell')
    const state = { root: DEFAULT_ROOT, index: null, vectors: null, loading: null, chain: Promise.resolve(), lastError: null }

    function messageOf(error) { return String(error && error.message || error) }
    function joinPath() { return Array.prototype.slice.call(arguments).join(SEP) }
    function policy() { return { mode: 'danger-full-access', workspaceRoot: state.root } }
    function filesDir() { return joinPath(state.root, 'files') }
    function indexPath() { return joinPath(state.root, '.kb', 'index.json') }
    function extensionOf(name) { const dot = name.lastIndexOf('.'); return dot < 0 ? '' : name.slice(dot + 1).toLowerCase() }
    function isCjk(ch) { return ch !== '' && ch.charCodeAt(0) >= 0x2e80 }

    const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
    const B64INV = (function () { const table = new Int16Array(256); for (let i = 0; i < 256; i++) table[i] = -1; for (let i = 0; i < B64.length; i++) table[B64.charCodeAt(i)] = i; return table })()
    function base64ToBytes(text) {
      const clean = String(text || '').split(NL).join('').split(String.fromCharCode(13)).join('').trim()
      let end = clean.length
      while (end > 0 && clean.charCodeAt(end - 1) === 61) end--
      const out = new Uint8Array(Math.floor(end * 3 / 4) + 3)
      let p = 0, buffer = 0, bits = 0
      for (let i = 0; i < end; i++) {
        const value = B64INV[clean.charCodeAt(i)]
        if (value < 0) continue
        buffer = (buffer << 6) | value
        bits += 6
        if (bits >= 8) { bits -= 8; out[p++] = (buffer >> bits) & 255 }
      }
      return out.subarray(0, p)
    }
    function bytesToBase64(bytes) {
      let out = ''
      for (let i = 0; i < bytes.length; i += 3) {
        const b0 = bytes[i]
        const b1 = i + 1 < bytes.length ? bytes[i + 1] : -1
        const b2 = i + 2 < bytes.length ? bytes[i + 2] : -1
        out += B64.charAt(b0 >> 2)
        out += B64.charAt(((b0 & 3) << 4) | ((b1 < 0 ? 0 : b1) >> 4))
        out += b1 < 0 ? '=' : B64.charAt(((b1 & 15) << 2) | ((b2 < 0 ? 0 : b2) >> 6))
        out += b2 < 0 ? '=' : B64.charAt(b2 & 63)
      }
      return out
    }
    function decodeUtf8(bytes) { return new TextDecoder('utf-8').decode(bytes) }
    function latin1(bytes) {
      let out = ''
      for (let i = 0; i < bytes.length; i += 8192) out += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192))
      return out
    }
    function toBytes(text) { const out = new Uint8Array(text.length); for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 255; return out }

    function inflateRaw(input) {
      let bitPos = 0
      let buffer = new Uint8Array(Math.max(1024, input.length * 4))
      let length = 0
      function ensure(extra) {
        if (length + extra <= buffer.length) return
        let size = buffer.length * 2
        while (size < length + extra) size *= 2
        const next = new Uint8Array(size)
        next.set(buffer.subarray(0, length))
        buffer = next
      }
      function push(byte) { ensure(1); buffer[length++] = byte }
      function readBit() { const byte = input[bitPos >> 3]; if (byte === undefined) throw new Error('inflate: out of input'); const bit = (byte >> (bitPos & 7)) & 1; bitPos++; return bit }
      function readBits(count) { let value = 0; for (let i = 0; i < count; i++) value |= readBit() << i; return value }
      function buildHuffman(lengths) {
        let maxBits = 0
        for (let i = 0; i < lengths.length; i++) if (lengths[i] > maxBits) maxBits = lengths[i]
        const counts = new Array(maxBits + 1).fill(0)
        for (let i = 0; i < lengths.length; i++) counts[lengths[i]]++
        counts[0] = 0
        const nextCode = new Array(maxBits + 1).fill(0)
        let code = 0
        for (let bits = 1; bits <= maxBits; bits++) { code = (code + counts[bits - 1]) << 1; nextCode[bits] = code }
        const map = new Map()
        for (let symbol = 0; symbol < lengths.length; symbol++) {
          const len = lengths[symbol]
          if (len === 0) continue
          map.set(len + ':' + nextCode[len], symbol)
          nextCode[len]++
        }
        return { map: map, maxBits: maxBits }
      }
      function decodeSymbol(huffman) {
        let code = 0
        for (let len = 1; len <= huffman.maxBits; len++) {
          code = (code << 1) | readBit()
          const symbol = huffman.map.get(len + ':' + code)
          if (symbol !== undefined) return symbol
        }
        throw new Error('inflate: invalid Huffman code')
      }
      const LENGTH_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258]
      const LENGTH_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0]
      const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577]
      const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13]
      const ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15]
      function copyBlock(lit, dist) {
        for (;;) {
          const symbol = decodeSymbol(lit)
          if (symbol < 256) { push(symbol); continue }
          if (symbol === 256) return
          const index = symbol - 257
          const copyLength = LENGTH_BASE[index] + readBits(LENGTH_EXTRA[index])
          const distSymbol = decodeSymbol(dist)
          const distance = DIST_BASE[distSymbol] + readBits(DIST_EXTRA[distSymbol])
          ensure(copyLength)
          let from = length - distance
          for (let i = 0; i < copyLength; i++) buffer[length++] = buffer[from++]
        }
      }
      let final = 0
      do {
        final = readBit()
        const type = readBits(2)
        if (type === 0) {
          bitPos = (bitPos + 7) & ~7
          const bytePos = bitPos >> 3
          const len = input[bytePos] | (input[bytePos + 1] << 8)
          bitPos = (bytePos + 4) * 8
          for (let i = 0; i < len; i++) push(input[(bitPos >> 3) + i])
          bitPos += len * 8
        } else if (type === 1) {
          const litLengths = new Array(288)
          for (let i = 0; i < 144; i++) litLengths[i] = 8
          for (let i = 144; i < 256; i++) litLengths[i] = 9
          for (let i = 256; i < 280; i++) litLengths[i] = 7
          for (let i = 280; i < 288; i++) litLengths[i] = 8
          copyBlock(buildHuffman(litLengths), buildHuffman(new Array(30).fill(5)))
        } else if (type === 2) {
          const hlit = readBits(5) + 257
          const hdist = readBits(5) + 1
          const hclen = readBits(4) + 4
          const codeLengths = new Array(19).fill(0)
          for (let i = 0; i < hclen; i++) codeLengths[ORDER[i]] = readBits(3)
          const codeHuffman = buildHuffman(codeLengths)
          const lengths = []
          while (lengths.length < hlit + hdist) {
            const symbol = decodeSymbol(codeHuffman)
            if (symbol < 16) { lengths.push(symbol); continue }
            let repeat = 0, value = 0
            if (symbol === 16) { repeat = readBits(2) + 3; value = lengths[lengths.length - 1] }
            else if (symbol === 17) { repeat = readBits(3) + 3; value = 0 }
            else { repeat = readBits(7) + 11; value = 0 }
            for (let i = 0; i < repeat; i++) lengths.push(value)
          }
          copyBlock(buildHuffman(lengths.slice(0, hlit)), buildHuffman(lengths.slice(hlit, hlit + hdist)))
        } else throw new Error('inflate: invalid block type')
      } while (!final)
      return buffer.subarray(0, length)
    }
    function inflateZlib(input) {
      if (input.length > 2 && (input[0] & 15) === 8 && (((input[0] << 8) | input[1]) % 31) === 0) return inflateRaw(input.subarray(2))
      return inflateRaw(input)
    }

    function u16(data, offset) { return data[offset] | (data[offset + 1] << 8) }
    function u32(data, offset) { return (data[offset] | (data[offset + 1] << 8) | (data[offset + 2] << 16) | (data[offset + 3] << 24)) >>> 0 }
    function zipRead(data, wanted) {
      let eocd = -1
      const floor = Math.max(0, data.length - 66000)
      for (let i = data.length - 22; i >= floor; i--) {
        if (data[i] === 80 && data[i + 1] === 75 && data[i + 2] === 5 && data[i + 3] === 6) { eocd = i; break }
      }
      if (eocd < 0) throw new Error('zip: 未找到中央目录')
      const count = u16(data, eocd + 10)
      let offset = u32(data, eocd + 16)
      for (let i = 0; i < count; i++) {
        if (u32(data, offset) !== 0x02014b50) break
        const method = u16(data, offset + 10)
        const compressedSize = u32(data, offset + 20)
        const nameLength = u16(data, offset + 28)
        const extraLength = u16(data, offset + 30)
        const commentLength = u16(data, offset + 32)
        const localOffset = u32(data, offset + 42)
        const name = decodeUtf8(data.subarray(offset + 46, offset + 46 + nameLength))
        if (name === wanted) {
          const start = localOffset + 30 + u16(data, localOffset + 26) + u16(data, localOffset + 28)
          const raw = data.subarray(start, start + compressedSize)
          if (method === 0) return raw
          if (method === 8) return inflateRaw(raw)
          throw new Error('zip: 不支持的压缩方式 ' + method)
        }
        offset += 46 + nameLength + extraLength + commentLength
      }
      return null
    }

    function stripMarkup(text) {
      let out = ''
      let inside = false
      for (let i = 0; i < text.length; i++) {
        const ch = text[i]
        if (ch === '<') { inside = true; continue }
        if (ch === '>') { inside = false; out += ' '; continue }
        if (!inside) out += ch
      }
      return out.split('&nbsp;').join(' ').split('&amp;').join('&').split('&lt;').join('<').split('&gt;').join('>').split('&quot;').join('"').split('&#39;').join("'")
    }
    function extractDocxText(bytes) {
      const xml = zipRead(bytes, 'word/document.xml')
      if (xml === null) throw new Error('docx: 缺少 word/document.xml')
      let text = decodeUtf8(xml)
      text = text.split('</w:p>').join(NL)
      text = text.split('<w:tab/>').join(String.fromCharCode(9))
      text = text.split('<w:br/>').join(NL)
      return stripMarkup(text)
    }

    function sliceDict(text, start) {
      let depth = 0
      let i = start
      while (i < text.length) {
        if (text.charCodeAt(i) === 60 && text.charCodeAt(i + 1) === 60) { depth++; i += 2; continue }
        if (text.charCodeAt(i) === 62 && text.charCodeAt(i + 1) === 62) { depth--; i += 2; if (depth === 0) return text.slice(start, i); continue }
        i++
      }
      return text.slice(start)
    }
    function dictPart(body) { const start = body.indexOf('<<'); return start < 0 ? '' : sliceDict(body, start) }
    function refAfter(text, index) {
      let i = index
      while (i < text.length && text.charCodeAt(i) <= 32) i++
      const start = i
      while (i < text.length && text.charCodeAt(i) >= 48 && text.charCodeAt(i) <= 57) i++
      if (i === start) return null
      const value = text.slice(start, i)
      let j = i
      while (j < text.length && text.charCodeAt(j) <= 32) j++
      const generationStart = j
      while (j < text.length && text.charCodeAt(j) >= 48 && text.charCodeAt(j) <= 57) j++
      if (j === generationStart) return null
      let k = j
      while (k < text.length && text.charCodeAt(k) <= 32) k++
      return text.charCodeAt(k) === 82 ? value : null
    }
    function objectNumberAt(text, index) {
      let end = index
      while (end > 0 && text.charCodeAt(end - 1) <= 32) end--
      let genStart = end
      while (genStart > 0 && text.charCodeAt(genStart - 1) >= 48 && text.charCodeAt(genStart - 1) <= 57) genStart--
      let numEnd = genStart
      while (numEnd > 0 && text.charCodeAt(numEnd - 1) <= 32) numEnd--
      let numStart = numEnd
      while (numStart > 0 && text.charCodeAt(numStart - 1) >= 48 && text.charCodeAt(numStart - 1) <= 57) numStart--
      const value = text.slice(numStart, numEnd)
      return value === '' ? null : value
    }
    function parseObjects(raw) {
      const objects = {}
      let from = 0
      for (;;) {
        const at = raw.indexOf(' obj', from)
        if (at < 0) break
        const num = objectNumberAt(raw, at)
        if (num !== null) { const end = raw.indexOf('endobj', at); objects[num] = raw.slice(at + 4, end < 0 ? raw.length : end) }
        from = at + 4
      }
      return objects
    }
    function streamBytes(body) {
      const at = body.indexOf('stream')
      if (at < 0) return null
      let start = at + 6
      if (body.charCodeAt(start) === 13) start++
      if (body.charCodeAt(start) === 10) start++
      const end = body.indexOf('endstream', start)
      return end < 0 ? null : toBytes(body.slice(start, end))
    }
    function streamText(body) {
      const bytes = streamBytes(body)
      if (bytes === null) return null
      const dict = dictPart(body)
      if (dict.indexOf('FlateDecode') >= 0) { try { return latin1(inflateZlib(bytes)) } catch (error) { return null } }
      if (dict.indexOf('/Filter') >= 0) return null
      return latin1(bytes)
    }
    function objectStreamText(objects, num) { const body = objects[num]; return body === undefined ? null : streamText(body) }
    function hexToUtf16(hex) {
      let out = ''
      for (let i = 0; i + 3 < hex.length; i += 4) { const value = parseInt(hex.slice(i, i + 4), 16); if (!isNaN(value)) out += String.fromCharCode(value) }
      if (out === '' && hex.length >= 2) out = String.fromCharCode(parseInt(hex.slice(0, 2), 16) || 0)
      return out
    }
    function cmapTokens(body) {
      const tokens = []
      let i = 0
      while (i < body.length) {
        const ch = body[i]
        if (ch === '<') { const close = body.indexOf('>', i); tokens.push({ hex: body.slice(i + 1, close < 0 ? body.length : close) }); i = close < 0 ? body.length : close + 1; continue }
        if (ch === '[') { tokens.push({ open: true }); i++; continue }
        if (ch === ']') { tokens.push({ close: true }); i++; continue }
        i++
      }
      return tokens
    }
    function parseCmap(text) {
      const map = {}
      let from = 0
      for (;;) {
        const charAt = text.indexOf('beginbfchar', from)
        const rangeAt = text.indexOf('beginbfrange', from)
        if (charAt < 0 && rangeAt < 0) break
        const isRange = rangeAt >= 0 && (charAt < 0 || rangeAt < charAt)
        const begin = isRange ? rangeAt : charAt
        const bodyStart = begin + (isRange ? 12 : 11)
        const end = text.indexOf(isRange ? 'endbfrange' : 'endbfchar', bodyStart)
        if (end < 0) break
        const tokens = cmapTokens(text.slice(bodyStart, end))
        if (!isRange) {
          for (let k = 0; k + 1 < tokens.length; k += 2) {
            if (tokens[k].hex === undefined || tokens[k + 1].hex === undefined) continue
            map[parseInt(tokens[k].hex, 16)] = hexToUtf16(tokens[k + 1].hex)
          }
        } else {
          let k = 0
          while (k + 1 < tokens.length) {
            const lowToken = tokens[k]
            const highToken = tokens[k + 1]
            if (lowToken.hex === undefined || highToken.hex === undefined) { k++; continue }
            const low = parseInt(lowToken.hex, 16)
            const high = parseInt(highToken.hex, 16)
            const third = tokens[k + 2]
            if (third !== undefined && third.open === true) {
              let cursor = k + 3
              let code = low
              while (cursor < tokens.length && tokens[cursor].close !== true) {
                if (tokens[cursor].hex !== undefined) { map[code] = hexToUtf16(tokens[cursor].hex); code++ }
                cursor++
              }
              k = cursor + 1
              continue
            }
            if (third !== undefined && third.hex !== undefined) {
              const base = hexToUtf16(third.hex)
              const prefix = base.slice(0, Math.max(0, base.length - 1))
              const last = base.length > 0 ? base.charCodeAt(base.length - 1) : 0
              for (let code = low; code <= high && code - low < 65536; code++) map[code] = prefix + String.fromCharCode(last + (code - low))
              k += 3
              continue
            }
            k++
          }
        }
        from = end + 10
      }
      return map
    }
    function scanDictRefs(dict) {
      const entries = []
      let i = 0
      while (i < dict.length) {
        if (dict[i] !== '/') { i++; continue }
        let j = i + 1
        while (j < dict.length && dict.charCodeAt(j) > 32 && dict[j] !== '/' && dict[j] !== '<' && dict[j] !== '>') j++
        const ref = refAfter(dict, j)
        if (ref !== null) entries.push({ name: dict.slice(i, j), ref: ref })
        i = j
      }
      return entries
    }
    function scanRefs(text) {
      const refs = []
      let i = 0
      while (i < text.length) {
        const code = text.charCodeAt(i)
        if (code >= 48 && code <= 57) {
          const ref = refAfter(text, i)
          if (ref !== null) { refs.push(ref); i += ref.length; continue }
        }
        i++
      }
      return refs
    }
    function pageParts(objects, dict) {
      let resources = ''
      const rAt = dict.indexOf('/Resources')
      if (rAt >= 0) {
        const ref = refAfter(dict, rAt + 10)
        if (ref !== null && objects[ref] !== undefined) resources = dictPart(objects[ref])
        else { const open = dict.indexOf('<<', rAt); if (open >= 0) resources = sliceDict(dict, open) }
      }
      const cAt = dict.indexOf('/Contents')
      if (cAt < 0) return { resources: resources, refs: [] }
      const direct = refAfter(dict, cAt + 9)
      return { resources: resources, refs: direct !== null ? [direct] : scanRefs(dict.slice(cAt, cAt + 400)) }
    }
    function buildFonts(objects, resources) {
      const fonts = {}
      const fontAt = resources.indexOf('/Font')
      if (fontAt < 0) return fonts
      const open = resources.indexOf('<<', fontAt)
      if (open < 0) return fonts
      const entries = scanDictRefs(sliceDict(resources, open))
      for (let i = 0; i < entries.length; i++) {
        const body = objects[entries[i].ref]
        if (body === undefined) continue
        const info = dictPart(body)
        const twoByte = info.indexOf('Type0') >= 0 || info.indexOf('Identity') >= 0
        let cmap = null
        const at = info.indexOf('/ToUnicode')
        if (at >= 0) {
          const ref = refAfter(info, at + 10)
          if (ref !== null) { const cmapText = objectStreamText(objects, ref); if (cmapText !== null) cmap = parseCmap(cmapText) }
        }
        fonts[entries[i].name] = { cmap: cmap, twoByte: twoByte }
      }
      return fonts
    }
    function pdfTokens(content) {
      const tokens = []
      let i = 0
      while (i < content.length) {
        const code = content.charCodeAt(i)
        const ch = content[i]
        if (code <= 32) { i++; continue }
        if (ch === '(') {
          let depth = 1
          let text = ''
          let j = i + 1
          while (j < content.length && depth > 0) {
            const token = content[j]
            if (token === SEP) {
              const next = content[j + 1]
              j += 2
              if (next === 'n') text += NL
              else if (next === 'r') text += String.fromCharCode(13)
              else if (next === 't') text += String.fromCharCode(9)
              else if (next === 'b' || next === 'f') text += ' '
              else if (next >= '0' && next <= '7') {
                let octal = next
                let taken = 0
                while (taken < 2 && content[j] >= '0' && content[j] <= '7') { octal += content[j]; j++; taken++ }
                text += String.fromCharCode(parseInt(octal, 8))
              } else text += next
              continue
            }
            if (token === '(') depth++
            if (token === ')') { depth--; if (depth === 0) { j++; break } }
            text += token
            j++
          }
          tokens.push({ kind: 'str', value: text })
          i = j
          continue
        }
        if (ch === '<' && content[i + 1] !== '<') {
          const close = content.indexOf('>', i)
          if (close < 0) break
          const hex = content.slice(i + 1, close)
          let text = ''
          for (let k = 0; k + 1 < hex.length; k += 2) text += String.fromCharCode(parseInt(hex.slice(k, k + 2), 16) || 0)
          tokens.push({ kind: 'str', value: text })
          i = close + 1
          continue
        }
        if (ch === '[') { tokens.push({ kind: 'open' }); i++; continue }
        if (ch === ']') { tokens.push({ kind: 'close' }); i++; continue }
        if (ch === '/') {
          let j = i + 1
          while (j < content.length && content.charCodeAt(j) > 32 && content[j] !== '/' && content[j] !== '[' && content[j] !== '(' && content[j] !== '<') j++
          tokens.push({ kind: 'name', value: content.slice(i, j) })
          i = j
          continue
        }
        if (code === 60 && content[i + 1] === 60) { i += 2; continue }
        if (code === 62 && content[i + 1] === 62) { i += 2; continue }
        if ((code >= 48 && code <= 57) || ch === '-' || ch === '+' || ch === '.') {
          let j = i
          while (j < content.length && (content.charCodeAt(j) === 45 || content.charCodeAt(j) === 43 || content.charCodeAt(j) === 46 || (content.charCodeAt(j) >= 48 && content.charCodeAt(j) <= 57))) j++
          const parsed = Number(content.slice(i, j))
          tokens.push({ kind: 'num', value: isNaN(parsed) ? 0 : parsed })
          i = j
          continue
        }
        let j = i
        while (j < content.length) {
          const c = content[j]
          if (c === "'" || c === String.fromCharCode(34) || c === '*' || (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z')) j++
          else break
        }
        if (j > i) { tokens.push({ kind: 'op', value: content.slice(i, j) }); i = j; continue }
        i++
      }
      return tokens
    }
    function pdfTextOf(content, fonts) {
      const tokens = pdfTokens(content)
      const lines = []
      let line = ''
      let operands = []
      let current = null
      let fontSize = 1
      let textX = 0
      let textY = 0
      let lineY = null
      let shown = false
      let lastX = 0
      function flush() { const value = line.trim(); if (value) lines.push(value); line = ''; shown = false }
      function decode(bytesText) {
        if (current === null || current.cmap === null) return bytesText
        let out = ''
        if (current.twoByte) {
          for (let k = 0; k + 1 < bytesText.length; k += 2) {
            const mapped = current.cmap[(bytesText.charCodeAt(k) << 8) | bytesText.charCodeAt(k + 1)]
            if (mapped !== undefined) out += mapped
          }
        } else {
          for (let k = 0; k < bytesText.length; k++) {
            const mapped = current.cmap[bytesText.charCodeAt(k)]
            out += mapped === undefined ? bytesText[k] : mapped
          }
        }
        return out
      }
      function show(text) {
        if (text === '') return
        if (shown) {
          const gap = textX - lastX
          const cjk = isCjk(text[0]) || (line.length > 0 && isCjk(line[line.length - 1]))
          if (gap > fontSize * 1.6 && !cjk && line !== '' && !line.endsWith(' ')) line += ' '
        }
        line += text
        shown = true
        lastX = textX
      }
      let k = 0
      while (k < tokens.length) {
        const token = tokens[k]
        if (token.kind === 'open') {
          const items = []
          let depth = 1
          k++
          while (k < tokens.length && depth > 0) {
            const inner = tokens[k]
            if (inner.kind === 'open') depth++
            else if (inner.kind === 'close') { depth--; if (depth === 0) break }
            else if (depth === 1) items.push(inner)
            k++
          }
          operands.push({ kind: 'array', items: items })
          k++
          continue
        }
        if (token.kind !== 'op') { operands.push(token); k++; continue }
        const op = token.value
        if (op === 'Tf') {
          const name = operands.length >= 2 ? operands[operands.length - 2] : null
          const size = operands.length >= 1 ? operands[operands.length - 1] : null
          current = name !== null && name.kind === 'name' && fonts[name.value] !== undefined ? fonts[name.value] : null
          if (size !== null && size.kind === 'num' && size.value > 0) fontSize = size.value
        } else if (op === 'Tm') {
          if (operands.length >= 6) { textX = operands[4].value; textY = operands[5].value }
          if (lineY !== null && Math.abs(textY - lineY) > fontSize * 0.4) flush()
          lineY = textY
        } else if (op === 'Td' || op === 'TD') {
          if (operands.length >= 2) { textX += operands[operands.length - 2].value; textY += operands[operands.length - 1].value }
          if (lineY !== null && Math.abs(textY - lineY) > fontSize * 0.4) flush()
          lineY = textY
        } else if (op === 'T*') {
          flush()
        } else if (op === 'Tj' || op === "'" || op === String.fromCharCode(34)) {
          const last = operands[operands.length - 1]
          if (last !== undefined && last.kind === 'str') show(decode(last.value))
          if (op !== 'Tj') flush()
        } else if (op === 'TJ') {
          const arr = operands[operands.length - 1]
          if (arr !== undefined && arr.kind === 'array') {
            for (let a = 0; a < arr.items.length; a++) {
              const item = arr.items[a]
              if (item.kind === 'str') show(decode(item.value))
              else if (item.kind === 'num' && item.value < -180 && line !== '' && !line.endsWith(' ')) line += ' '
            }
          }
        } else if (op === 'ET') {
          flush()
        }
        operands = []
        k++
      }
      flush()
      return lines.join(NL)
    }
    function extractPdfText(bytes) {
      const objects = parseObjects(latin1(bytes))
      const out = []
      for (const num in objects) {
        const dict = dictPart(objects[num])
        if (dict.indexOf('/Page') < 0 || dict.indexOf('/Pages') >= 0) continue
        const parts = pageParts(objects, dict)
        const fonts = buildFonts(objects, parts.resources)
        for (let i = 0; i < parts.refs.length; i++) {
          const content = objectStreamText(objects, parts.refs[i])
          if (content !== null) out.push(pdfTextOf(content, fonts))
        }
      }
      return out.join(NL)
    }

    function extractText(name, bytes) {
      const ext = extensionOf(name)
      if (TEXT_EXT.indexOf(ext) >= 0) {
        let text = decodeUtf8(bytes)
        if (ext === 'html' || ext === 'htm' || ext === 'xml') text = stripMarkup(text)
        return { kind: 'text', text: text, note: '' }
      }
      if (ext === 'docx') {
        try { return { kind: 'docx', text: extractDocxText(bytes), note: '' } }
        catch (error) { return { kind: 'docx', text: '', note: 'Word 解析失败: ' + messageOf(error) } }
      }
      if (ext === 'pdf') {
        try {
          const text = extractPdfText(bytes)
          return { kind: 'pdf', text: text, note: text.length > 0 ? '' : '未能从 PDF 提取文字（可能是扫描件或纯图片 PDF）' }
        } catch (error) { return { kind: 'pdf', text: '', note: 'PDF 解析失败: ' + messageOf(error) } }
      }
      if (IMAGE_EXT.indexOf(ext) >= 0) return { kind: 'image', text: name, note: '图片按文件名索引，未做文字识别' }
      return { kind: 'binary', text: '', note: '暂不支持从 ' + (ext || '未知') + ' 文件提取文字' }
    }

    function joinCjkLines(text) {
      let out = ''
      for (let i = 0; i < text.length; i++) {
        if (text[i] !== NL) { out += text[i]; continue }
        let j = i
        while (j < text.length && text[j] === NL) j++
        const before = out.length > 0 ? out[out.length - 1] : ''
        const after = j < text.length ? text[j] : ''
        if (j - i > 1) out += NL + NL
        else if (isCjk(before) || isCjk(after)) out += ''
        else out += ' '
        i = j - 1
      }
      return out
    }
    function normalizeText(text) {
      let value = text.split(String.fromCharCode(13) + NL).join(NL).split(String.fromCharCode(13)).join(NL)
      value = joinCjkLines(value)
      for (let i = 0; i < 3; i++) value = value.split(NL + NL + NL).join(NL + NL)
      return value.trim()
    }
    function chunkText(text) {
      const clean = normalizeText(text)
      if (!clean) return []
      const out = []
      let start = 0
      while (start < clean.length) {
        let end = Math.min(clean.length, start + CHUNK_SIZE)
        if (end < clean.length) {
          const from = start + Math.floor(CHUNK_SIZE * 0.6)
          const window = clean.slice(from, end)
          const marks = [NL + NL, '。', '！', '？', '. ', NL]
          let best = -1
          for (let i = 0; i < marks.length; i++) { const found = window.lastIndexOf(marks[i]); if (found > best) best = found }
          if (best > 0) end = from + best + 1
        }
        const piece = clean.slice(start, end).trim()
        if (piece) out.push(piece)
        if (end >= clean.length) break
        start = Math.max(end - CHUNK_OVERLAP, start + 1)
      }
      return out
    }
    function tokenize(text) {
      const tokens = []
      const lower = text.toLowerCase()
      let word = ''
      for (let i = 0; i < lower.length; i++) {
        const code = lower.charCodeAt(i)
        if ((code >= 97 && code <= 122) || (code >= 48 && code <= 57)) { word += lower[i]; continue }
        if (word) { tokens.push(word); word = '' }
        if (code > 127) {
          tokens.push(lower[i])
          if (lower.charCodeAt(i + 1) > 127) tokens.push(lower[i] + lower[i + 1])
        }
      }
      if (word) tokens.push(word)
      return tokens
    }
    function hashToken(token) {
      let hash = 2166136261
      for (let i = 0; i < token.length; i++) { hash ^= token.charCodeAt(i); hash = Math.imul(hash, 16777619) >>> 0 }
      return hash
    }
    function tfPairs(text) {
      const counts = new Map()
      const tokens = tokenize(text)
      for (let i = 0; i < tokens.length; i++) {
        const slot = hashToken(tokens[i]) % DIM
        counts.set(slot, (counts.get(slot) || 0) + 1)
      }
      const pairs = []
      counts.forEach(function (count, slot) { pairs.push([slot, count]) })
      pairs.sort(function (a, b) { return a[0] - b[0] })
      return pairs
    }
    function weightedVector(pairs, df, total) {
      const raw = new Map()
      let norm = 0
      for (let i = 0; i < pairs.length; i++) {
        const slot = pairs[i][0]
        const seen = df[slot] || 1
        const weight = (1 + Math.log(pairs[i][1])) * (Math.log((total + 1) / (seen + 1)) + 1)
        raw.set(slot, weight)
        norm += weight * weight
      }
      norm = Math.sqrt(norm) || 1
      const out = new Map()
      raw.forEach(function (weight, slot) { out.set(slot, weight / norm) })
      return out
    }
    function rebuildDf(index) {
      const df = {}
      for (let i = 0; i < index.chunks.length; i++) {
        const pairs = index.chunks[i].tf
        for (let k = 0; k < pairs.length; k++) df[pairs[k][0]] = (df[pairs[k][0]] || 0) + 1
      }
      index.df = df
    }

    async function readText(path) { return await fs.readText(await fs.resolve(path)) }
    async function readBytes(path, max) { return await fs.readBytes(await fs.resolve(path), undefined, max) }
    async function writeText(path, text) { return await fs.writeText(await fs.resolve(path), text, undefined, undefined, policy()) }
    async function ensureDir(path) {
      if (shell === undefined) throw new Error('shell 服务不可用，无法创建目录')
      const result = await shell.run(shell.resolve({ command: "New-Item -ItemType Directory -Force -Path '" + path + "' | Out-Null", timeoutMs: 20000, sandboxPolicy: policy() }))
      if (result.exitCode !== 0) throw new Error('创建目录失败: ' + String(result.stderr && result.stderr.text || '').slice(0, 200))
    }
    async function writeBytes(path, bytes) {
      if (shell === undefined) throw new Error('shell 服务不可用，无法写入文件')
      const script = "$ErrorActionPreference='Stop'; $b=[Convert]::FromBase64String([Console]::In.ReadToEnd().Trim()); [IO.File]::WriteAllBytes('" + path + "', $b); 'ok'"
      const result = await shell.run(shell.resolve({ command: script, timeoutMs: 120000, stdin: bytesToBase64(bytes), sandboxPolicy: policy() }))
      if (result.exitCode !== 0) throw new Error('写入文件失败: ' + String(result.stderr && result.stderr.text || '').slice(0, 200))
    }

    function emptyIndex() { return { version: 1, dim: DIM, chunkSize: CHUNK_SIZE, overlap: CHUNK_OVERLAP, docs: [], chunks: [], df: {} } }
    async function loadIndex() {
      try {
        const parsed = JSON.parse(await readText(indexPath()))
        if (parsed && Array.isArray(parsed.docs) && Array.isArray(parsed.chunks)) { parsed.df = parsed.df || {}; state.index = parsed; return parsed }
      } catch (error) { /* 首次运行或索引不存在：退回空索引 */ }
      state.index = emptyIndex()
      return state.index
    }
    async function ensureIndex() {
      if (state.index !== null) return state.index
      if (state.loading === null) state.loading = loadIndex()
      return await state.loading
    }
    async function saveIndex(index) {
      rebuildDf(index)
      await ensureDir(joinPath(state.root, '.kb'))
      await writeText(indexPath(), JSON.stringify(index))
      state.vectors = null
    }
    function vectorsOf(index) {
      if (state.vectors !== null && state.vectors.chunks === index.chunks.length) return state.vectors.list
      const list = []
      for (let i = 0; i < index.chunks.length; i++) list.push(weightedVector(index.chunks[i].tf, index.df, index.chunks.length))
      state.vectors = { chunks: index.chunks.length, list: list }
      return list
    }
    function searchIndex(index, query, topK) {
      const pairs = tfPairs(query)
      if (pairs.length === 0) return []
      const queryVector = weightedVector(pairs, index.df, index.chunks.length)
      const list = vectorsOf(index)
      const scored = []
      for (let i = 0; i < index.chunks.length; i++) {
        let dot = 0
        queryVector.forEach(function (weight, slot) { const other = list[i].get(slot); if (other !== undefined) dot += weight * other })
        if (dot > 0.000001) scored.push({ score: dot, doc: index.chunks[i].doc, ordinal: index.chunks[i].ord, text: index.chunks[i].text })
      }
      scored.sort(function (a, b) { return b.score - a.score })
      return scored.slice(0, topK)
    }
    function uniqueName(index, name) {
      for (let i = 0; i < index.docs.length; i++) if (index.docs[i].name === name) {
        const dot = name.lastIndexOf('.')
        return (dot < 0 ? name : name.slice(0, dot)) + '-' + Date.now() + (dot < 0 ? '' : name.slice(dot))
      }
      return name
    }
    function dropDoc(index, name) {
      index.docs = index.docs.filter(function (doc) { return doc.name !== name })
      index.chunks = index.chunks.filter(function (chunk) { return chunk.doc !== name })
    }
    async function ingestBytes(name, bytes, replace, limit) {
      const index = await ensureIndex()
      if (bytes.length === 0) throw new Error('文件为空')
      if (limit !== undefined && bytes.length > limit) throw new Error('文件超过 ' + Math.round(limit / 1048576) + 'MB 上限')
      await ensureDir(filesDir())
      const target = replace === true ? name : uniqueName(index, name)
      await writeBytes(joinPath(filesDir(), target), bytes)
      const extracted = extractText(target, bytes)
      const chunks = chunkText(extracted.text)
      dropDoc(index, target)
      const doc = { name: target, ext: extensionOf(target), kind: extracted.kind, bytes: bytes.length, chars: extracted.text.length, chunks: chunks.length, addedAt: new Date().toISOString(), note: extracted.note }
      index.docs.push(doc)
      for (let i = 0; i < chunks.length; i++) index.chunks.push({ doc: target, ord: i, text: chunks[i], tf: tfPairs(chunks[i]) })
      await saveIndex(index)
      return { name: target, kind: doc.kind, bytes: doc.bytes, chars: doc.chars, chunks: doc.chunks, note: doc.note }
    }
    function enqueue(task) {
      const run = state.chain.then(task, task)
      state.chain = run.then(function () { return undefined }, function () { return undefined })
      return run
    }

    const api = {
      state: function () { return enqueue(snapshot) },
      search: function (query, topK) {
        const value = String(query || '').trim()
        const limit = Math.max(1, Math.min(20, Number(topK) || DEFAULT_TOPK))
        return enqueue(async function () {
          const index = await ensureIndex()
          const results = value === '' ? [] : searchIndex(index, value, limit)
          return { query: value, topK: limit, results: results.map(function (item) { return { file: item.doc, ordinal: item.ordinal, score: Number(item.score.toFixed(4)), text: item.text } }) }
        })
      },
      ingest: function (name, base64, replace) {
        return enqueue(async function () {
          try { return { ok: true, result: await ingestBytes(String(name || 'upload.bin'), base64ToBytes(base64), replace === true, MAX_UPLOAD_BYTES) } }
          catch (error) { state.lastError = 'ingest: ' + messageOf(error); return { ok: false, error: messageOf(error) } }
        })
      },
      ingestPath: function (path, name) {
        return enqueue(async function () {
          try {
            const target = String(path || '')
            const bytes = await readBytes(target, MAX_LOCAL_BYTES)
            return { ok: true, result: await ingestBytes(String(name || target.split(SEP).pop()), bytes, true) }
          } catch (error) { state.lastError = 'ingest-path: ' + messageOf(error); return { ok: false, error: messageOf(error) } }
        })
      },
      remove: function (name) {
        return enqueue(async function () {
          const index = await ensureIndex()
          dropDoc(index, String(name || ''))
          await saveIndex(index)
          try {
            await ensureDir(joinPath(state.root, '.kb', 'trash'))
            await shell.run(shell.resolve({ command: "Move-Item -Force -Path '" + joinPath(filesDir(), String(name)) + "' -Destination '" + joinPath(state.root, '.kb', 'trash', String(name)) + "'", timeoutMs: 20000, sandboxPolicy: policy() }))
          } catch (error) { state.lastError = 'remove: ' + messageOf(error) }
          return { ok: true, docCount: index.docs.length }
        })
      },
      rescan: function () {
        return enqueue(async function () {
          const index = await ensureIndex()
          const entries = await fs.listDir(await fs.resolve(filesDir()))
          const known = {}
          for (let i = 0; i < index.docs.length; i++) known[index.docs[i].name] = true
          const added = []
          for (let i = 0; i < entries.length; i++) {
            if (entries[i].type !== 'file' || known[entries[i].name]) continue
            try { added.push(await ingestBytes(entries[i].name, await readBytes(joinPath(filesDir(), entries[i].name), MAX_LOCAL_BYTES), true)) }
            catch (error) { state.lastError = 'rescan ' + entries[i].name + ': ' + messageOf(error) }
          }
          return { ok: true, added: added, docCount: index.docs.length }
        })
      },
      setRoot: function (root) {
        const value = String(root || '').trim()
        if (value === '') return Promise.resolve({ ok: false, error: '存储路径不能为空' })
        return enqueue(async function () {
          try {
            await ensureDir(value)
            state.root = value
            state.index = null
            state.loading = null
            state.vectors = null
            const index = await ensureIndex()
            return { ok: true, root: value, docCount: index.docs.length }
          } catch (error) { return { ok: false, error: messageOf(error) } }
        })
      },
      openFolder: async function (path) {
        try {
          if (shell === undefined) return { ok: false, error: 'shell 服务不可用' }
          const target = String(path || state.root)
          const result = await shell.run(shell.resolve({ command: "Start-Process -FilePath explorer.exe -ArgumentList '" + target + "'", timeoutMs: 20000, sandboxPolicy: policy() }))
          if (result.exitCode !== 0) return { ok: false, error: String(result.stderr && result.stderr.text || '').slice(0, 300) }
          return { ok: true, path: target }
        } catch (error) { return { ok: false, error: messageOf(error) } }
      },
      preview: async function (path, name) {
        try {
          const target = String(path || '')
          const bytes = await readBytes(target, MAX_LOCAL_BYTES)
          const extracted = extractText(String(name || target.split(SEP).pop()), bytes)
          return { ok: true, kind: extracted.kind, chars: extracted.text.length, note: extracted.note, preview: extracted.text.slice(0, 1200) }
        } catch (error) { return { ok: false, error: messageOf(error) } }
      },
    }

    async function snapshot() {
      const index = await ensureIndex()
      let rootExists = false
      try { const info = await fs.stat(await fs.resolve(state.root)); rootExists = info !== undefined && info.type === 'directory' } catch (error) { /* 根目录不可读：如实上报 false */ }
      return {
        root: state.root,
        defaultRoot: DEFAULT_ROOT,
        rootExists: rootExists,
        filesDir: filesDir(),
        services: { fs: fs !== undefined, shell: shell !== undefined },
        docs: index.docs.map(function (doc) { return { name: doc.name, kind: doc.kind, bytes: doc.bytes, chars: doc.chars, chunks: doc.chunks, note: doc.note, addedAt: doc.addedAt } }),
        docCount: index.docs.length,
        chunkCount: index.chunks.length,
        dim: DIM,
        chunkSize: CHUNK_SIZE,
        overlap: CHUNK_OVERLAP,
        defaultTopK: DEFAULT_TOPK,
        lastError: state.lastError,
      }
    }


    return api
}
