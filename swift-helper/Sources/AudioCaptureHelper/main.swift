import Foundation

let VERSION = "0.1.0"

enum ExitCode: Int32 {
    case ok = 0
    case usage = 1
    case micPermissionDenied = 2
    case screenPermissionDenied = 3
    case runtimeError = 4
}

struct Args {
    var mode: CaptureMode = .both
    var sampleRate: Int = 16000
    var micDeviceId: String? = nil
    var excludePid: Int32? = nil
}

enum CaptureMode: String {
    case mic, system, both
}

func printUsageAndExit(_ code: ExitCode = .usage) -> Never {
    let usage = """
    audio-capture-helper \(VERSION)

    Usage:
      audio-capture-helper capture --mode=<mic|system|both> [--sample-rate=N] [--mic-device-id=UID] [--exclude-pid=N]
      audio-capture-helper list-devices
      audio-capture-helper probe [--mode=<mic|system|both>]
      audio-capture-helper --version

    Output (capture):
      Signed 16-bit little-endian PCM, interleaved, written to stdout.
      mode=both  → 2 channels (L=mic, R=system)
      mode=mic   → 1 channel
      mode=system→ 1 channel
    """
    FileHandle.standardError.write(Data((usage + "\n").utf8))
    exit(code.rawValue)
}

func parseCaptureArgs(_ argv: [String]) -> Args {
    var args = Args()
    for raw in argv {
        guard raw.hasPrefix("--") else { continue }
        let kv = raw.dropFirst(2).split(separator: "=", maxSplits: 1).map(String.init)
        let key = kv[0]
        let value = kv.count > 1 ? kv[1] : ""
        switch key {
        case "mode":
            guard let m = CaptureMode(rawValue: value) else {
                LogHelper.error("invalid --mode: \(value)")
                printUsageAndExit()
            }
            args.mode = m
        case "sample-rate":
            guard let rate = Int(value), rate > 0 else {
                LogHelper.error("invalid --sample-rate: \(value)")
                printUsageAndExit()
            }
            args.sampleRate = rate
        case "mic-device-id":
            args.micDeviceId = value
        case "exclude-pid":
            args.excludePid = Int32(value)
        default:
            LogHelper.error("unknown flag: --\(key)")
            printUsageAndExit()
        }
    }
    return args
}

// Top-level command dispatch.
let argv = CommandLine.arguments
if argv.count < 2 {
    printUsageAndExit()
}

let subcommand = argv[1]
let rest = Array(argv.dropFirst(2))

switch subcommand {
case "--version", "-v":
    print(VERSION)
    exit(ExitCode.ok.rawValue)

case "list-devices":
    DeviceEnumerator.printInputDevices()
    exit(ExitCode.ok.rawValue)

case "probe":
    let args = parseCaptureArgs(rest)
    ProbeCommand.run(mode: args.mode)
    // ProbeCommand calls exit() with the appropriate code.

case "capture":
    let args = parseCaptureArgs(rest)
    LogHelper.info("starting capture", meta: [
        "mode": args.mode.rawValue,
        "sample_rate": "\(args.sampleRate)",
    ])
    CaptureController.run(args: args)
    // CaptureController blocks until SIGTERM/SIGINT.

case "--help", "-h":
    printUsageAndExit(.ok)

default:
    LogHelper.error("unknown subcommand: \(subcommand)")
    printUsageAndExit()
}
