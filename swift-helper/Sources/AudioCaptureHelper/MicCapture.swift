import Foundation
import AVFoundation
import CoreMedia

/// Wraps an `AVCaptureSession` for microphone input. Configures the audio
/// output to deliver 16-bit signed little-endian PCM at the requested
/// sample rate in mono, then forwards samples to a callback on every
/// delivered `CMSampleBuffer`.
final class MicCapture: NSObject, AVCaptureAudioDataOutputSampleBufferDelegate {
    private let sampleRate: Int
    private let deviceId: String?
    private let session = AVCaptureSession()
    private let output = AVCaptureAudioDataOutput()
    private let queue = DispatchQueue(label: "audio-mcp.mic-capture", qos: .userInteractive)
    private var onSamples: (([Int16]) -> Void)?

    init(sampleRate: Int, deviceId: String?) {
        self.sampleRate = sampleRate
        self.deviceId = deviceId
    }

    /// Start capturing. Throws on permission denial or device-open failure.
    func start(onSamples: @escaping ([Int16]) -> Void) throws {
        self.onSamples = onSamples

        let status = AVCaptureDevice.authorizationStatus(for: .audio)
        switch status {
        case .authorized:
            break
        case .notDetermined:
            // Block on the permission prompt result.
            let sem = DispatchSemaphore(value: 0)
            var granted = false
            AVCaptureDevice.requestAccess(for: .audio) { ok in
                granted = ok
                sem.signal()
            }
            sem.wait()
            if !granted {
                throw CaptureError.micPermissionDenied
            }
        case .denied, .restricted:
            throw CaptureError.micPermissionDenied
        @unknown default:
            throw CaptureError.micPermissionDenied
        }

        let device: AVCaptureDevice
        if let id = deviceId {
            guard let match = AVCaptureDevice(uniqueID: id) else {
                throw CaptureError.deviceNotFound(id)
            }
            device = match
        } else {
            guard let def = AVCaptureDevice.default(for: .audio) else {
                throw CaptureError.deviceNotFound("default")
            }
            device = def
        }

        let input = try AVCaptureDeviceInput(device: device)
        session.beginConfiguration()
        guard session.canAddInput(input) else {
            session.commitConfiguration()
            throw CaptureError.configurationFailed("cannot add mic input")
        }
        session.addInput(input)

        // Request 16-bit mono PCM at the target rate. AVCaptureAudioDataOutput
        // handles conversion for us.
        output.audioSettings = [
            AVFormatIDKey: kAudioFormatLinearPCM,
            AVSampleRateKey: sampleRate,
            AVNumberOfChannelsKey: 1,
            AVLinearPCMBitDepthKey: 16,
            AVLinearPCMIsFloatKey: false,
            AVLinearPCMIsBigEndianKey: false,
            AVLinearPCMIsNonInterleaved: false,
        ]
        output.setSampleBufferDelegate(self, queue: queue)
        guard session.canAddOutput(output) else {
            session.commitConfiguration()
            throw CaptureError.configurationFailed("cannot add mic output")
        }
        session.addOutput(output)
        session.commitConfiguration()

        session.startRunning()
        LogHelper.info("mic capture started", meta: [
            "device": device.localizedName,
            "sample_rate": "\(sampleRate)",
        ])
    }

    func stop() {
        if session.isRunning {
            session.stopRunning()
        }
        LogHelper.info("mic capture stopped")
    }

    // MARK: - AVCaptureAudioDataOutputSampleBufferDelegate

    func captureOutput(_ output: AVCaptureOutput,
                       didOutput sampleBuffer: CMSampleBuffer,
                       from connection: AVCaptureConnection) {
        guard let cb = onSamples else { return }
        guard let blockBuffer = CMSampleBufferGetDataBuffer(sampleBuffer) else { return }
        var length = 0
        var dataPtr: UnsafeMutablePointer<Int8>? = nil
        let status = CMBlockBufferGetDataPointer(
            blockBuffer,
            atOffset: 0,
            lengthAtOffsetOut: nil,
            totalLengthOut: &length,
            dataPointerOut: &dataPtr
        )
        guard status == kCMBlockBufferNoErr, let p = dataPtr else { return }
        let sampleCount = length / MemoryLayout<Int16>.size
        let samples = p.withMemoryRebound(to: Int16.self, capacity: sampleCount) { typed in
            Array(UnsafeBufferPointer(start: typed, count: sampleCount))
        }
        cb(samples)
    }
}

enum CaptureError: Error {
    case micPermissionDenied
    case screenPermissionDenied
    case deviceNotFound(String)
    case configurationFailed(String)
    case runtime(String)
}
