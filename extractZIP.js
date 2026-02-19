class ZIPExtractor {

  constructor (bytes) {
    this.buffer = bytes.buffer;
    this.view = new DataView(bytes.buffer);
    this.files = new Map();
    this.parseCentralDirectory();
  }

  parseCentralDirectory () {
    // Find End of Central Directory (EOCD) signature: 0x06054b50
    let eocdOffset = -1;
    for (let i = this.buffer.byteLength - 22; i >= 0; i--) {
      if (this.readUInt32(i) === 0x06054b50) {
        eocdOffset = i;
        break;
      }
    }

    if (eocdOffset === -1) throw new Error("Invalid ZIP file: EOCD not found");

    const centralDirOffset = this.readUInt32(eocdOffset + 16);
    const centralDirEntries = this.readUInt16(eocdOffset + 10);

    let offset = centralDirOffset;
    for (let i = 0; i < centralDirEntries; i++) {
      if (this.readUInt32(offset) !== 0x02014b50) {
        throw new Error("Invalid central directory signature");
      }

      const fileNameLength = this.readUInt16(offset + 28);
      const extraFieldLength = this.readUInt16(offset + 30);
      const fileCommentLength = this.readUInt16(offset + 32);
      const localHeaderOffset = this.readUInt32(offset + 42);

      const fileName = this.readString(offset + 46, fileNameLength);

      this.files.set(fileName, {
        localHeaderOffset,
        compressionMethod: this.readUInt16(offset + 10),
        compressedSize: this.readUInt32(offset + 20),
        uncompressedSize: this.readUInt32(offset + 24)
      });

      offset += 46 + fileNameLength + extraFieldLength + fileCommentLength;
    }
  }


  extractFile (path) {
    const fileInfo = this.files.get(
      path.startsWith("./") ? path.slice(2) : path
    );
    if (!fileInfo) throw new Error(`File not found: ${path}`);

    let offset = fileInfo.localHeaderOffset;
    if (this.readUInt32(offset) !== 0x04034b50) {
      throw new Error("Invalid local file header signature");
    }

    const fileNameLength = this.readUInt16(offset + 26);
    const extraFieldLength = this.readUInt16(offset + 28);
    const dataOffset = offset + 30 + fileNameLength + extraFieldLength;

    const compressedData = new Uint8Array(
      this.buffer,
      dataOffset,
      fileInfo.compressedSize
    );

    if (fileInfo.compressionMethod === 0) {
      // Stored (no compression)
      return compressedData.slice().buffer;
    } else if (fileInfo.compressionMethod === 8) {
      // DEFLATE
      return this.inflate(compressedData, fileInfo.uncompressedSize);
    } else {
      throw new Error(`Unsupported compression method: ${fileInfo.compressionMethod}`);
    }
  }

  extractBase64 (path) {
    const arrayBuffer = this.extractFile(path);
    const bytes = new Uint8Array(arrayBuffer);
    let chunks = [];
    for (let i = 0; i < bytes.length; i += 32768) {
      chunks.push(String.fromCharCode.apply(null, bytes.subarray(i, i + 32768)));
    }
    return btoa(chunks.join(""));
  }

  extractText (path) {
    const bytes = this.extractFile(path);
    return new TextDecoder().decode(bytes);
  }

  inflate (data, uncompressedSize) {
    const output = new Uint8Array(uncompressedSize);
    let outPos = 0;
    let bitBuffer = 0;
    let bitCount = 0;
    let pos = 0;

    const readBits = (n) => {
      while (bitCount < n) {
        bitBuffer |= data[pos++] << bitCount;
        bitCount += 8;
      }
      const result = bitBuffer & ((1 << n) - 1);
      bitBuffer >>= n;
      bitCount -= n;
      return result;
    };

    const fixedLitLenTree = this.buildFixedLiteralTree();
    const fixedDistTree = this.buildFixedDistanceTree();

    let finalBlock = false;
    while (!finalBlock) {
      finalBlock = readBits(1) === 1;
      const blockType = readBits(2);

      if (blockType === 0) {
        // Uncompressed block
        bitBuffer = 0;
        bitCount = 0;
        const len = data[pos] | (data[pos + 1] << 8);
        pos += 4; // Skip len and nlen
        output.set(data.subarray(pos, pos + len), outPos);
        outPos += len;
        pos += len;
      } else if (blockType === 1 || blockType === 2) {
        // Compressed with fixed or dynamic Huffman codes
        let litLenTree, distTree;

        if (blockType === 1) {
          litLenTree = fixedLitLenTree;
          distTree = fixedDistTree;
        } else {
          const trees = this.readDynamicTrees(readBits);
          litLenTree = trees.litLenTree;
          distTree = trees.distTree;
        }

        while (true) {
          const symbol = this.decodeSymbol(readBits, litLenTree);

          if (symbol < 256) {
            output[outPos++] = symbol;
          } else if (symbol === 256) {
            break; // End of block
          } else {
            const lengthCode = symbol - 257;
            const length = this.getLength(lengthCode, readBits);
            const distCode = this.decodeSymbol(readBits, distTree);
            const distance = this.getDistance(distCode, readBits);

            for (let i = 0; i < length; i++) {
              output[outPos] = output[outPos - distance];
              outPos++;
            }
          }
        }
      } else {
        throw new Error("Invalid block type");
      }
    }

    return output.buffer;
  }

  buildFixedLiteralTree () {
    const lengths = new Array(288);
    for (let i = 0; i <= 143; i++) lengths[i] = 8;
    for (let i = 144; i <= 255; i++) lengths[i] = 9;
    for (let i = 256; i <= 279; i++) lengths[i] = 7;
    for (let i = 280; i <= 287; i++) lengths[i] = 8;
    return this.buildHuffmanTree(lengths);
  }

  buildFixedDistanceTree () {
    const lengths = new Array(32).fill(5);
    return this.buildHuffmanTree(lengths);
  }

  buildHuffmanTree (lengths) {
    const maxLen = Math.max(...lengths);
    const blCount = new Array(maxLen + 1).fill(0);

    for (const len of lengths) {
      if (len > 0) blCount[len]++;
    }

    const nextCode = new Array(maxLen + 1);
    let code = 0;
    blCount[0] = 0;
    for (let bits = 1; bits <= maxLen; bits++) {
      code = (code + blCount[bits - 1]) << 1;
      nextCode[bits] = code;
    }

    const tree = {};
    for (let n = 0; n < lengths.length; n++) {
      const len = lengths[n];
      if (len !== 0) {
        const c = nextCode[len]++;
        const key = c.toString(2).padStart(len, "0");
        tree[key] = n;
      }
    }

    return tree;
  }

  readDynamicTrees (readBits) {
    const hlit = readBits(5) + 257;
    const hdist = readBits(5) + 1;
    const hclen = readBits(4) + 4;

    const codeLengthOrder = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];
    const codeLengths = new Array(19).fill(0);

    for (let i = 0; i < hclen; i++) {
      codeLengths[codeLengthOrder[i]] = readBits(3);
    }

    const codeLengthTree = this.buildHuffmanTree(codeLengths);
    const lengths = [];

    while (lengths.length < hlit + hdist) {
      const symbol = this.decodeSymbol(readBits, codeLengthTree);

      if (symbol < 16) {
        lengths.push(symbol);
      } else if (symbol === 16) {
        const repeat = readBits(2) + 3;
        const value = lengths[lengths.length - 1];
        for (let i = 0; i < repeat; i++) lengths.push(value);
      } else if (symbol === 17) {
        const repeat = readBits(3) + 3;
        for (let i = 0; i < repeat; i++) lengths.push(0);
      } else if (symbol === 18) {
        const repeat = readBits(7) + 11;
        for (let i = 0; i < repeat; i++) lengths.push(0);
      }
    }

    return {
      litLenTree: this.buildHuffmanTree(lengths.slice(0, hlit)),
      distTree: this.buildHuffmanTree(lengths.slice(hlit, hlit + hdist))
    };
  }

  decodeSymbol (readBits, tree) {
    let code = "";
    while (true) {
      code += readBits(1);
      if (tree[code] !== undefined) return tree[code];
    }
  }

  getLength (code, readBits) {
    const lengthBase = [3,4,5,6,7,8,9,10,11,13,15,17,19,23,27,31,35,43,51,59,67,83,99,115,131,163,195,227,258];
    const lengthExtra = [0,0,0,0,0,0,0,0,1,1,1,1,2,2,2,2,3,3,3,3,4,4,4,4,5,5,5,5,0];
    return lengthBase[code] + readBits(lengthExtra[code]);
  }

  getDistance (code, readBits) {
    const distBase = [1,2,3,4,5,7,9,13,17,25,33,49,65,97,129,193,257,385,513,769,1025,1537,2049,3073,4097,6145,8193,12289,16385,24577];
    const distExtra = [0,0,0,0,1,1,2,2,3,3,4,4,5,5,6,6,7,7,8,8,9,9,10,10,11,11,12,12,13,13];
    return distBase[code] + readBits(distExtra[code]);
  }

  readUInt16 (offset) {
    return this.view.getUint16(offset, true);
  }

  readUInt32 (offset) {
    return this.view.getUint32(offset, true);
  }

  readString (offset, length) {
    const bytes = new Uint8Array(this.buffer, offset, length);
    return new TextDecoder().decode(bytes);
  }

  listFiles () {
    return Array.from(this.files.keys());
  }

}

export default ZIPExtractor;
