// CPython on Windows: errno names/numbers/messages of the Microsoft C runtime (what open(), read(), write() raise as
// `[Errno N] text`) and the Win32 error numbers/messages CPython puts in `[WinError N] text` for the OS calls that go
// through the Win32 API (os.stat, os.mkdir, os.rmdir, os.unlink, os.rename, os.listdir, subprocess.Popen, ...).
//
// Hand written (no Windows interpreter on the development hosts); tests/node/pyerr_windows.test.mjs checks every
// entry against the live CPython 3.12.10 on the hosted Windows runner (os.strerror, errno, a set of real failing
// calls compared with what Node's errors become here).

/** errno names Python exposes on Windows for the CRT values, and os.strerror() of each. */
const CRT = [
  ['EPERM', 1, 'Operation not permitted'],
  ['ENOENT', 2, 'No such file or directory'],
  ['ESRCH', 3, 'No such process'],
  ['EINTR', 4, 'Interrupted function call'],
  ['EIO', 5, 'Input/output error'],
  ['ENXIO', 6, 'No such device or address'],
  ['E2BIG', 7, 'Arg list too long'],
  ['ENOEXEC', 8, 'Exec format error'],
  ['EBADF', 9, 'Bad file descriptor'],
  ['ECHILD', 10, 'No child processes'],
  ['EAGAIN', 11, 'Resource temporarily unavailable'],
  ['ENOMEM', 12, 'Not enough space'],
  ['EACCES', 13, 'Permission denied'],
  ['EFAULT', 14, 'Bad address'],
  ['EBUSY', 16, 'Resource device'],
  ['EEXIST', 17, 'File exists'],
  ['EXDEV', 18, 'Improper link'],
  ['ENODEV', 19, 'No such device'],
  ['ENOTDIR', 20, 'Not a directory'],
  ['EISDIR', 21, 'Is a directory'],
  ['EINVAL', 22, 'Invalid argument'],
  ['ENFILE', 23, 'Too many open files in system'],
  ['EMFILE', 24, 'Too many open files'],
  ['ENOTTY', 25, 'Inappropriate I/O control operation'],
  ['EFBIG', 27, 'File too large'],
  ['ENOSPC', 28, 'No space left on device'],
  ['ESPIPE', 29, 'Invalid seek'],
  ['EROFS', 30, 'Read-only file system'],
  ['EMLINK', 31, 'Too many links'],
  ['EPIPE', 32, 'Broken pipe'],
  ['EDOM', 33, 'Numerical argument out of domain'],
  ['ERANGE', 34, 'Result too large'],
  ['EDEADLK', 36, 'Resource deadlock avoided'],
  ['ENAMETOOLONG', 38, 'Filename too long'],
  ['ENOLCK', 39, 'No locks available'],
  ['ENOSYS', 40, 'Function not implemented'],
  ['ENOTEMPTY', 41, 'Directory not empty'],
  ['EILSEQ', 42, 'Illegal byte sequence'],
];

const errno = {};
const strerror = {};
for (const [name, number, text] of CRT) {
  errno[name] = number;
  strerror[number] = text;
}

export const win32 = Object.freeze({
  errno: Object.freeze(errno),
  strerror: Object.freeze(strerror),
  signals: Object.freeze({ 2: 'SIGINT', 4: 'SIGILL', 8: 'SIGFPE', 11: 'SIGSEGV', 15: 'SIGTERM', 21: 'SIGBREAK', 22: 'SIGABRT' }),
  unknown: 'Unknown error',
});

/**
 * Win32 error number -> [FormatMessage text without the trailing dot, errno name CPython maps it to]
 * (PyErr_SetExcFromWindowsErr: winerror_to_errno).
 */
export const WINERROR = Object.freeze({
  2: ['The system cannot find the file specified', 'ENOENT'],
  3: ['The system cannot find the path specified', 'ENOENT'],
  4: ['The system cannot open the file', 'EMFILE'],
  5: ['Access is denied', 'EACCES'],
  17: ['The system cannot move the file to a different disk drive', 'EXDEV'],
  32: ['The process cannot access the file because it is being used by another process', 'EACCES'],
  87: ['The parameter is incorrect', 'EINVAL'],
  112: ['There is not enough space on the disk', 'ENOSPC'],
  145: ['The directory is not empty', 'ENOTEMPTY'],
  183: ['Cannot create a file when that file already exists', 'EEXIST'],
  206: ['The filename or extension is too long', 'ENOENT'],
  267: ['The directory name is invalid', 'ENOTDIR'],
  1921: ['The name of the file cannot be resolved by the system', 'EINVAL'],
});

/** libuv/Node error code -> the Win32 error number the failing call returned (libuv's uv_translate_sys_error inverse). */
export const WINERROR_OF_CODE = Object.freeze({
  ENOENT: 2, EPERM: 5, EACCES: 5, EBUSY: 32, EINVAL: 87, EXDEV: 17, ENOSPC: 112, ENOTEMPTY: 145, EEXIST: 183,
  ENAMETOOLONG: 206, ENOTDIR: 267, EMFILE: 4, ELOOP: 1921,
});
