// prints whether this process has a console window and whether it is visible (windows); run by the no-window tests
import { dlopen, FFIType } from "bun:ffi";

const k = dlopen("kernel32.dll", { GetConsoleWindow: { args: [], returns: FFIType.ptr } }).symbols;
const u = dlopen("user32.dll", { IsWindowVisible: { args: [FFIType.ptr], returns: FFIType.i32 } }).symbols;
const hwnd = k.GetConsoleWindow();
console.log(JSON.stringify({ console_window: hwnd ? String(hwnd) : null, visible: hwnd ? u.IsWindowVisible(hwnd) !== 0 : false }));
