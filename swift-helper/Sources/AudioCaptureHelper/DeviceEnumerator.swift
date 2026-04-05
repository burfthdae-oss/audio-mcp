import Foundation
import AVFoundation

enum DeviceEnumerator {
    struct DeviceInfo {
        let id: String
        let name: String
        let isDefault: Bool
        let channels: Int
    }

    static func inputDevices() -> [DeviceInfo] {
        // Use device types compatible with macOS 13 (Ventura).
        // `.microphone` and `.external` are macOS 14+; the older
        // `.builtInMicrophone` + `.externalUnknown` cover the same ground.
        let deviceTypes: [AVCaptureDevice.DeviceType]
        if #available(macOS 14.0, *) {
            deviceTypes = [.microphone, .external]
        } else {
            deviceTypes = [.builtInMicrophone, .externalUnknown]
        }
        let discoverySession = AVCaptureDevice.DiscoverySession(
            deviceTypes: deviceTypes,
            mediaType: .audio,
            position: .unspecified
        )
        let devices = discoverySession.devices
        let defaultDevice = AVCaptureDevice.default(for: .audio)
        let defaultId = defaultDevice?.uniqueID

        return devices.map { device in
            DeviceInfo(
                id: device.uniqueID,
                name: device.localizedName,
                isDefault: device.uniqueID == defaultId,
                channels: 1  // AVCaptureDevice does not expose channel counts directly
            )
        }
    }

    static func printInputDevices() {
        let devices = inputDevices()
        let array: [[String: Any]] = devices.map { d in
            [
                "id": d.id,
                "name": d.name,
                "is_default": d.isDefault,
                "channels": d.channels,
                "sample_rates": [8000, 16000, 22050, 44100, 48000],
            ]
        }
        let output: [String: Any] = ["input_devices": array]
        guard let data = try? JSONSerialization.data(withJSONObject: output, options: [.sortedKeys]) else {
            LogHelper.error("failed to serialize device list")
            exit(ExitCode.runtimeError.rawValue)
        }
        FileHandle.standardOutput.write(data)
        FileHandle.standardOutput.write(Data("\n".utf8))
    }
}
