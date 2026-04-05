import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { DeviceSummary } from "./capture.js";
import { HELPER_BIN, verifyHelper } from "./helper-path.js";
import { AudioMcpError } from "../errors.js";

const execFileP = promisify(execFile);

interface HelperDeviceInfo {
  id: string;
  name: string;
  is_default: boolean;
  channels: number;
  sample_rates: number[];
}

interface HelperListDevicesOutput {
  input_devices: HelperDeviceInfo[];
}

/**
 * Enumerate input devices by invoking `audio-capture-helper list-devices`
 * and parsing its JSON stdout. System audio is represented implicitly via
 * the capture mode — it is not listed as a device.
 */
export async function listInputDevices(): Promise<DeviceSummary[]> {
  const bad = verifyHelper();
  if (bad) {
    throw new AudioMcpError("AUDIO_DEVICE_ERROR", bad.message);
  }
  let stdout: string;
  try {
    const result = await execFileP(HELPER_BIN, ["list-devices"], {
      timeout: 5000,
      maxBuffer: 1 * 1024 * 1024,
    });
    stdout = result.stdout;
  } catch (err) {
    throw new AudioMcpError(
      "AUDIO_DEVICE_ERROR",
      `list-devices failed: ${(err as Error).message}`,
    );
  }
  let parsed: HelperListDevicesOutput;
  try {
    parsed = JSON.parse(stdout) as HelperListDevicesOutput;
  } catch (err) {
    throw new AudioMcpError(
      "AUDIO_DEVICE_ERROR",
      `list-devices output not JSON: ${(err as Error).message}`,
    );
  }
  return parsed.input_devices.map((d) => ({
    id: d.id,
    name: d.name,
    is_default: d.is_default,
    channels: d.channels,
    sample_rates: d.sample_rates,
  }));
}

/**
 * Resolve a user-supplied `source` (either a uniqueID or a case-insensitive
 * substring of the device name) to a concrete device. Returns `undefined`
 * as `deviceId` to mean "system default".
 */
export async function resolveMicDevice(source?: string | null): Promise<{
  deviceId: string | undefined;
  deviceName: string;
}> {
  if (!source) {
    const devices = await listInputDevices();
    const def = devices.find((d) => d.is_default);
    return { deviceId: undefined, deviceName: def?.name ?? "system default" };
  }
  const devices = await listInputDevices();
  // Exact uniqueID match first.
  const exact = devices.find((d) => d.id === source);
  if (exact) return { deviceId: exact.id, deviceName: exact.name };
  const needle = source.toLowerCase();
  const sub = devices.find((d) => d.name.toLowerCase().includes(needle));
  if (!sub) {
    throw new AudioMcpError("AUDIO_DEVICE_ERROR", `No input device matching "${source}"`);
  }
  return { deviceId: sub.id, deviceName: sub.name };
}
