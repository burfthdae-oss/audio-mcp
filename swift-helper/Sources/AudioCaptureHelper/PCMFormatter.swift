import Foundation

/// Combines Int16 mono PCM streams from mic and/or system sources into
/// interleaved stereo (or pass-through mono) output, written to a sink
/// `FileHandle` on a fixed 10 ms cadence.
///
/// - Samples are produced on arbitrary capture threads and appended via
///   `append(_:channel:)`. A dispatch source timer drains both buffers
///   frame-aligned on the formatter's private queue.
/// - For `mode=both`, both channels must have samples for a frame to be
///   emitted. Missing samples on one side are filled with silence so
///   the L/R channels stay time-aligned.
/// - For `mode=mic` or `mode=system`, the formatter emits mono PCM from
///   the single active source.
final class PCMFormatter {
    enum Channel {
        case mic
        case system
    }

    private let mode: CaptureMode
    private let sampleRate: Int
    private let sink: FileHandle
    private let lock = NSLock()
    private var micBuffer: [Int16] = []
    private var systemBuffer: [Int16] = []
    private var timer: DispatchSourceTimer?
    private let framesPerTick: Int
    private let tickIntervalMs: Int = 10

    init(mode: CaptureMode, sampleRate: Int, sink: FileHandle) {
        self.mode = mode
        self.sampleRate = sampleRate
        self.sink = sink
        self.framesPerTick = max(1, sampleRate * tickIntervalMs / 1000)
    }

    func start() {
        let queue = DispatchQueue(label: "audio-mcp.pcm-formatter", qos: .userInteractive)
        let t = DispatchSource.makeTimerSource(queue: queue)
        t.schedule(deadline: .now() + .milliseconds(tickIntervalMs),
                   repeating: .milliseconds(tickIntervalMs))
        t.setEventHandler { [weak self] in
            self?.pump()
        }
        t.resume()
        self.timer = t
    }

    func stop() {
        timer?.cancel()
        timer = nil
        // One final drain so trailing samples don't get lost.
        pump(flush: true)
    }

    func append(_ samples: [Int16], channel: Channel) {
        lock.lock()
        switch channel {
        case .mic:
            micBuffer.append(contentsOf: samples)
        case .system:
            systemBuffer.append(contentsOf: samples)
        }
        lock.unlock()
    }

    /// For tests: synchronously pump without timer.
    func pumpOnce() {
        pump()
    }

    private func pump(flush: Bool = false) {
        lock.lock()
        let micCount = micBuffer.count
        let sysCount = systemBuffer.count

        var frames: Int
        switch mode {
        case .mic:
            frames = flush ? micCount : min(micCount, framesPerTick)
            if frames == 0 { lock.unlock(); return }
            let out = Array(micBuffer[0..<frames])
            micBuffer.removeFirst(frames)
            lock.unlock()
            writePCM(out)
        case .system:
            frames = flush ? sysCount : min(sysCount, framesPerTick)
            if frames == 0 { lock.unlock(); return }
            let out = Array(systemBuffer[0..<frames])
            systemBuffer.removeFirst(frames)
            lock.unlock()
            writePCM(out)
        case .both:
            // Interleave the lesser of (mic, system, tick-size). On flush,
            // drain whatever we can fully interleave (min of the two).
            let available = min(micCount, sysCount)
            frames = flush ? available : min(available, framesPerTick)
            if frames == 0 {
                // Drift protection: if one side has ≥ 2 × framesPerTick more
                // samples than the other, drop the excess to avoid unbounded
                // latency growth.
                let drift = abs(micCount - sysCount)
                if drift > 2 * framesPerTick {
                    if micCount > sysCount {
                        micBuffer.removeFirst(drift - framesPerTick)
                    } else {
                        systemBuffer.removeFirst(drift - framesPerTick)
                    }
                }
                lock.unlock()
                return
            }
            let micSlice = Array(micBuffer[0..<frames])
            let sysSlice = Array(systemBuffer[0..<frames])
            micBuffer.removeFirst(frames)
            systemBuffer.removeFirst(frames)
            lock.unlock()
            var interleaved = [Int16]()
            interleaved.reserveCapacity(frames * 2)
            for i in 0..<frames {
                interleaved.append(micSlice[i])
                interleaved.append(sysSlice[i])
            }
            writePCM(interleaved)
        }
    }

    private func writePCM(_ samples: [Int16]) {
        samples.withUnsafeBufferPointer { ptr in
            guard let base = ptr.baseAddress else { return }
            let data = Data(bytes: base, count: ptr.count * MemoryLayout<Int16>.size)
            sink.write(data)
        }
    }
}
