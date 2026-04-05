import Foundation

/// Mutable container so signal-handler closures can refer to the live
/// capture objects without tripping Swift 6's Sendable var-capture rules.
final class CaptureState: @unchecked Sendable {
    var mic: MicCapture?
    var system: SystemAudioCapture?
}

/// Orchestrates mic + system captures and writes interleaved PCM to stdout.
/// Blocks the calling thread until SIGTERM/SIGINT, then cleanly shuts down
/// the underlying captures and flushes any remaining samples.
enum CaptureController {
    static func run(args: Args) {
        let formatter = PCMFormatter(
            mode: args.mode,
            sampleRate: args.sampleRate,
            sink: FileHandle.standardOutput
        )

        let state = CaptureState()

        // Start mic (if requested) — synchronous.
        if args.mode == .mic || args.mode == .both {
            let m = MicCapture(sampleRate: args.sampleRate, deviceId: args.micDeviceId)
            do {
                try m.start(onSamples: { samples in
                    formatter.append(samples, channel: .mic)
                })
            } catch CaptureError.micPermissionDenied {
                LogHelper.error("microphone permission denied", meta: [
                    "remediation": "System Settings → Privacy & Security → Microphone → enable your MCP client",
                ])
                exit(ExitCode.micPermissionDenied.rawValue)
            } catch {
                LogHelper.error("mic capture start failed", meta: ["error": "\(error)"])
                exit(ExitCode.runtimeError.rawValue)
            }
            state.mic = m
        }

        // Start system audio (if requested) — async SCStream API.
        if args.mode == .system || args.mode == .both {
            let s = SystemAudioCapture(
                sampleRate: args.sampleRate,
                excludePid: args.excludePid
            )
            let sem = DispatchSemaphore(value: 0)
            var startError: Error? = nil
            Task {
                do {
                    try await s.start(onSamples: { samples in
                        formatter.append(samples, channel: .system)
                    })
                } catch {
                    startError = error
                }
                sem.signal()
            }
            sem.wait()
            if let err = startError {
                if case CaptureError.screenPermissionDenied = err {
                    LogHelper.error("screen recording permission denied", meta: [
                        "remediation": "System Settings → Privacy & Security → Screen Recording → enable your MCP client, then restart the client",
                    ])
                    exit(ExitCode.screenPermissionDenied.rawValue)
                }
                LogHelper.error("system audio start failed", meta: ["error": "\(err)"])
                exit(ExitCode.runtimeError.rawValue)
            }
            state.system = s
        }

        formatter.start()

        // Install signal handlers so SIGTERM/SIGINT drives a graceful shutdown.
        let stopQueue = DispatchQueue(label: "audio-mcp.signal")
        let termSrc = DispatchSource.makeSignalSource(signal: SIGTERM, queue: stopQueue)
        let intSrc  = DispatchSource.makeSignalSource(signal: SIGINT, queue: stopQueue)
        signal(SIGTERM, SIG_IGN)
        signal(SIGINT, SIG_IGN)

        let done = DispatchSemaphore(value: 0)
        let shutdown: @Sendable () -> Void = { [state] in
            LogHelper.info("shutdown signal received")
            state.mic?.stop()
            if let s = state.system {
                let stopSem = DispatchSemaphore(value: 0)
                Task {
                    await s.stop()
                    stopSem.signal()
                }
                stopSem.wait()
            }
            formatter.stop()
            done.signal()
        }
        termSrc.setEventHandler(handler: shutdown)
        intSrc.setEventHandler(handler: shutdown)
        termSrc.resume()
        intSrc.resume()

        done.wait()
        exit(ExitCode.ok.rawValue)
    }
}
