import { crc32, deflateRawSync } from "node:zlib";
export interface ZipEntry {
  name: string;
  data?: string;
  crc?: number;
  method?: number;
  flags?: number;
  attributes?: number;
  declaredSize?: number;
  compressed?: Buffer;
}
// Minimal real ZIP writer for malformed archive/security boundary tests.
export function zipBytes(entries: ZipEntry[], corruptCentral = false) {
  const locals: Buffer[] = [],
    central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name),
      data = Buffer.from(entry.data ?? "");
    const method = entry.method ?? 0,
      flags = entry.flags ?? 0;
    const packed =
      entry.compressed ?? (method === 8 ? deflateRawSync(data) : data);
    const checksum = entry.crc ?? crc32(data);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(flags, 6);
    header.writeUInt16LE(method, 8);
    header.writeUInt32LE(checksum, 14);
    header.writeUInt32LE(packed.length, 18);
    header.writeUInt32LE(entry.declaredSize ?? data.length, 22);
    header.writeUInt16LE(name.length, 26);
    locals.push(header, name, packed);
    const record = Buffer.alloc(46);
    record.writeUInt32LE(corruptCentral ? 0xdeadbeef : 0x02014b50);
    record.writeUInt16LE(0x0314, 4);
    record.writeUInt16LE(20, 6);
    record.writeUInt16LE(flags, 8);
    record.writeUInt16LE(method, 10);
    record.writeUInt32LE(checksum, 16);
    record.writeUInt32LE(packed.length, 20);
    record.writeUInt32LE(entry.declaredSize ?? data.length, 24);
    record.writeUInt16LE(name.length, 28);
    record.writeUInt32LE(entry.attributes ?? 0, 38);
    record.writeUInt32LE(offset, 42);
    central.push(record, name);
    offset += header.length + name.length + packed.length;
  }
  const directory = Buffer.concat(central),
    end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}
