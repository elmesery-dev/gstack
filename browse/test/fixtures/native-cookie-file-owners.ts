import { lstatSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { dlopen, FFIType, ptr } from 'bun:ffi';

function inspect() {
  if (process.platform !== 'win32' || !['x64', 'arm64'].includes(process.arch)) return { available: false, reason: 'not_windows' };
  const input = JSON.parse(Buffer.from(process.argv[2], 'base64').toString('utf8'));
  if (typeof input.root !== 'string' || typeof input.file !== 'string' || !Number.isSafeInteger(input.testPid)) return { available: false, reason: 'invalid_input' };
  const root = realpathSync(input.root);
  const file = realpathSync(input.file);
  const relative = path.relative(root, file);
  if (relative.startsWith('..') || path.isAbsolute(relative) || !lstatSync(file).isFile()) return { available: false, reason: 'outside_owned_fixture' };
  const restart = dlopen(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'rstrtmgr.dll'), {
    RmStartSession: { args: [FFIType.ptr, FFIType.u32, FFIType.ptr], returns: FFIType.u32 },
    RmRegisterResources: { args: [FFIType.u32, FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.ptr], returns: FFIType.u32 },
    RmGetList: { args: [FFIType.u32, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.u32 },
    RmEndSession: { args: [FFIType.u32], returns: FFIType.u32 },
  });
  const kernel = dlopen('kernel32.dll', {
    OpenProcess: { args: [FFIType.u32, FFIType.i32, FFIType.u32], returns: FFIType.u64 },
    GetProcessTimes: { args: [FFIType.u64, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    QueryFullProcessImageNameW: { args: [FFIType.u64, FFIType.u32, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    CloseHandle: { args: [FFIType.u64], returns: FFIType.i32 },
  });
  let session: number | undefined;
  try {
    const sessionBuffer = Buffer.alloc(4);
    const key = Buffer.alloc(66);
    let status = restart.symbols.RmStartSession(ptr(sessionBuffer), 0, ptr(key));
    if (status !== 0) return { available: false, reason: 'session_start', status };
    session = sessionBuffer.readUInt32LE(0);
    const wideFile = Buffer.from(file + '\0', 'utf16le');
    const names = Buffer.alloc(8);
    names.writeBigUInt64LE(BigInt(ptr(wideFile)));
    status = restart.symbols.RmRegisterResources(session, 1, ptr(names), 0, null, 0, null);
    if (status !== 0) return { available: false, reason: 'register_file', status };
    const needed = Buffer.alloc(4);
    const count = Buffer.alloc(4);
    const rebootReasons = Buffer.alloc(4);
    status = restart.symbols.RmGetList(session, ptr(needed), ptr(count), null, ptr(rebootReasons));
    if (status === 0 && needed.readUInt32LE(0) === 0) return { available: true, owners: [], rebootReasons: rebootReasons.readUInt32LE(0) };
    const entries = needed.readUInt32LE(0);
    if (status !== 234 || entries < 1 || entries > 64) return { available: false, reason: 'owner_count', status, entries };
    const information = Buffer.alloc(entries * 668);
    count.writeUInt32LE(entries);
    status = restart.symbols.RmGetList(session, ptr(needed), ptr(count), ptr(information), ptr(rebootReasons));
    const returned = count.readUInt32LE(0);
    if (status !== 0 || returned > entries) return { available: false, reason: 'owner_list', status };
    const owners = [];
    for (let index = 0; index < returned; index++) {
      const offset = index * 668;
      const pid = information.readUInt32LE(offset);
      const recordedStart = information.readBigUInt64LE(offset + 4);
      let image = 'unavailable';
      let creationMatched = false;
      const handle = kernel.symbols.OpenProcess(0x1000, 0, pid);
      if (handle) {
        try {
          const times = Buffer.alloc(32);
          const timeAddress = ptr(times);
          if (kernel.symbols.GetProcessTimes(handle, timeAddress, timeAddress + 8, timeAddress + 16, timeAddress + 24)) {
            creationMatched = times.readBigUInt64LE(0) === recordedStart;
          }
          if (creationMatched) {
            const imageBuffer = Buffer.alloc(65536);
            const imageLength = Buffer.alloc(4);
            imageLength.writeUInt32LE(32768);
            if (kernel.symbols.QueryFullProcessImageNameW(handle, 0, ptr(imageBuffer), ptr(imageLength))) {
              const chars = imageLength.readUInt32LE(0);
              const name = chars <= 32768 ? path.basename(imageBuffer.subarray(0, chars * 2).toString('utf16le')).toLowerCase() : '';
              image = ['bun.exe', 'node.exe', 'msedge.exe', 'msmpeng.exe', 'mssense.exe', 'dllhost.exe', 'explorer.exe', 'powershell.exe', 'pwsh.exe', 'svchost.exe', 'conhost.exe'].includes(name) ? name : 'other';
            }
          }
        } finally {
          kernel.symbols.CloseHandle(handle);
        }
      }
      owners.push({ pid, image, creationMatched, isTestHost: creationMatched && pid === input.testPid, applicationType: information.readUInt32LE(offset + 652) });
    }
    return { available: true, owners, rebootReasons: rebootReasons.readUInt32LE(0) };
  } finally {
    if (session !== undefined) restart.symbols.RmEndSession(session);
    kernel.close(); restart.close();
  }
}

let result: object;
try { result = inspect(); }
catch { result = { available: false, reason: 'owner_query_failed' }; }
process.stdout.write(JSON.stringify(result) + '\n', () => process.exit(0));
