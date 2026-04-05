import Foundation
import AVFoundation
import ScreenCaptureKit
import CoreMedia

/// Captures system audio output via ScreenCaptureKit's SCStream.
/// Delivered samples (typically 48 kHz Float32 stereo) are converted to
/// the requested sample rate as Int16 mono via AVAudioConverter and passed
/// to the `onSamples` callback.
final class SystemAudioCapture: NSObject, SCStreamOutput, SCStreamDelegate {
    private let sampleRate: Int
    private let excludePid: pid_t?
    private var stream: SCStream?
    private let queue = DispatchQueue(label: "audio-mcp.system-capture", qos: .userInteractive)
    private var onSamples: (([Int16]) -> Void)?

    // Lazy converter, reused across buffers once we see the first buffer's format.
    private var converter: AVAudioConverter?
    private var targetFormat: AVAudioFormat?

    init(sampleRate: Int, excludePid: pid_t? = nil) {
        self.sampleRate = sampleRate
        self.excludePid = excludePid
    }

    func start(onSamples: @escaping ([Int16]) -> Void) async throws {
        self.onSamples = onSamples
        guard let format = AVAudioFormat(
            commonFormat: .pcmFormatInt16,
            sampleRate: Double(sampleRate),
            channels: 1,
            interleaved: true
        ) else {
            throw CaptureError.configurationFailed("target AVAudioFormat creation failed")
        }
        self.targetFormat = format

        // Fetch shareable content. This triggers the Screen Recording TCC
        // prompt on first run; denial surfaces as a thrown error here.
        let content: SCShareableContent
        do {
            content = try await SCShareableContent.excludingDesktopWindows(
                false,
                onScreenWindowsOnly: true
            )
        } catch {
            throw CaptureError.screenPermissionDenied
        }
        guard let display = content.displays.first else {
            throw CaptureError.configurationFailed("no displays available")
        }

        // Filter excludes the current process (and optionally parent pid) so
        // that MCP-client audio isn't captured if it happens to be playing.
        var excluded: [SCRunningApplication] = []
        let ourPid = ProcessInfo.processInfo.processIdentifier
        for app in content.applications {
            if app.processID == ourPid {
                excluded.append(app)
            } else if let parent = excludePid, app.processID == parent {
                excluded.append(app)
            }
        }
        let filter = SCContentFilter(
            display: display,
            excludingApplications: excluded,
            exceptingWindows: []
        )

        let config = SCStreamConfiguration()
        config.capturesAudio = true
        config.sampleRate = sampleRate
        config.channelCount = 1
        config.excludesCurrentProcessAudio = true
        // Minimize video cost — we only want audio.
        config.width = 2
        config.height = 2
        config.minimumFrameInterval = CMTime(value: 1, timescale: 1)

        let stream = SCStream(filter: filter, configuration: config, delegate: self)
        do {
            try stream.addStreamOutput(self, type: .audio, sampleHandlerQueue: queue)
        } catch {
            throw CaptureError.configurationFailed("addStreamOutput: \(error.localizedDescription)")
        }
        self.stream = stream

        try await stream.startCapture()
        LogHelper.info("system capture started", meta: [
            "sample_rate": "\(sampleRate)",
            "excluded_apps": "\(excluded.count)",
        ])
    }

    func stop() async {
        guard let s = stream else { return }
        do {
            try await s.stopCapture()
        } catch {
            LogHelper.warn("stopCapture error", meta: ["error": "\(error)"])
        }
        stream = nil
        LogHelper.info("system capture stopped")
    }

    // MARK: - SCStreamOutput

