import { randomUUID } from 'node:crypto';

export interface NativeCookieJob {
  name: string;
  terminate(): void;
  activeProcesses(): number;
  close(): void;
}

export async function createNativeCookieJob(): Promise<NativeCookieJob> {
  if (process.platform !== 'win32' || !['x64', 'arm64'].includes(process.arch)) {
    throw new Error('native_supervision_unavailable');
  }
  const { api, ptr, closeLibrary } = await openKernel();
  const name = `Local\\gstack-cookie-${randomUUID()}`;
  const wideName = Buffer.from(`${name}\0`, 'utf16le');
  const handle = api.CreateJobObjectW(null, ptr(wideName));
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    if (handle) api.CloseHandle(handle);
    closeLibrary();
  };
  try {
    if (!handle || api.GetLastError() === 183) throw new Error('native_supervision_failed');
    const limits = Buffer.alloc(144);
    limits.writeUInt32LE(0x2000, 16);
    if (!api.SetInformationJobObject(handle, 9, ptr(limits), limits.byteLength)) {
      throw new Error('native_supervision_failed');
    }
    return {
      name,
      terminate() {
        if (closed || !api.TerminateJobObject(handle, 1)) throw new Error('native_cleanup_failed');
      },
      activeProcesses() {
        const accounting = Buffer.alloc(48);
        if (closed || !api.QueryInformationJobObject(handle, 1, ptr(accounting), accounting.byteLength, null)) {
          throw new Error('native_cleanup_failed');
        }
        return accounting.readUInt32LE(40);
      },
      close,
    };
  } catch (error) {
    close();
    throw error;
  }
}

export async function joinNativeCookieJob(name: string): Promise<void> {
  if (process.platform !== 'win32' || !/^Local\\gstack-cookie-[0-9a-f-]{36}$/.test(name)) {
    throw new Error('native_supervision_failed');
  }
  const { api, ptr, closeLibrary } = await openKernel();
  const wideName = Buffer.from(`${name}\0`, 'utf16le');
  const handle = api.OpenJobObjectW(1, 0, ptr(wideName));
  try {
    if (!handle || !api.AssignProcessToJobObject(handle, api.GetCurrentProcess())) {
      throw new Error('native_supervision_failed');
    }
  } finally {
    if (handle) api.CloseHandle(handle);
    closeLibrary();
  }
}

async function openKernel() {
  const { dlopen, FFIType, ptr } = await import('bun:ffi');
  const library = dlopen('kernel32.dll', {
    CreateJobObjectW: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.u64 },
    OpenJobObjectW: { args: [FFIType.u32, FFIType.i32, FFIType.ptr], returns: FFIType.u64 },
    SetInformationJobObject: { args: [FFIType.u64, FFIType.u32, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
    QueryInformationJobObject: { args: [FFIType.u64, FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.ptr], returns: FFIType.i32 },
    AssignProcessToJobObject: { args: [FFIType.u64, FFIType.u64], returns: FFIType.i32 },
    GetCurrentProcess: { args: [], returns: FFIType.u64 },
    TerminateJobObject: { args: [FFIType.u64, FFIType.u32], returns: FFIType.i32 },
    CloseHandle: { args: [FFIType.u64], returns: FFIType.i32 },
    GetLastError: { args: [], returns: FFIType.u32 },
  });
  return { api: library.symbols, ptr, closeLibrary: () => library.close() };
}
