import { inflateRawSync } from 'node:zlib';
const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50;
const ZIP64_SIZE_SENTINEL = 0xffffffff;
const findEndOfCentralDirectoryOffset = (buffer) => {
    const minOffset = Math.max(0, buffer.length - 22 - 0xffff);
    for (let offset = buffer.length - 22; offset >= minOffset; offset -= 1) {
        if (buffer.readUInt32LE(offset) === EOCD_SIGNATURE)
            return offset;
    }
    throw new Error('ZIP invalido: diretorio central nao encontrado.');
};
const inflateZipEntry = (compressed, method) => {
    if (method === 0)
        return Buffer.from(compressed);
    if (method === 8)
        return inflateRawSync(compressed);
    throw new Error(`ZIP usa compressao nao suportada: ${method}.`);
};
export const readZipEntries = (buffer) => {
    const eocdOffset = findEndOfCentralDirectoryOffset(buffer);
    const totalEntries = buffer.readUInt16LE(eocdOffset + 10);
    const centralDirectoryOffset = buffer.readUInt32LE(eocdOffset + 16);
    if (centralDirectoryOffset === ZIP64_SIZE_SENTINEL) {
        throw new Error('ZIP64 ainda nao e suportado para leitura de Takeout.');
    }
    const entries = [];
    let centralOffset = centralDirectoryOffset;
    for (let index = 0; index < totalEntries; index += 1) {
        if (buffer.readUInt32LE(centralOffset) !== CENTRAL_DIRECTORY_SIGNATURE) {
            throw new Error('ZIP invalido: entrada do diretorio central corrompida.');
        }
        const method = buffer.readUInt16LE(centralOffset + 10);
        if (method !== 0 && method !== 8) {
            throw new Error(`ZIP usa compressao nao suportada: ${method}.`);
        }
        const compressedSize = buffer.readUInt32LE(centralOffset + 20);
        const uncompressedSize = buffer.readUInt32LE(centralOffset + 24);
        const fileNameLength = buffer.readUInt16LE(centralOffset + 28);
        const extraLength = buffer.readUInt16LE(centralOffset + 30);
        const commentLength = buffer.readUInt16LE(centralOffset + 32);
        const localHeaderOffset = buffer.readUInt32LE(centralOffset + 42);
        if (compressedSize === ZIP64_SIZE_SENTINEL ||
            uncompressedSize === ZIP64_SIZE_SENTINEL ||
            localHeaderOffset === ZIP64_SIZE_SENTINEL) {
            throw new Error('ZIP64 ainda nao e suportado para leitura de Takeout.');
        }
        const name = buffer
            .subarray(centralOffset + 46, centralOffset + 46 + fileNameLength)
            .toString('utf-8');
        if (buffer.readUInt32LE(localHeaderOffset) !== LOCAL_FILE_HEADER_SIGNATURE) {
            throw new Error(`ZIP invalido: cabecalho local ausente para ${name}.`);
        }
        const localNameLength = buffer.readUInt16LE(localHeaderOffset + 26);
        const localExtraLength = buffer.readUInt16LE(localHeaderOffset + 28);
        const dataOffset = localHeaderOffset + 30 + localNameLength + localExtraLength;
        const compressed = buffer.subarray(dataOffset, dataOffset + compressedSize);
        const data = inflateZipEntry(compressed, method);
        if (data.length !== uncompressedSize) {
            throw new Error(`ZIP invalido: tamanho descomprimido inesperado para ${name}.`);
        }
        entries.push({
            name,
            compressionMethod: method,
            compressedSize,
            uncompressedSize,
            data,
        });
        centralOffset += 46 + fileNameLength + extraLength + commentLength;
    }
    return entries;
};