    func stream(_ stream: SCStream,
                didOutputSampleBuffer sampleBuffer: CMSampleBuffer,
                of type: SCStreamOutputType) {
        guard type == .audio else { return }
        guard onSamples != nil, let target = targetFormat else { return }
        guard sampleBuffer.isValid, CMSampleBufferGetNumSamples(sampleBuffer) > 0 else { return }

        // Build (or reuse) the converter for this buffer's source format.
        guard let fmtDesc = CMSampleBufferGetFormatDescription(sampleBuffer),
              let srcASBD = CMAudioFormatDescriptionGetStreamBasicDescription(fmtDesc)?.pointee else {
            return
        }
        if converter == nil {
            var asbd = srcASBD
            guard let srcFormat = AVAudioFormat(streamDescription: &asbd) else { return }
            converter = AVAudioConverter(from: srcFormat, to: target)
        }
        guard converter != nil else { return }

        // Pull the samples out of the CMSampleBuffer into an AVAudioPCMBuffer.
        var asbdCopy = srcASBD
        guard let srcFormat = AVAudioFormat(streamDescription: &asbdCopy) else { return }
        let frames = CMSampleBufferGetNumSamples(sampleBuffer)
        guard let srcBuffer = AVAudioPCMBuffer(
            pcmFormat: srcFormat,
            frameCapacity: AVAudioFrameCount(frames)
        ) else { return }
        srcBuffer.frameLength = AVAudioFrameCount(frames)

        // Copy data from CMSampleBuffer to AVAudioPCMBuffer via CMBlockBuffer.
        guard let blockBuffer = CMSampleBufferGetDataBuffer(sampleBuffer) else { return }
        var dataPtr: UnsafeMutablePointer<Int8>? = nil
        var totalLength = 0
        let status = CMBlockBufferGetDataPointer(
            blockBuffer,
            atOffset: 0,
            lengthAtOffsetOut: nil,
            totalLengthOut: &totalLength,
            dataPointerOut: &dataPtr
        )
        guard status == kCMBlockBufferNoErr, let src = dataPtr else { return }

        // For Float32 interleaved/deinterleaved sources we fill differently.
        // SCStream normally delivers Float32; we handle the interleaved case
        // (most common) and the deinterleaved case.
        let bytesPerFrame = Int(srcFormat.streamDescription.pointee.mBytesPerFrame)
        let isInterleaved = (srcFormat.streamDescription.pointee.mFormatFlags & kAudioFormatFlagIsNonInterleaved) == 0
        if isInterleaved {
            guard let dest = srcBuffer.floatChannelData?[0] else { return }
            let srcFloats = UnsafeRawPointer(src).bindMemory(to: Float.self, capacity: frames * Int(srcFormat.channelCount))
            if srcFormat.channelCount == 1 {
                memcpy(dest, srcFloats, frames * MemoryLayout<Float>.size)
            } else {
                // Downmix to mono by averaging channels.
                for i in 0..<frames {
                    var sum: Float = 0
                    for c in 0..<Int(srcFormat.channelCount) {
                        sum += srcFloats[i * Int(srcFormat.channelCount) + c]
                    }
                    dest[i] = sum / Float(srcFormat.channelCount)
                }
                // Rebuild converter as mono→target for subsequent buffers.
                if srcFormat.channelCount != 1 {
                    if let monoFormat = AVAudioFormat(
                        commonFormat: .pcmFormatFloat32,
                        sampleRate: srcFormat.sampleRate,
                        channels: 1,
                        interleaved: true
                    ) {
                        converter = AVAudioConverter(from: monoFormat, to: target)
                        // Replace srcBuffer's format view by creating a new one.
                        guard let monoBuffer = AVAudioPCMBuffer(
                            pcmFormat: monoFormat,
                            frameCapacity: AVAudioFrameCount(frames)
                        ) else { return }
                        monoBuffer.frameLength = AVAudioFrameCount(frames)
                        memcpy(monoBuffer.floatChannelData![0], dest, frames * MemoryLayout<Float>.size)
                        emit(from: monoBuffer, frames: frames, target: target)
                        return
                    }
                }
            }
        } else {
            // Non-interleaved: channels are in separate planes.
            guard let dest = srcBuffer.floatChannelData?[0] else { return }
            let planeSize = frames * MemoryLayout<Float>.size
            if srcFormat.channelCount == 1 {
                memcpy(dest, src, planeSize)
            } else {
                // Downmix non-interleaved by averaging planes.
                for i in 0..<frames {
                    var sum: Float = 0
                    for c in 0..<Int(srcFormat.channelCount) {
                        let plane = (src + c * planeSize).withMemoryRebound(
                            to: Float.self, capacity: frames) { $0 }
                        sum += plane[i]
                    }
                    dest[i] = sum / Float(srcFormat.channelCount)
                }
            }
            _ = bytesPerFrame // silence unused warning
        }

        emit(from: srcBuffer, frames: frames, target: target)
    }

    private func emit(from srcBuffer: AVAudioPCMBuffer, frames: Int, target: AVAudioFormat) {
        // Output buffer capacity sized for the target sample rate.
        let ratio = target.sampleRate / srcBuffer.format.sampleRate
        let outFrames = AVAudioFrameCount(Double(frames) * ratio + 16)
        guard let outBuffer = AVAudioPCMBuffer(
            pcmFormat: target,
            frameCapacity: outFrames
        ) else { return }
        var err: NSError? = nil
        var supplied = false
        let status = converter!.convert(to: outBuffer, error: &err) { _, flag in
            if supplied {
                flag.pointee = .noDataNow
                return nil
            }
            supplied = true
            flag.pointee = .haveData
            return srcBuffer
        }
        if status == .error || err != nil {
            LogHelper.warn("system audio convert failed", meta: ["error": "\(String(describing: err))"])
            return
        }
        let count = Int(outBuffer.frameLength)
        guard count > 0, let ptr = outBuffer.int16ChannelData?[0] else { return }
        let samples = Array(UnsafeBufferPointer(start: ptr, count: count))
        onSamples?(samples)
    }

    // MARK: - SCStreamDelegate
    func stream(_ stream: SCStream, didStopWithError error: Error) {
        LogHelper.warn("SCStream stopped with error", meta: ["error": "\(error)"])
    }
}
