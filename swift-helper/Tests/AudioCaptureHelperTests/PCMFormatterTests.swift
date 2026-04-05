import XCTest
@testable import AudioCaptureHelper

final class PCMFormatterTests: XCTestCase {
    private func makePipeFormatter(mode: CaptureMode) -> (PCMFormatter, Pipe) {
        let pipe = Pipe()
        let formatter = PCMFormatter(
            mode: mode,
            sampleRate: 16000,
            sink: pipe.fileHandleForWriting
        )
        return (formatter, pipe)
    }

    private func readAllAvailable(_ pipe: Pipe) -> [Int16] {
        // Close the write end so the reader sees EOF.
        try? pipe.fileHandleForWriting.close()
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        return data.withUnsafeBytes { raw -> [Int16] in
            let count = raw.count / MemoryLayout<Int16>.size
            let buffer = raw.bindMemory(to: Int16.self)
            return Array(UnsafeBufferPointer(start: buffer.baseAddress, count: count))
        }
    }

    func testMicOnlyPassThrough() {
        let (f, pipe) = makePipeFormatter(mode: .mic)
        f.append([1, 2, 3, 4, 5], channel: .mic)
        f.pumpOnce()
        f.stop()
        let samples = readAllAvailable(pipe)
        XCTAssertEqual(samples, [1, 2, 3, 4, 5])
    }

    func testSystemOnlyPassThrough() {
        let (f, pipe) = makePipeFormatter(mode: .system)
        f.append([10, 20, 30], channel: .system)
        f.pumpOnce()
        f.stop()
        let samples = readAllAvailable(pipe)
        XCTAssertEqual(samples, [10, 20, 30])
    }

    func testBothInterleavesLeftRight() {
        let (f, pipe) = makePipeFormatter(mode: .both)
        f.append([1, 2, 3], channel: .mic)
        f.append([100, 200, 300], channel: .system)
        f.pumpOnce()
        f.stop()
        let samples = readAllAvailable(pipe)
        // L=mic, R=system, interleaved per frame.
        XCTAssertEqual(samples, [1, 100, 2, 200, 3, 300])
    }

    func testBothWaitsForBothSidesBeforeEmitting() {
        let (f, pipe) = makePipeFormatter(mode: .both)
        f.append([1, 2, 3, 4, 5], channel: .mic)
        // System has no samples yet → formatter should emit nothing.
        f.pumpOnce()
        // Now provide 2 system samples; formatter emits 2 stereo frames.
        f.append([10, 20], channel: .system)
        f.pumpOnce()
        f.stop()
        let samples = readAllAvailable(pipe)
        XCTAssertEqual(samples, [1, 10, 2, 20])
    }

    func testBothFlushEmitsTrailingInterleavedFrames() {
        let (f, pipe) = makePipeFormatter(mode: .both)
        // Emit more than framesPerTick (160) worth to exercise multi-tick drain.
        let mic = (0..<200).map { Int16($0) }
        let sys = (0..<200).map { Int16($0 + 1000) }
        f.append(mic, channel: .mic)
        f.append(sys, channel: .system)
        f.stop() // flush drains everything at once
        let samples = readAllAvailable(pipe)
        XCTAssertEqual(samples.count, 400)
        XCTAssertEqual(samples[0], 0)
        XCTAssertEqual(samples[1], 1000)
        XCTAssertEqual(samples[2], 1)
        XCTAssertEqual(samples[3], 1001)
        XCTAssertEqual(samples[398], 199)
        XCTAssertEqual(samples[399], 1199)
    }

    func testDriftProtectionTrimsExcessSide() {
        let (f, pipe) = makePipeFormatter(mode: .both)
        // framesPerTick at 16kHz = 160. 2 × framesPerTick = 320.
        // Push 500 mic samples, 0 system samples → drift is 500 > 320.
        // Formatter should drop (500 - 160) = 340 mic samples, leaving 160.
        let bigMic = (0..<500).map { _ in Int16(7) }
        f.append(bigMic, channel: .mic)
        f.pumpOnce() // drift-trim path; no output emitted
        // Now provide 160 system samples → both sides have 160 → emit stereo 160.
        f.append([Int16](repeating: 8, count: 160), channel: .system)
        f.stop()
        let samples = readAllAvailable(pipe)
        XCTAssertEqual(samples.count, 320) // 160 frames * 2 channels
        XCTAssertEqual(samples[0], 7)
        XCTAssertEqual(samples[1], 8)
    }
}
